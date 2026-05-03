// /api/bazinga.js — Vercel Edge function
// Uses Tavily Search API to find real local news/stories, then Groq/Llama to
// extract and format them as geo-tagged AR spots.
//
// Required env vars:
//   TAVILY_API_KEY  — from https://tavily.com (free: 1000 searches/month)
//   GROQ_API_KEY    — from https://console.groq.com

export const config = { runtime: 'edge' };

// ─── Tavily search ────────────────────────────────────────────────────────────
async function tavilySearch(query, tavilyKey, maxResults = 8) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: tavilyKey,
      query,
      search_depth: 'basic',   // 'advanced' uses 2 credits; basic = 1
      max_results: maxResults,
      include_answer: false,
      include_raw_content: false,
    }),
  });
  if (!res.ok) throw new Error('Tavily error: ' + res.status);
  const data = await res.json();
  return data.results || [];   // [{ title, url, content, score }]
}

// ─── Format search results into a compact context block for Llama ─────────────
function buildContext(results) {
  return results
    .map((r, i) =>
      `[${i + 1}] ${r.title}\nURL: ${r.url}\n${(r.content || '').slice(0, 400)}`
    )
    .join('\n\n');
}

// ─── Parse JSON array out of Llama response ───────────────────────────────────
function extractJSON(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch (_) {}
  }
  const match = trimmed.match(/\[[\s\S]*\]/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) {}
  }
  return null;
}

// ─── Main handler ─────────────────────────────────────────────────────────────
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

  const { lat, lon, city } = body;
  if (lat == null || lon == null) {
    return new Response(JSON.stringify({ error: 'Missing lat/lon' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const locationLabel = city || `${lat.toFixed(3)},${lon.toFixed(3)}`;

  // ── Step 1: Run 2 Tavily searches in parallel ─────────────────────────────
  // One for recent news, one for historical/notable stories
  let searchResults = [];
  try {
    const [recentResults, historyResults] = await Promise.all([
      tavilySearch(`${locationLabel} news 2024 2025`, tavilyKey, 6),
      tavilySearch(`${locationLabel} famous incident history notable`, tavilyKey, 5),
    ]);
    searchResults = [...recentResults, ...historyResults];
  } catch (e) {
    console.error('Tavily search failed:', e.message);
    // Return empty rather than hallucinate
    return new Response(JSON.stringify({ spots: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  if (searchResults.length === 0) {
    return new Response(JSON.stringify({ spots: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Step 2: Pass real search results to Llama to extract & format spots ───
  const context = buildContext(searchResults);

  const systemPrompt = `You are a hyperlocal news analyst. You will be given real search result snippets about a location. Extract the most interesting stories and return them as a JSON array. Only use information present in the search results — do not invent or add anything. Return ONLY raw JSON, no markdown, no commentary.`;

  const userPrompt = `Location: ${locationLabel} (coordinates: ${lat.toFixed(4)}, ${lon.toFixed(4)})

Here are real search results about this location:

${context}

Extract 4–6 of the most interesting stories from these results. For each story:
- Use only facts from the search snippets above
- Estimate a lat/lon near where it happened (within 0.04 degrees of ${lat.toFixed(4)}, ${lon.toFixed(4)})
- Pick the most relevant URL from the results

Return ONLY a valid JSON array:
[
  {
    "name": "3-5 word title",
    "headline": "One punchy sentence",
    "summary": "2-3 sentences using only facts from the search results above.",
    "category": "Crime|Politics|Traffic|Events|Environment|History|Quirky|Business",
    "lat": ${lat.toFixed(4)},
    "lon": ${lon.toFixed(4)},
    "url": "https://source-url-from-results-above-or-null"
  }
]`;

  let spots = null;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + groqKey,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1500,
        temperature: 0.3,   // low — we want factual extraction, not creativity
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
      }),
    });

    if (groqRes.ok) {
      const data = await groqRes.json();
      const text = data.choices?.[0]?.message?.content || '';
      spots = extractJSON(text);
    } else {
      console.error('Groq error:', await groqRes.text());
    }
  } catch (e) {
    console.error('Groq fetch error:', e.message);
  }

  if (!spots || !Array.isArray(spots) || spots.length === 0) {
    return new Response(JSON.stringify({ spots: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Step 3: Sanitise — clamp coords, enforce required fields ─────────────
  const clean = spots
    .filter(s => s && s.summary && s.lat && s.lon)
    .map(s => ({
      name:     (s.name     || 'Local Story').slice(0, 40),
      headline: (s.headline || s.name || 'Nearby Story').slice(0, 100),
      summary:  (s.summary  || '').slice(0, 400),
      category: s.category || 'News',
      lat:      Math.max(lat - 0.04, Math.min(lat + 0.04, parseFloat(s.lat))),
      lon:      Math.max(lon - 0.04, Math.min(lon + 0.04, parseFloat(s.lon))),
      url:      s.url && s.url.startsWith('http') ? s.url : null,
    }))
    .slice(0, 6);

  return new Response(JSON.stringify({ spots: clean }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=900',  // 15 min cache
    },
  });
}
