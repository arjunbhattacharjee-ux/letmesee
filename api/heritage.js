// /api/heritage.js — Vercel serverless function (Edge Runtime)
// Proxies Groq/Llama requests, keeping GROQ_API_KEY server‑side.

export const config = { runtime: 'edge' };

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
    return new Response(
      JSON.stringify({ error: 'GROQ_API_KEY not configured' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
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

  const { placeName, prompt, extract } = body;

  // Use the client-supplied prompt if available; otherwise build a simple one
  const userPrompt =
    prompt && prompt.trim().length > 0
      ? prompt
      : `You are a knowledgeable local guide. Based on this information about "${placeName}", give a concise overview.${extract ? '\n\nContext:\n' + extract.slice(0, 2500) : ''}`;

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
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!groqRes.ok) {
    const errText = await groqRes.text();
    return new Response(JSON.stringify({ error: 'Groq error: ' + errText }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const data = await groqRes.json();
  const raw = data.choices?.[0]?.message?.content || '{}';
  // Strip any markdown code fences that the model might emit
  const clean = raw.replace(/```json|```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    // If JSON parsing fails, return the raw text as a fallback summary
    parsed = {
      summary: clean.slice(0, 300),
      facts: [],
    };
  }

  return new Response(JSON.stringify(parsed), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=3600', // cache 1 hour per place
    },
  });
}
