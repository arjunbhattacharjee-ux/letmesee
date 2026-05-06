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
  const _debug = [];
  const log = (...args) => { const msg = args.join(' '); console.log(msg); _debug.push(msg); };
  const fail = (status, msg) => new Response(JSON.stringify({ error: msg, _debug }), { status, headers: { 'Content-Type': 'application/json' } });

  if (req.method !== 'POST') return fail(405, 'Method not allowed');

  const tavilyKey = process.env.TAVILY_API_KEY;
  const groqKey   = process.env.GROQ_API_KEY;

  if (!tavilyKey) return fail(500, 'TAVILY_API_KEY not configured');
  if (!groqKey)   return fail(500, 'GROQ_API_KEY not configured');

  let body;
  try { body = await req.json(); }
  catch { return fail(400, 'Invalid JSON'); }

  const { lat, lon, city } = body;
  if (lat == null || lon == null) return fail(400, 'Missing lat/lon');

  const locationLabel = city || `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const todayStr = new Date().toISOString().slice(0, 10);
  log(`location="${locationLabel}" lat=${lat.toFixed(4)} lon=${lon.toFixed(4)} today=${todayStr}`);

  // ── Step 1: Run 3 Tavily searches in parallel ─────────────────────────────
  let recentResults = [], cityResults = [], historyResults = [];
  try {
    log('Tavily► launching 3 searches for "' + locationLabel + '"');
    [recentResults, cityResults, historyResults] = await Promise.all([
      tavilySearch(`${locationLabel} ${city || ''} news events 2025`.trim(), tavilyKey, 6, 'month'),
      tavilySearch(`${locationLabel} ${city || ''} incident development update`.trim(), tavilyKey, 5, 'month'),
      tavilySearch(`${locationLabel} ${city || ''} history landmark notable`.trim(), tavilyKey, 5, null),
    ]);
    log(`Tavily► recent=${recentResults.length} city=${cityResults.length} history=${historyResults.length}`);
  } catch (e) {
    log('Tavily► search failed: ' + e.message);
    try {
      historyResults = await tavilySearch(`${locationLabel} ${city || ''} news events`.trim(), tavilyKey, 8, null);
      log('Tavily► fallback got ' + historyResults.length + ' results');
    } catch (e2) { log('Tavily► fallback also failed: ' + e2.message); }
  }

  // Deduplicate by URL
  const seen = new Set();
  const allResults = [...recentResults, ...cityResults, ...historyResults].filter(r => {
    if (!r.url || seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
  log(`Tavily► deduped total=${allResults.length} results`);
  allResults.slice(0, 6).forEach((r, i) => log(`  [${i}] ${(r.title||'').slice(0,60)} | ${r.published_date||'no-date'}`));

  if (allResults.length === 0) {
    log('Tavily► 0 results after dedup — returning empty spots');
    return new Response(JSON.stringify({ spots: [], _debug }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Step 2: Pass real search results to Llama ─────────────────────────────
  const context = buildContext(allResults);

  const systemPrompt = `You are a hyperlocal news analyst. Today is ${todayStr}.
RULES (follow exactly):
1. Use ONLY facts present in the search snippets provided. Never invent, hallucinate, or add outside knowledge.
2. Every spot MUST be geographically in or immediately adjacent to ${locationLabel}${city ? ' / ' + city : ''}. Reject anything unrelated to this locality.
3. Do not include global, national, or unrelated science/space/world news — only local stories.
4. If fewer than 2 genuine local stories exist in the snippets, return an empty array [].
5. Return ONLY a raw JSON array — no markdown, no code fences, no commentary.`;

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

  // Try models in order — audited May 2026; see rentals.js for deprecation notes.
  const GROQ_MODELS = [
    'llama-3.3-70b-versatile', // primary
    'llama-3.1-8b-instant',    // fallback
  ];

  for (const model of GROQ_MODELS) {
    if (spots) break;
    log('Groq► trying model=' + model);
    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + groqKey },
        body: JSON.stringify({
          model,
          max_tokens: 2000,
          temperature: 0.3,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt   },
          ],
        }),
      });

      const rawBody = await groqRes.text();
      log('Groq► HTTP ' + groqRes.status + ' body_len=' + rawBody.length);
      if (!groqRes.ok) {
        log('Groq► error: ' + rawBody.slice(0, 200));
        if (groqRes.status === 401 || groqRes.status === 429) break;
        continue;
      }

      let gdata;
      try { gdata = JSON.parse(rawBody); } catch (_) { log('Groq► failed to parse response JSON'); continue; }
      const text = gdata.choices?.[0]?.message?.content || '';
      log('Groq► raw content preview: ' + text.slice(0, 120).replace(/\n/g,' '));
      spots = extractJSON(text);
      if (!spots) {
        log('Groq► JSON extraction failed. Raw: ' + text.slice(0, 300));
        spots = null;
      } else {
        log('Groq► parsed ' + spots.length + ' spots from model=' + model);
      }
    } catch (e) {
      log('Groq► fetch error (' + model + '): ' + e.message);
    }
  }

  if (!spots || !Array.isArray(spots) || spots.length === 0) {
    log('No valid spots after all models');
    return new Response(JSON.stringify({ spots: [], _debug }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Step 3: Sanitise ─────────────────────────────────────────────────────
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

  log(`Sanitised ${spots.length} → ${clean.length} spots`);
  clean.forEach((s, i) => log(`  BZ[${i}] cat=${s.category} date=${s.date||'null'} "${s.name.slice(0,30)}"`));

  return new Response(JSON.stringify({ spots: clean, _debug }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=900',
    },
  });
}
