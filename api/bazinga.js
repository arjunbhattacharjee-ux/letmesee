// /api/bazinga.js — Vercel Edge function
// Uses Tavily Search API to find real local news/stories, then Groq/Llama to
// extract and format them as geo-tagged AR spots.
//
// Required env vars:
//   TAVILY_API_KEY  — from https://tavily.com (free: 1000 searches/month)
//   GROQ_API_KEY    — from https://console.groq.com

export const config = { runtime: 'edge' };

// ─── Tavily search ────────────────────────────────────────────────────────────
async function tavilySearch(query, tavilyKey, maxResults = 8, timeRange = null) {
  const payload = {
    api_key: tavilyKey,
    query,
    search_depth: 'basic',
    max_results: maxResults,
    include_answer: false,
    include_raw_content: false,
  };
  // time_range: "day"|"week"|"month"|"year" — only add if specified
  if (timeRange) payload.time_range = timeRange;

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Tavily ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.results || [];
}

// ─── Format results into a compact context block for Llama ───────────────────
function buildContext(results) {
  return results
    .map((r, i) => {
      const date = r.published_date ? `Date: ${r.published_date}` : '';
      return `[${i + 1}] ${r.title}\nURL: ${r.url}\n${date}\n${(r.content || '').slice(0, 500)}`;
    })
    .join('\n\n---\n\n');
}

// ─── Parse JSON array out of Llama response ───────────────────────────────────
function extractJSON(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch (_) {}
  }
  const match = trimmed.match(/\[[\s\S]*?\]/);
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
  const todayStr = new Date().toISOString().slice(0, 10);

  // ── Step 1: Run 3 Tavily searches in parallel ─────────────────────────────
  // • Recent news (past month) — broad query so we actually get results
  // • Broader city news (past month) — fallback if district returns little
  // • Historical/notable — no date limit
  let recentResults = [], cityResults = [], historyResults = [];
  try {
    [recentResults, cityResults, historyResults] = await Promise.all([
      tavilySearch(`"${locationLabel}" news 2025`, tavilyKey, 6, 'month'),
      tavilySearch(`Dubai ${locationLabel} incident crime event 2025`, tavilyKey, 5, 'month'),
      tavilySearch(`${locationLabel} famous historical notable landmark record`, tavilyKey, 5, null),
    ]);
  } catch (e) {
    console.error('Tavily search failed:', e.message);
    // Try one fallback search without time_range in case that was the issue
    try {
      historyResults = await tavilySearch(`${locationLabel} Dubai news events`, tavilyKey, 8, null);
    } catch (_) {}
  }

  // Deduplicate by URL
  const seen = new Set();
  const allResults = [...recentResults, ...cityResults, ...historyResults].filter(r => {
    if (!r.url || seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  if (allResults.length === 0) {
    return new Response(JSON.stringify({ spots: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Step 2: Pass real search results to Llama ─────────────────────────────
  const context = buildContext(allResults);

  const systemPrompt = `You are a hyperlocal news analyst. Today is ${todayStr}. You receive real web search snippets about a location and extract interesting stories. Return ONLY a raw JSON array — no markdown, no code fences, no commentary, just the [ ... ] array.`;

  const userPrompt = `Location: ${locationLabel} (lat ${lat.toFixed(4)}, lon ${lon.toFixed(4)})
Today: ${todayStr}

Search results:

${context}

Extract 4–6 of the most interesting stories. For each:
- Use ONLY facts from the snippets — never invent
- Recent news (past month): include the published date if visible in the snippet
- Historical facts: use the year or period mentioned (e.g. "2019", "early 2020s")
- If no date is mentioned anywhere: set date and date_label to null
- Estimate lat/lon within 0.04 degrees of ${lat.toFixed(4)}, ${lon.toFixed(4)}
- Use the matching URL from the results

Return a raw JSON array (no markdown, no backticks):
[{"name":"3-5 word title","headline":"One punchy sentence","summary":"2-3 sentences, facts only from snippets above.","category":"Crime|Politics|Traffic|Events|Environment|History|Quirky|Business","date":"YYYY-MM-DD or null","date_label":"human readable e.g. 12 Apr 2025 or 2019 or null","lat":${lat.toFixed(4)},"lon":${lon.toFixed(4)},"url":"source url or null"}]`;

  let spots = null;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + groqKey },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 2000,
        temperature: 0.3,
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
      if (!spots) console.error('Llama JSON parse failed. Raw:', text.slice(0, 300));
    } else {
      console.error('Groq error:', groqRes.status, await groqRes.text());
    }
  } catch (e) {
    console.error('Groq fetch error:', e.message);
  }

  if (!spots || !Array.isArray(spots) || spots.length === 0) {
    return new Response(JSON.stringify({ spots: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Step 3: Sanitise ─────────────────────────────────────────────────────
  // NOTE: We do NOT hard-filter by date here — Tavily's time_range already
  // scoped the recent searches. Llama may omit dates it can't find; we keep
  // those spots rather than silently drop them.
  const clean = spots
    .filter(s => s && s.summary && s.lat && s.lon)
    .map(s => ({
      name:       (s.name       || 'Local Story').slice(0, 40),
      headline:   (s.headline   || s.name || 'Nearby Story').slice(0, 100),
      summary:    (s.summary    || '').slice(0, 400),
      category:   s.category   || 'News',
      date:       s.date        || null,
      date_label: s.date_label  || null,
      lat:        Math.max(lat - 0.04, Math.min(lat + 0.04, parseFloat(s.lat))),
      lon:        Math.max(lon - 0.04, Math.min(lon + 0.04, parseFloat(s.lon))),
      url:        s.url && s.url.startsWith('http') ? s.url : null,
    }))
    .slice(0, 6);

  return new Response(JSON.stringify({ spots: clean }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=900',
    },
  });
}
