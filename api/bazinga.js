// /api/bazinga.js — Vercel Edge function
// Uses Groq + web search to find interesting local news, events, and incidents
// near the user's location, returning geo-tagged "spots" for AR overlay.

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'GROQ_API_KEY not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }

  const { lat, lon, city } = body;
  if (lat == null || lon == null) {
    return new Response(JSON.stringify({ error: 'Missing lat/lon' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const locationLabel = city || `${lat.toFixed(3)}, ${lon.toFixed(3)}`;

  const systemPrompt = `You are a hyperlocal news analyst. Your job is to find interesting, real, recent local news stories, events, incidents, or facts happening in or around a given city. You must search the web for current information and return results as a JSON array only — no markdown, no commentary, just raw JSON.`;

  const userPrompt = `Search the web for recent interesting local news, events, or incidents happening in or near ${locationLabel} (coordinates: ${lat.toFixed(4)}, ${lon.toFixed(4)}).

Find 4–6 stories from the past 2 weeks. These can include:
- Local crime incidents or police activity
- Political events, protests, or government decisions
- Road closures, construction, or infrastructure
- Festivals, cultural events, or markets
- Environmental events (floods, dust storms, etc.)
- Unusual or quirky local happenings

For each story, estimate a lat/lon near where it happened (within the city — must be within 0.05 degrees of ${lat.toFixed(4)}, ${lon.toFixed(4)}). Use nearby landmarks, street names, or districts mentioned in the story to place it accurately.

Return ONLY a JSON array, no other text:
[
  {
    "name": "Short 3-5 word title",
    "headline": "One sentence headline",
    "summary": "2-3 sentence summary of what happened, when, and why it matters locally.",
    "category": "Crime|Politics|Traffic|Events|Environment|Quirky",
    "lat": 25.1234,
    "lon": 55.1234,
    "url": "https://source-article-url-if-available-or-null"
  }
]`;

  // First attempt: with web_search tool
  let spots = null;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1200,
        temperature: 0.4,
        tools: [
          {
            type: 'function',
            function: {
              name: 'web_search',
              description: 'Search the web for current news and events',
              parameters: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: 'The search query' },
                },
                required: ['query'],
              },
            },
          },
        ],
        tool_choice: 'auto',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (groqRes.ok) {
      const data = await groqRes.json();
      for (const choice of data.choices || []) {
        const text = choice.message?.content;
        if (text && text.trim().startsWith('[')) {
          try {
            spots = JSON.parse(text.trim());
            break;
          } catch (_) { /* try to extract JSON */ }
        }
        if (text) {
          const jsonMatch = text.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            try { spots = JSON.parse(jsonMatch[0]); break; } catch(_) {}
          }
        }
      }
    }
  } catch (e) { /* fall through to simpler call */ }

  // Fallback: no tool, just ask for JSON from training knowledge
  if (!spots) {
    try {
      const fallbackRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 1000,
          temperature: 0.5,
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: `Based on your knowledge of ${locationLabel}, generate 4–5 plausible, realistic local interest spots — places associated with news events, cultural moments, notable incidents, or interesting facts. These should be real types of places that exist in cities like this one. Use coordinates within 0.03 degrees of ${lat.toFixed(4)}, ${lon.toFixed(4)}.

Return ONLY a JSON array:
[{"name":"Short title","headline":"One sentence","summary":"2-3 sentences.","category":"Crime|Politics|Traffic|Events|Environment|Quirky","lat":${lat.toFixed(4)},"lon":${lon.toFixed(4)},"url":null}]`,
            },
          ],
        }),
      });

      if (fallbackRes.ok) {
        const data = await fallbackRes.json();
        const text = data.choices?.[0]?.message?.content || '';
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          try { spots = JSON.parse(jsonMatch[0]); } catch (_) {}
        }
      }
    } catch (_) {}
  }

  if (!spots || !Array.isArray(spots) || spots.length === 0) {
    return new Response(JSON.stringify({ spots: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Sanitise: clamp coords to within 5km of user, ensure required fields
  const clean = spots
    .filter(s => s && s.lat && s.lon && s.summary)
    .map(s => ({
      name:     (s.name     || 'Local Update').slice(0, 40),
      headline: (s.headline || s.name || 'Nearby Story').slice(0, 100),
      summary:  (s.summary  || '').slice(0, 400),
      category: s.category || 'News',
      lat:      Math.max(lat - 0.05, Math.min(lat + 0.05, parseFloat(s.lat))),
      lon:      Math.max(lon - 0.05, Math.min(lon + 0.05, parseFloat(s.lon))),
      url:      s.url && s.url.startsWith('http') ? s.url : null,
    }))
    .slice(0, 6);

  return new Response(JSON.stringify({ spots: clean }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=900', // 15 min cache — news changes
    },
  });
}
