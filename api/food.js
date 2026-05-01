// /api/food.js — Vercel Edge function
// Searches the web for restaurant/cafe info using Groq's web_search tool,
// then returns a short tourist-friendly summary.

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
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { placeName, city, tags = {} } = body;
  if (!placeName) {
    return new Response(JSON.stringify({ error: 'Missing placeName' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const locationContext = city ? `${placeName}, ${city}` : placeName;
  const cuisineHint = tags.cuisine ? ` (${tags.cuisine.replace(/_/g, ' ')})` : '';
  const typeHint = tags.amenity === 'cafe' ? 'café' : tags.amenity === 'fast_food' ? 'fast food restaurant' : 'restaurant';

  // First call: ask Groq to web-search for the place
  const searchPrompt = `Search the web for "${locationContext}"${cuisineHint} — a ${typeHint}. Find its cuisine type, vibe, must-try dishes, price range, and any notable reviews. Then write a 2–3 sentence tourist-friendly summary of what makes it worth visiting. Be specific and factual based only on what you find. If you cannot find reliable information about this specific place, say so briefly.`;

  let groqRes;
  try {
    groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 300,
        temperature: 0.5,
        tools: [
          {
            type: 'function',
            function: {
              name: 'web_search',
              description: 'Search the web for current information',
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
          {
            role: 'system',
            content: 'You are a helpful local food guide. Use web search to find accurate, up-to-date information about restaurants and cafés. Always search before answering.',
          },
          { role: 'user', content: searchPrompt },
        ],
      }),
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Groq request failed: ' + e.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!groqRes.ok) {
    const errText = await groqRes.text();
    return new Response(JSON.stringify({ error: 'Groq error: ' + errText }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const data = await groqRes.json();

  // Extract the final text response (after any tool calls)
  let summary = null;
  for (const choice of data.choices || []) {
    const msg = choice.message;
    if (msg?.content && msg.content.trim().length > 20) {
      summary = msg.content.trim();
      break;
    }
  }

  // Fallback: if model only returned a tool_call with no final text,
  // do a simpler follow-up without tools
  if (!summary) {
    try {
      const fallbackRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 200,
          temperature: 0.5,
          messages: [
            {
              role: 'user',
              content: `Write a 2–3 sentence tourist-friendly description of "${locationContext}", a ${typeHint}${cuisineHint}. Focus on cuisine, vibe, and what makes it worth visiting. Be concise and engaging.`,
            },
          ],
        }),
      });
      if (fallbackRes.ok) {
        const fallbackData = await fallbackRes.json();
        summary = fallbackData.choices?.[0]?.message?.content?.trim() || null;
      }
    } catch (_) { /* silent */ }
  }

  if (!summary) {
    return new Response(JSON.stringify({ summary: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ summary }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=3600',
    },
  });
}
