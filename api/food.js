// /api/food.js — Vercel Edge function
// Returns a tourist-friendly summary + 2 fun facts for restaurants, cafes, shops, etc.
//
// Anti-hallucination fixes:
//  1. NO_INFO sentinel — model returns NO_INFO instead of fabricating for truly unknown places.
//  2. Strict grounding instruction — never confuse place with a similarly named person/entity.
//  3. typeHint covers shop tags (supermarket, mall, etc.) so the model has a clear anchor.
//  (Fix 4 / web search tool removed — Groq's function-calling doesn't support live web search,
//   it caused silent failures. Well-known places still work fine from model knowledge.)

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

  // FIX 1 & 2: Strict grounding. NO_INFO sentinel for truly unknown places.
  // Well-known chains/restaurants the model knows about will still get descriptions.
  // The key change: we only return NO_INFO for places the model genuinely cannot
  // identify — not for well-known brands like Elegant Elephant, Choithrams, etc.
  const systemPrompt = `You are a concise local guide writing for tourists.
IMPORTANT RULES:
- You are describing "${placeName}", a ${typeHint} located in ${city || 'the local area'}.
- NEVER confuse this place with a person, actor, film, TV show, or any other entity that has a similar name. The name refers specifically to this ${typeHint}, not any person or media.
- If you have genuine knowledge of this specific ${typeHint} (e.g. it is a known chain, brand, or establishment), write about it.
- If you have NO specific knowledge of this exact place AND cannot make a reasonable, accurate inference from the cuisine type and location context, respond with exactly: NO_INFO
- Do NOT invent specific facts (awards, founding dates, named dishes) you are not sure about.
- No markdown, no bullet points, no asterisks.`;

  const userPrompt = `Write a 2-sentence tourist-friendly description of "${locationContext}", a ${typeHint}${cuisineHint}. Cover the vibe, must-try items, price range, or what makes it special. Be specific and engaging — if it is a known chain or brand, mention what it is known for.

Output format — plain text only, no markdown, no asterisks:
[Your 2-sentence description here]
FACT: [one fun fact or insider tip about this place or its cuisine, under 20 words]
FACT: [a second fun fact or practical tip, under 20 words]

Only if you truly have no usable knowledge about this specific place: NO_INFO`;

  let summary = null;

  // Primary call
  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 300,
        temperature: 0.5,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt  },
        ],
      }),
    });

    if (groqRes.ok) {
      const data = await groqRes.json();
      const content = data.choices?.[0]?.message?.content?.trim();
      // FIX 1: Honour NO_INFO sentinel — hide card rather than show hallucinated content
      if (content && content.length > 20 && content !== 'NO_INFO') {
        summary = content;
      }
    } else {
      const errText = await groqRes.text();
      console.error('Groq primary error:', errText);
    }
  } catch (e) { /* fall through to fallback */ }

  // Fallback: simpler prompt, same grounding rules
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
          temperature: 0.4,
          messages: [
            {
              role: 'system',
              // FIX 2: Same strict grounding in fallback
              content: `You are a concise local guide. You are describing "${placeName}", a ${typeHint} in ${city || 'the local area'}. NEVER confuse this with a person, actor, or media property with a similar name. If you have no usable knowledge of this specific place, respond with: NO_INFO`,
            },
            {
              role: 'user',
              content: `Write a 2-sentence tourist-friendly description of "${locationContext}", a ${typeHint}${cuisineHint}. Focus on cuisine, vibe, and what makes it worth visiting. If you truly have no knowledge of this place, respond with: NO_INFO`,
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

  // Return null summary — ar2.html hides the card when summary is null
  return new Response(JSON.stringify({ summary: summary ?? null }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=3600',
    },
  });
}
