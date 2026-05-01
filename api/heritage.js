// /api/heritage.js — Vercel serverless function
// Proxies Groq/Llama requests so GROQ_API_KEY stays server-side only.

export const config = { runtime: 'edge' };

const PROMPT = (placeName, extract) =>
`You are a knowledgeable heritage guide. Based on this Wikipedia extract about "${placeName}", generate a JSON response with:
1. A "summary": 2 sentences — engaging, informative, written for a tourist standing at the site right now.
2. "facts": array of 3-4 objects, each with:
   - "icon": a relevant emoji
   - "label": short bold label (e.g. "Built", "Style", "Fun Fact", "Significance")
   - "text": 1-2 sentences of interesting detail

Wikipedia extract:
${extract}

Respond ONLY with valid JSON. No markdown, no explanation.`;

export default async function handler(req) {
  // Only allow POST
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

  const { placeName, extract } = body;
  if (!placeName || !extract) {
    return new Response(JSON.stringify({ error: 'Missing placeName or extract' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Call Groq
  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 500,
      temperature: 0.7,
      messages: [{ role: 'user', content: PROMPT(placeName, extract) }],
    }),
  });

  if (!groqRes.ok) {
    const err = await groqRes.text();
    return new Response(JSON.stringify({ error: 'Groq error: ' + err }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const data = await groqRes.json();
  const raw  = data.choices?.[0]?.message?.content || '{}';
  const clean = raw.replace(/```json|```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    // Return raw text as a summary if JSON parsing fails
    parsed = {
      summary: clean.slice(0, 300),
      facts: [],
    };
  }

  return new Response(JSON.stringify(parsed), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=3600', // cache 1hr per place
    },
  });
}
