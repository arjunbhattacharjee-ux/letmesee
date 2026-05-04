// /api/rentals.js — Vercel Edge function
// Tavily search → Groq/Llama extraction of real rental listings
// for the user's exact locality (suburb + city + country).

export const config = { runtime: 'edge' };

function getPortals(country = '', city = '', suburb = '') {
  const c = [country, city, suburb].join(' ').toLowerCase();
  if (c.includes('uae') || c.includes('dubai') || c.includes('abu dhabi') || c.includes('sharjah'))
    return ['bayut.com', 'propertyfinder.ae', 'dubizzle.com'];
  if (c.includes('india') || c.includes('mumbai') || c.includes('bangalore') || c.includes('delhi') || c.includes('chennai') || c.includes('hyderabad'))
    return ['magicbricks.com', '99acres.com', 'housing.com'];
  if (c.includes('uk') || c.includes('united kingdom') || c.includes('london') || c.includes('manchester') || c.includes('birmingham'))
    return ['rightmove.co.uk', 'zoopla.co.uk'];
  if (c.includes('usa') || c.includes('united states') || c.includes('new york') || c.includes('los angeles') || c.includes('chicago') || c.includes('houston') || c.includes('miami'))
    return ['zillow.com', 'apartments.com', 'trulia.com'];
  if (c.includes('australia') || c.includes('sydney') || c.includes('melbourne') || c.includes('brisbane'))
    return ['realestate.com.au', 'domain.com.au'];
  if (c.includes('singapore'))
    return ['propertyguru.com.sg', '99.co'];
  if (c.includes('saudi') || c.includes('riyadh') || c.includes('jeddah'))
    return ['aqar.fm', 'bayut.com'];
  if (c.includes('qatar') || c.includes('doha'))
    return ['propertyfinder.com.qa', 'bayut.com'];
  return ['propertyfinder.com', 'lamudi.com'];
}

async function tavilySearch(query, tavilyKey, maxResults = 7) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: tavilyKey,
      query,
      search_depth: 'basic',
      max_results: maxResults,
      include_answer: false,
      include_raw_content: false,
    }),
  });
  if (!res.ok) throw new Error('Tavily ' + res.status);
  const data = await res.json();
  return data.results || [];
}

function buildContext(results) {
  return results
    .map((r, i) => `[${i+1}] ${r.title}\nURL: ${r.url}\n${(r.content||'').slice(0,500)}`)
    .join('\n\n---\n\n');
}

function extractJSON(text) {
  if (!text) return null;
  const t = text.trim();
  if (t.startsWith('[')) { try { return JSON.parse(t); } catch(_){} }
  const m = t.match(/\[[\s\S]*\]/);
  if (m) { try { return JSON.parse(m[0]); } catch(_){} }
  return null;
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response(JSON.stringify({error:'Method not allowed'}),{status:405,headers:{'Content-Type':'application/json'}});

  const tavilyKey = process.env.TAVILY_API_KEY;
  const groqKey   = process.env.GROQ_API_KEY;
  if (!tavilyKey) return new Response(JSON.stringify({error:'TAVILY_API_KEY not configured'}),{status:500,headers:{'Content-Type':'application/json'}});
  if (!groqKey)   return new Response(JSON.stringify({error:'GROQ_API_KEY not configured'}),  {status:500,headers:{'Content-Type':'application/json'}});

  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({error:'Invalid JSON'}),{status:400,headers:{'Content-Type':'application/json'}}); }

  const { lat, lon, city = '', suburb = '', country = '' } = body;
  if (lat == null || lon == null) return new Response(JSON.stringify({error:'Missing lat/lon'}),{status:400,headers:{'Content-Type':'application/json'}});

  // Build the most specific location label possible
  // e.g. "Business Bay, Dubai, UAE" — this is what goes into search queries
  const parts = [suburb, city, country].filter(Boolean);
  const locationLabel = parts.length ? parts.join(', ') : `${lat.toFixed(3)},${lon.toFixed(3)}`;
  // Shorter label for portal search (suburb + city only)
  const shortLabel = [suburb, city].filter(Boolean).join(', ') || locationLabel;

  const portals = getPortals(country, city, suburb);

  // ── Step 1: Targeted Tavily searches ─────────────────────────────────────
  // Both queries use the full location label — suburb MUST be present to avoid drift
  let results = [];
  try {
    const [r1, r2] = await Promise.all([
      tavilySearch(`apartment for rent "${shortLabel}" price bedroom AED 2025`, tavilyKey, 7),
      tavilySearch(`"${shortLabel}" rental listing ${portals[0]}`, tavilyKey, 6),
    ]);
    const seen = new Set();
    results = [...r1, ...r2].filter(r => {
      if (!r.url || seen.has(r.url)) return false;
      seen.add(r.url); return true;
    });
  } catch(e) {
    console.error('Tavily error:', e.message);
    return new Response(JSON.stringify({listings:[]}),{status:200,headers:{'Content-Type':'application/json'}});
  }

  if (!results.length) return new Response(JSON.stringify({listings:[]}),{status:200,headers:{'Content-Type':'application/json'}});

  // ── Step 2: Llama extracts listings — strict location enforcement ─────────
  const context = buildContext(results);

  const systemPrompt = `You are a real estate data extractor. Today is ${new Date().toISOString().slice(0,10)}.
STRICT RULES — violating any of these is a failure:
- Extract ONLY rental listings that are explicitly in "${locationLabel}" or its immediate surroundings.
- If a result mentions a listing in a DIFFERENT city or country (e.g. Houston, London, New York when the target is Dubai), SKIP IT completely.
- Never invent prices, bedroom counts, or building names not present in the snippets.
- Return ONLY raw JSON — no markdown, no backticks, no commentary.`;

  const userPrompt = `Target location: ${locationLabel} (lat ${lat.toFixed(4)}, lon ${lon.toFixed(4)})

Search results:

${context}

Extract 4–6 rental listings that are ONLY in ${locationLabel}. Skip any result that is in a different city or country.

For each valid listing:
- bedrooms: integer (0 for studio), or null
- price: monthly rent as a number — if yearly given, divide by 12; round to nearest 100
- currency: infer from context ("AED" for Dubai/UAE, "USD" for USA, "GBP" for UK, "INR" for India, etc.)
- type: "apartment" | "villa" | "studio" | "townhouse" | "flat"
- area_sqft: number or null
- building: tower/building name or null
- Estimate lat/lon within 0.025 degrees of ${lat.toFixed(4)}, ${lon.toFixed(4)}
- url: listing URL from the results above, or null

Return ONLY a raw JSON array (no markdown, no backticks):
[{"name":"2BR Burj Views","bedrooms":2,"price":9500,"currency":"AED","type":"apartment","area_sqft":1200,"building":"Burj Views","summary":"Spacious 2-bedroom in Burj Views tower, Business Bay, with canal views.","lat":${lat.toFixed(4)},"lon":${lon.toFixed(4)},"url":null}]

If NO valid listings are found for ${locationLabel}, return an empty array: []`;

  let listings = null;
  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + groqKey },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1800,
        temperature: 0.1,   // near-zero — pure extraction, zero creativity
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
      }),
    });
    if (groqRes.ok) {
      const data = await groqRes.json();
      const text = data.choices?.[0]?.message?.content || '';
      listings = extractJSON(text);
      if (!listings) console.error('Llama parse failed:', text.slice(0,300));
    } else {
      console.error('Groq error:', groqRes.status, await groqRes.text());
    }
  } catch(e) { console.error('Groq fetch error:', e.message); }

  if (!listings || !Array.isArray(listings) || !listings.length) {
    return new Response(JSON.stringify({listings:[]}),{status:200,headers:{'Content-Type':'application/json'}});
  }

  const clean = listings
    .filter(l => l && l.name && l.lat && l.lon)
    .map((l,i) => ({
      id:         'rent_'+i,
      isRental:   true,
      name:       (l.name||'Rental').slice(0,40),
      bedrooms:   Number.isInteger(l.bedrooms) ? l.bedrooms : (l.bedrooms!=null ? parseInt(l.bedrooms)||null : null),
      price:      l.price ? Math.round(parseFloat(l.price)) : null,
      currency:   (l.currency||'AED').slice(0,5),
      type:       (l.type||'apartment').slice(0,20),
      area_sqft:  l.area_sqft ? Math.round(parseFloat(l.area_sqft)) : null,
      building:   l.building ? l.building.slice(0,50) : null,
      summary:    (l.summary||'').slice(0,300),
      lat:        Math.max(lat-0.025, Math.min(lat+0.025, parseFloat(l.lat))),
      lon:        Math.max(lon-0.025, Math.min(lon+0.025, parseFloat(l.lon))),
      url:        l.url && l.url.startsWith('http') ? l.url : null,
    }))
    .slice(0, 6);

  return new Response(JSON.stringify({listings: clean}), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, s-maxage=1800' },
  });
}
