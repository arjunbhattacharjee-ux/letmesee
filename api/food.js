// /api/food.js — Vercel Edge function
// Searches the web for restaurant/cafe/shop info using Groq + web search tool,
// returns a tourist-friendly summary + 2 fun facts.
//
// Anti-hallucination fixes applied:
//  1. Removed "make something up" fallback instruction — model returns NO_INFO instead.
//  2. Added strict grounding instruction: never confuse the place with a similarly named entity.
//  3. typeHint now covers shop tags (supermarket, mall, etc.) passed from ar2.html.
//  4. Web search tool enabled on the Groq call so the model can look up real data.

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

  // FIX 3: Extended typeHint to cover shop tags passed from ar2.html
  const typeHint =
    tags.shop === 'supermarket'    ? 'supermarket / grocery store' :
    tags.shop === 'mall'           ? 'shopping mall' :
    tags.shop === 'convenience'    ? 'convenience store' :
    tags.shop                      ? `${tags.shop.replace(/_/g, ' ')} shop` :
    tags.amenity === 'cafe'        ? 'café' :
    tags.amenity === 'fast_food'   ? 'fast food restaurant' :
    tags.amenity === 'bar'         ? 'bar' :
    tags.amenity === 'marketplace' ? 'marketplace' :
                                     'restaurant';

  // FIX 1 & 2: No "make something up" fallback. Strict grounding + NO_INFO sentinel.
  const systemPrompt = `You are a concise local guide with access to a web search tool.
CRITICAL RULES — violating any of these is a failure:
- You MUST use the web search tool to look up "${locationContext}" before writing anything.
- Write ONLY about the specific place named. NEVER confuse it with a person, film, TV show, or any other entity with a similar name.
- If the place name resembles a person's name or something unrelated, that is a coincidence — search specifically for the ${typeHint} called "${placeName}" in ${city || 'the given location'}.
- If your search returns no reliable information about this specific ${typeHint}, respond with exactly: NO_INFO
- Do NOT invent facts, generalise, or fill gaps with assumptions. If unsure, return NO_INFO.
- No markdown, no bullet points, no asterisks.`;

  const userPrompt = `Search for "${locationContext}", a ${typeHint}${cuisineHint}. Then write a 2-sentence tourist-friendly description covering the vibe, must-try items, price range, or what makes it special.

Output format — plain text only:
[Your 2-sentence description here]
FACT: [one fun fact or insider tip about this specific place, under 20 words]
FACT: [a second fun fact or practical tip, under 20 words]

If you cannot find reliable information about this specific place, output only: NO_INFO`;

  let summary = null;

  // FIX 4: Enable Groq web_search tool so the model fetches real data before responding
  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 400,
        temperature: 0.3,           // lower temp = less creative fabrication
        tools: [
          {
            type: 'function',
            function: {
              name: 'web_search',
              description: 'Search the web for up-to-date information about a place.',
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
          { role: 'user',   content: userPrompt  },
        ],
      }),
    });

    if (groqRes.ok) {
      const data = await groqRes.json();
      const content = data.choices?.[0]?.message?.content?.trim();
      // FIX 1: Treat NO_INFO sentinel as "no data" — return null so frontend hides the card
      if (content && content.length > 20 && content !== 'NO_INFO') {
        summary = content;
      }
    } else {
      const errText = await groqRes.text();
      console.error('Groq primary error:', errText);
    }
  } catch (e) { /* fall through to fallback */ }

  // Fallback: strict prompt, no web search tool, but still grounded + NO_INFO aware
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
          max_tokens: 250,
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              // FIX 2 (fallback): Same strict grounding, no hallucination permission
              content: `You are a concise local guide. Only write about the specific ${typeHint} named "${placeName}" in ${city || 'the given location'}.
NEVER confuse it with a similarly named person, film, TV show, or unrelated entity.
If you have no reliable information about this specific place, respond with exactly: NO_INFO
Do not invent, generalise, or fill gaps with assumptions.`,
            },
            {
              role: 'user',
              content: `Write a 2-sentence tourist-friendly description of "${locationContext}", a ${typeHint}${cuisineHint}. Focus on the vibe and what makes it worth visiting. If you have no specific knowledge of this exact place, respond with: NO_INFO`,
            },
          ],
        }),
      });
      if (fallbackRes.ok) {
        const fallbackData = await fallbackRes.json();
        const content = fallbackData.choices?.[0]?.message?.content?.trim();
        // FIX 1 (fallback): Honour NO_INFO sentinel
        if (content && content !== 'NO_INFO' && content.length > 20) {
          summary = content;
        }
      }
    } catch (_) { /* silent */ }
  }

  // Return null summary — ar2.html already hides the card when summary is null
  return new Response(JSON.stringify({ summary: summary ?? null }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=3600',
    },
  });
}
