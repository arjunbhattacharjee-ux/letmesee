// /api/heritage.js — Vercel Edge function
// Rewrites a Wikipedia extract tourist-friendly, plus 2 fun facts.

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

  const { placeName, extract, city } = body;
  if (!placeName || !extract) {
    return new Response(JSON.stringify({ error: 'Missing placeName or extract' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const locationContext = city ? `"${placeName}" in ${city}` : `"${placeName}"`;

  const prompt = `You are a helpful local guide. Rewrite the following description of ${locationContext} for a tourist standing right there. Use 2–3 engaging sentences. Stay strictly factual — do NOT add any facts, dates, or names not present in the original text.

Original text:
${extract.slice(0, 1500)}

Output format — plain text only, no markdown, no asterisks:
[Your 2–3 sentence rewrite here]
FACT: [one short insider tip or fun fact from the text, under 20 words]
FACT: [a second short fun fact or highlight from the text, under 20 words]`;

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
          content: 'You are a concise local guide. Always follow the exact output format requested. No markdown, no bullet points, no asterisks.',
        },
        { role: 'user', content: prompt },
      ],
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
