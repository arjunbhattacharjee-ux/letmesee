// /api/food.js — Vercel Edge function
// Searches the web for restaurant/cafe info using Groq,
// returns a tourist-friendly summary + 2 fun facts.

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
  const typeHint =
    tags.amenity === 'cafe' ? 'café' :
    tags.amenity === 'fast_food' ? 'fast food restaurant' :
    tags.amenity === 'bar' ? 'bar' : 'restaurant';

  const prompt = `You are a local food expert. Write a 2-sentence tourist-friendly description of "${locationContext}"${cuisineHint}, a ${typeHint}. Cover the vibe, must-try dishes, price range, or what makes it special. Be specific and engaging. If you don't have exact details for this place, give a realistic description based on the cuisine type and location.

Output format — plain text only, no markdown, no asterisks:
[Your 2-sentence description here]
FACT: [one fun fact or insider tip about this place or cuisine, under 20 words]
FACT: [a second fun fact or practical tip, under 20 words]`;

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
        temperature: 0.6,
        messages: [
          {
            role: 'system',
            content: 'You are a concise local food guide. Always follow the exact output format requested. No markdown, no bullet points, no asterisks.',
          },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (groqRes.ok) {
      const data = await groqRes.json();
      const content = data.choices?.[0]?.message?.content?.trim();
      if (content && content.length > 20) summary = content;
    }
  } catch (e) { /* fall through to fallback */ }

  // Fallback: simpler prompt without format instructions
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
              content: `Write a 2-sentence tourist-friendly description of "${locationContext}", a ${typeHint}${cuisineHint}. Focus on cuisine, vibe, and what makes it worth visiting.`,
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
