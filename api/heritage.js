// /api/heritage.js — Vercel Edge function
// Summarises a Wikipedia extract in a tourist‑friendly tone.
// No new facts are invented — strict rewriting only.

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

  const { placeName, extract } = body;
  if (!placeName || !extract) {
    return new Response(JSON.stringify({ error: 'Missing placeName or extract' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const prompt = `You are a helpful local guide. Rewrite the following description of "${placeName}" for a tourist standing right there. Use 2–3 engaging sentences. Do NOT add any facts, dates, or names that are not in the original text. Stay strictly factual.

Original text:
${extract.slice(0, 1500)}

Rewritten (just the text, no extra commentary):`;

  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 200,
      temperature: 0.6,
      messages: [{ role: 'user', content: prompt }],
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
  const raw = data.choices?.[0]?.message?.content || extract.slice(0, 200);

  return new Response(JSON.stringify({ summary: raw.trim() }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=3600',
    },
  });
}
