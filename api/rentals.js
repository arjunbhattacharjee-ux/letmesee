// /api/rentals.js — Vercel Edge function
// Uses Tavily to search real rental listings for the user's locality,
// then Groq/Llama to extract structured listing data.
//
// Required env vars:
//   TAVILY_API_KEY
//   GROQ_API_KEY

export const config = { runtime: 'edge' };

// ─── Pick the best property portal for the country ───────────────────────────
function getPortals(country = '', city = '') {
  const c = (country + ' ' + city).toLowerCase();
  if (c.includes('uae') || c.includes('dubai') || c.includes('abu dhabi') || c.includes('sharjah'))
    return ['bayut.com', 'propertyfinder.ae', 'dubizzle.com'];
  if (c.includes('india') || c.includes('mumbai') || c.includes('bangalore') || c.includes('delhi'))
    return ['magicbricks.com', '99acres.com', 'housing.com'];
  if (c.includes('uk') || c.includes('london') || c.includes('manchester'))
    return ['rightmove.co.uk', 'zoopla.co.uk', 'onthemarket.com'];
  if (c.includes('usa') || c.includes('new york') || c.includes('los angeles') || c.includes('chicago'))
    return ['zillow.com', 'apartments.com', 'trulia.com'];
  if (c.includes('australia') || c.includes('sydney') || c.includes('melbourne'))
    return ['realestate.com.au', 'domain.com.au'];
  if (c.includes('singapore'))
    return ['propertyguru.com.sg', '99.co'];
  if (c.includes('saudi') || c.includes('riyadh') || c.includes('jeddah'))
    return ['aqar.fm', 'bayut.com'];
  // Generic fallback
  return ['zillow.com', 'propertyfinder.com', 'bayut.com'];
}

async function tavilySearch(query, tavilyKey, maxResults = 8) {
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
  if (!res.ok) throw new Error('Tavily ' + res.status + ': ' + await res.text());
  const data = await res.json();
  return data.results || [];
}

function buildContext(results) {
  return results
    .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${(r.content || '').slice(0, 500)}`)
    .join('\n\n---\n\n');
}

function extractJSON(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) { try { return JSON.parse(trimmed); } catch (_) {} }
  const match = trimmed.match(/\[[\s\S]*\]/);
  if (match) { try { return JSON.parse(match[0]); } catch (_) {} }
  return null;
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' },
    });
  }

  const tavilyKey = process.env.TAVILY_API_KEY;
  const groqKey   = process.env.GROQ_API_KEY;
  if (!tavilyKey) return new Response(JSON.stringify({ error: 'TAVILY_API_KEY not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  if (!groqKey)   return new Response(JSON.stringify({ error: 'GROQ_API_KEY not configured' }),   { status: 500, headers: { 'Content-Type': 'application/json' } });

  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }

  const { lat, lon, city, country } = body;
  if (lat == null || lon == null) {
    return new Response(JSON.stringify({ error: 'Missing lat/lon' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const locationLabel = city || `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const portals = getPortals(country, city);
  const portalHint = portals.slice(0, 2).join(' OR site:');

  // ── Step 1: Two Tavily searches in parallel ───────────────────────────────
  // One broad locality search, one portal-specific
  let results = [];
  try {
    const [r1, r2] = await Promise.all([
      tavilySearch(`apartments for rent ${locationLabel} 2024 2025 price bedroom`, tavilyKey, 7),
      tavilySearch(`rent flat ${locationLabel} site:${portals[0]}`, tavilyKey, 6),
    ]);
    // Deduplicate by URL
    const seen = new Set();
    results = [...r1, ...r2].filter(r => {
      if (!r.url || seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });
  } catch (e) {
    console.error('Tavily error:', e.message);
    return new Response(JSON.stringify({ listings: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  if (results.length === 0) {
    return new Response(JSON.stringify({ listings: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Step 2: Llama extracts structured listing data ────────────────────────
  const context = buildContext(results);
  const todayStr = new Date().toISOString().slice(0, 10);

  const systemPrompt = `You are a real estate data extractor. Today is ${todayStr}. You receive web search snippets about rental listings in a city. Extract individual rental listings and return them as a JSON array. Only use information present in the snippets — never invent prices or details. Return ONLY raw JSON, no markdown, no backticks.`;

  const userPrompt = `Location: ${locationLabel} (lat ${lat.toFixed(4)}, lon ${lon.toFixed(4)})

Search results about rentals in this area:

${context}

Extract 4–6 individual rental listings from these results. For each listing:
- Use only real prices/details mentioned in the snippets
- bedrooms: number of bedrooms (integer), or null if not mentioned  
- price: monthly rent as a number (convert yearly to monthly if needed by dividing by 12), or null
- currency: e.g. "AED", "USD", "GBP", "INR" — infer from context
- type: "apartment", "villa", "studio", "townhouse", or "flat"
- area_sqft: size in sq ft as number, or null
- building: building or tower name if mentioned, or null
- Estimate lat/lon near the listing location within 0.03 degrees of ${lat.toFixed(4)}, ${lon.toFixed(4)}

Return ONLY a raw JSON array:
[{"name":"short label e.g. 2BR Marina Tower","bedrooms":2,"price":8500,"currency":"AED","type":"apartment","area_sqft":1100,"building":"Marina Tower","summary":"1-2 sentence description of this specific listing.","lat":${lat.toFixed(4)},"lon":${lon.toFixed(4)},"url":"listing url from results or null"}]`;

  let listings = null;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + groqKey },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1800,
        temperature: 0.2,   // very low — factual extraction only
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
      if (!listings) console.error('Llama parse failed:', text.slice(0, 300));
    } else {
      console.error('Groq error:', groqRes.status, await groqRes.text());
    }
  } catch (e) {
    console.error('Groq fetch error:', e.message);
  }

  if (!listings || !Array.isArray(listings) || listings.length === 0) {
    return new Response(JSON.stringify({ listings: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Step 3: Sanitise ──────────────────────────────────────────────────────
  const clean = listings
    .filter(l => l && l.name && l.lat && l.lon)
    .map((l, i) => ({
      id:         'rent_' + i,
      isRental:   true,
      name:       (l.name || 'Rental').slice(0, 40),
      bedrooms:   Number.isInteger(l.bedrooms) ? l.bedrooms : null,
      price:      l.price ? Math.round(parseFloat(l.price)) : null,
      currency:   (l.currency || 'AED').slice(0, 5),
      type:       (l.type || 'apartment').slice(0, 20),
      area_sqft:  l.area_sqft ? Math.round(parseFloat(l.area_sqft)) : null,
      building:   l.building ? l.building.slice(0, 50) : null,
      summary:    (l.summary || '').slice(0, 300),
      lat:        Math.max(lat - 0.03, Math.min(lat + 0.03, parseFloat(l.lat))),
      lon:        Math.max(lon - 0.03, Math.min(lon + 0.03, parseFloat(l.lon))),
      url:        l.url && l.url.startsWith('http') ? l.url : null,
    }))
    .slice(0, 6);

  return new Response(JSON.stringify({ listings: clean }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=1800',  // 30 min — listings don't change by the minute
    },
  });
}
