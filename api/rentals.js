// /api/rentals.js — Vercel Edge function
// Tavily search → Groq/Llama extraction of real rental listings

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

function getCurrency(country = '', city = '', suburb = '') {
  const c = [country, city, suburb].join(' ').toLowerCase();
  if (c.includes('uae') || c.includes('dubai') || c.includes('abu dhabi')) return 'AED';
  if (c.includes('india'))                                                   return 'INR';
  if (c.includes('uk') || c.includes('united kingdom') || c.includes('london')) return 'GBP';
  if (c.includes('australia'))                                               return 'AUD';
  if (c.includes('singapore'))                                               return 'SGD';
  if (c.includes('saudi'))                                                   return 'SAR';
  if (c.includes('qatar'))                                                   return 'QAR';
  if (c.includes('usa') || c.includes('united states'))                     return 'USD';
  return 'USD';
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
  if (!res.ok) throw new Error('Tavily ' + res.status);
  const data = await res.json();
  return data.results || [];
}

function buildContext(results) {
  return results
    .map((r, i) => `[${i+1}] ${r.title}\nURL: ${r.url}\n${(r.content||'').slice(0,600)}`)
    .join('\n\n---\n\n');
}

function extractJSON(text) {
  if (!text) return null;
  const t = text.trim();
  if (t.startsWith('[')) { try { return JSON.parse(t); } catch(_){} }
  const m = t.match(/\[[\s\S]*?\]/);
  if (m) { try { return JSON.parse(m[0]); } catch(_){} }
  const m2 = t.match(/\[[\s\S]*/);
  if (m2) { try { return JSON.parse(m2[0]); } catch(_){} }
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

  const suburbLabel = suburb || city;
  const fullLabel   = [suburb, city, country].filter(Boolean).join(', ');
  const searchArea  = suburb ? suburb + ' ' + city : city;
  const currency    = getCurrency(country, city, suburb);
  const portals     = getPortals(country, city, suburb);

  console.log('[rentals] suburb="' + suburb + '" city="' + city + '" currency=' + currency);

  // ── Step 1: 3 broad unquoted Tavily queries ─────────────────────────────────
  // No exact-phrase quoting — portal snippets rarely contain the full compound string verbatim.
  let results = [];
  try {
    const queries = [
      suburbLabel + ' apartment for rent ' + currency + ' price bedroom',
      searchArea + ' rental listings site:' + portals[0],
      city + ' ' + suburb + ' flat for rent monthly price 2025',
    ];
    console.log('[rentals] queries: ' + JSON.stringify(queries));
    const fetched = await Promise.all(queries.map(q => tavilySearch(q, tavilyKey, 7).catch(() => [])));
    const seen = new Set();
    results = fetched.flat().filter(r => {
      if (!r.url || seen.has(r.url)) return false;
      seen.add(r.url); return true;
    });
    console.log('[rentals] Tavily: ' + results.length + ' unique results');
  } catch(e) {
    console.error('[rentals] Tavily error: ' + e.message);
    return new Response(JSON.stringify({listings:[],debug:'tavily_error:'+e.message}),{status:200,headers:{'Content-Type':'application/json'}});
  }

  if (!results.length) {
    return new Response(JSON.stringify({listings:[],debug:'no_tavily_results'}),{status:200,headers:{'Content-Type':'application/json'}});
  }

  // ── Step 2: Llama extraction — city-level match, not suburb-exact ──────────
  const context = buildContext(results);

  const systemPrompt = 'You are a real estate data extractor. Today is ' + new Date().toISOString().slice(0,10) + '.\n' +
'Target city: ' + city + '. Target neighbourhood: ' + suburbLabel + '.\n\n' +
'RULES:\n' +
'1. Extract rental listings in ' + city + ' or any of its neighbourhoods — city-level match is enough.\n' +
'2. Only reject listings in a completely different country or city (e.g. if target is Dubai, reject London or Riyadh).\n' +
'3. Never invent prices or building names. Use only what is in the snippets.\n' +
'4. Currency is ' + currency + '. Annual price -> divide by 12 for monthly. Round to nearest 100.\n' +
'5. Return ONLY a raw JSON array — no markdown, no backticks, no explanation text.';

  const exLat = lat.toFixed(4);
  const exLon = (lon + 0.003).toFixed(4);
  const userPrompt = 'Target: ' + fullLabel + ' (lat ' + lat.toFixed(4) + ', lon ' + lon.toFixed(4) + ')\n\n' +
'Search result snippets:\n' + context + '\n\n' +
'Extract 4-8 rental listings from the snippets. Accept any listing in ' + city + ' or its neighbourhoods.\n\n' +
'Each object must have these exact fields:\n' +
'name, bedrooms (int or null), price (monthly int), currency ("' + currency + '"), type ("apartment"|"villa"|"studio"|"townhouse"|"flat"), area_sqft (int or null), building (string or null), summary (one sentence), lat (float near ' + lat.toFixed(4) + '), lon (float near ' + lon.toFixed(4) + '), url (from snippets or null)\n\n' +
'Make each listing have DIFFERENT lat/lon values spread within 0.02 degrees.\n' +
'Start response with [ and end with ]. No other text.\n' +
'Example: [{"name":"2BR Executive Towers","bedrooms":2,"price":9500,"currency":"' + currency + '","type":"apartment","area_sqft":1100,"building":"Executive Towers","summary":"Spacious 2BR in Executive Towers, ' + city + '.","lat":' + exLat + ',"lon":' + exLon + ',"url":null}]\n\n' +
'If truly zero rentals found in ' + city + ', return exactly: []';

  let listings = null;
  let llamaRaw  = '';
  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + groqKey },
      body: JSON.stringify({
        model: 'llama3-70b-8192',
        max_tokens: 2000,
        temperature: 0.15,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
      }),
    });
    if (groqRes.ok) {
      const gdata = await groqRes.json();
      llamaRaw = gdata.choices?.[0]?.message?.content || '';
      console.log('[rentals] Llama raw: ' + llamaRaw.slice(0, 400));
      listings = extractJSON(llamaRaw);
      if (!listings) console.error('[rentals] JSON parse failed: ' + llamaRaw.slice(0,300));
    } else {
      const errBody = await groqRes.text();
      console.error('[rentals] Groq ' + groqRes.status + ': ' + errBody.slice(0, 200));
    }
  } catch(e) { console.error('[rentals] Groq fetch error: ' + e.message); }

  if (!listings || !Array.isArray(listings) || !listings.length) {
    return new Response(JSON.stringify({
      listings: [],
      debug: { llamaRaw: llamaRaw.slice(0, 600), tavilyCount: results.length }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // ── Step 3: Sanitise + spread coords ───────────────────────────────────────
  const SPREAD = 0.0014;
  const firstLat = listings[0]?.lat;
  const firstLon = listings[0]?.lon;

  const clean = listings
    .filter(l => l && l.name)
    .map((l, i) => {
      const allSame = listings.every(x => x.lat === firstLat && x.lon === firstLon);
      const angle   = (i / listings.length) * 2 * Math.PI;
      const jLat    = allSame ? Math.cos(angle) * SPREAD * (0.7 + i * 0.15) : 0;
      const jLon    = allSame ? Math.sin(angle) * SPREAD * (0.7 + i * 0.15) : 0;
      const rawLat  = parseFloat(l.lat) || lat;
      const rawLon  = parseFloat(l.lon) || lon;
      return {
        id:        'rent_' + i,
        isRental:  true,
        name:      (l.name || 'Rental').slice(0, 40),
        bedrooms:  Number.isInteger(l.bedrooms) ? l.bedrooms : (l.bedrooms != null ? parseInt(l.bedrooms) || null : null),
        price:     l.price ? Math.round(parseFloat(l.price)) : null,
        currency:  (l.currency || currency).slice(0, 5),
        type:      (l.type || 'apartment').slice(0, 20),
        area_sqft: l.area_sqft ? Math.round(parseFloat(l.area_sqft)) : null,
        building:  l.building ? l.building.slice(0, 50) : null,
        summary:   (l.summary || '').slice(0, 300),
        lat:       Math.max(lat - 0.025, Math.min(lat + 0.025, rawLat + jLat)),
        lon:       Math.max(lon - 0.025, Math.min(lon + 0.025, rawLon + jLon)),
        url:       l.url && l.url.startsWith('http') ? l.url : null,
      };
    })
    .slice(0, 8);

  console.log('[rentals] returning ' + clean.length + ' listings');
  return new Response(JSON.stringify({ listings: clean }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, s-maxage=1800' },
  });
}
