// /api/bazinga.js — Vercel Edge function
// Uses Tavily Search API to find real local news/stories, then Groq/Llama to
// extract and format them as geo-tagged AR spots.
//
// Required env vars:
//   TAVILY_API_KEY  — from https://tavily.com (free: 1000 searches/month)
//   GROQ_API_KEY    — from https://console.groq.com

export const config = { runtime: 'edge' };

// ─── Tavily search ────────────────────────────────────────────────────────────
async function tavilySearch(query, tavilyKey, maxResults = 8, daysBack = null) {
  const payload = {
    api_key: tavilyKey,
    query,
    search_depth: 'basic',
    max_results: maxResults,
    include_answer: false,
    include_raw_content: false,
  };
  // Tavily supports days_back to restrict recency
  if (daysBack) payload.days = daysBack;

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Tavily error: ' + res.status);
  const data = await res.json();
  return data.results || [];  // [{ title, url, content, score, published_date? }]
}

// ─── Format results into a compact context block for Llama ───────────────────
function buildContext(results) {
  return results
    .map((r, i) => {
      const date = r.published_date ? `Published: ${r.published_date}` : '';
      return `[${i + 1}] ${r.title}\nURL: ${r.url}\n${date}\n${(r.content || '').slice(0, 400)}`;
    })
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

// ─── Check if a date string is within the past N days ────────────────────────
function isWithinDays(dateStr, days) {
  if (!dateStr) return true; // no date = don't filter out
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return true;
    return (Date.now() - d.getTime()) <= days * 24 * 60 * 60 * 1000;
  } catch (_) { return true; }
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

  // Get current date for prompting Llama with context
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // ── Step 1: Run 2 Tavily searches in parallel ─────────────────────────────
  // Recent news: hard-limited to past 30 days via Tavily's days param
  // Historical: no date limit — notable/sensational older stories
  let recentResults = [];
  let historyResults = [];
  try {
    [recentResults, historyResults] = await Promise.all([
      tavilySearch(`${locationLabel} news incident`, tavilyKey, 7, 30),
      tavilySearch(`${locationLabel} famous notable historical event`, tavilyKey, 5, null),
    ]);
  } catch (e) {
    console.error('Tavily search failed:', e.message);
    return new Response(JSON.stringify({ spots: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Tag results so Llama knows which are recent vs historical
  const taggedRecent  = recentResults.map(r  => ({ ...r, _type: 'recent' }));
  const taggedHistory = historyResults.map(r => ({ ...r, _type: 'history' }));
  const allResults = [...taggedRecent, ...taggedHistory];

  if (allResults.length === 0) {
    return new Response(JSON.stringify({ spots: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Step 2: Pass real search results to Llama ─────────────────────────────
  const context = buildContext(allResults);

  const systemPrompt = `You are a hyperlocal news analyst. Today's date is ${todayStr}. You will be given real search result snippets about a location. Extract the most interesting stories and return them as a JSON array. Only use information present in the search results — do not invent anything. Return ONLY raw JSON, no markdown, no commentary.`;

  const userPrompt = `Location: ${locationLabel} (coordinates: ${lat.toFixed(4)}, ${lon.toFixed(4)})
Today's date: ${todayStr}

Here are real search results about this location (results marked [recent] are from the past 30 days):

${context}

Extract 4–6 of the most interesting stories. Rules:
- Only use facts from the snippets above — do not invent anything
- For each story, extract or estimate the date it happened:
  - For recent news: use the published date from the snippet (format: YYYY-MM-DD or "Month YYYY")
  - For historical events: use the year or approximate date mentioned in the text
  - If no date is found: use null
- Estimate a lat/lon near where it happened (within 0.04 degrees of ${lat.toFixed(4)}, ${lon.toFixed(4)})
- Use the URL from the matching search result

Return ONLY a valid JSON array:
[
  {
    "name": "3-5 word title",
    "headline": "One punchy sentence",
    "summary": "2-3 sentences using only facts from the search results above.",
    "category": "Crime|Politics|Traffic|Events|Environment|History|Quirky|Business",
    "date": "2025-04-15",
    "date_label": "Apr 2025",
    "lat": ${lat.toFixed(4)},
    "lon": ${lon.toFixed(4)},
    "url": "https://source-url-from-results-above-or-null"
  }
]

For date_label use a human-readable string like "15 Apr 2025", "March 2024", "2019", or null if unknown.`;

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
        max_tokens: 1800,
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

  // ── Step 3: Sanitise + enforce 30-day rule on recent news ────────────────
  const clean = spots
    .filter(s => {
      if (!s || !s.summary || !s.lat || !s.lon) return false;
      // If category looks like recent news (not History), enforce 30-day cutoff
      const isHistorical = (s.category || '').toLowerCase() === 'history';
      if (!isHistorical && s.date && !isWithinDays(s.date, 30)) return false;
      return true;
    })
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
