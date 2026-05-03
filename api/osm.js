// /api/osm.js — Vercel Edge function
// Proxies Overpass API requests server-side (no CORS/allowlist issues).
// Races all mirrors in parallel — first valid response wins.

export const config = { runtime: 'edge' };

const MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

// Must stay well under Vercel Edge 30s wall-clock limit
const MIRROR_TIMEOUT_MS = 22000;

async function tryMirror(url, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MIRROR_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + url);
    const text = await res.text();
    if (!text || text.length < 10) throw new Error('Empty response from ' + url);
    const json = JSON.parse(text);
    if (!Array.isArray(json.elements)) throw new Error('No elements array from ' + url);
    return text;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await req.text();
    if (!body || !body.startsWith('data=')) throw new Error('bad body');
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Race all mirrors — first valid response wins
  const errors = [];
  const result = await new Promise((resolve) => {
    let settled = false;
    let rejectedCount = 0;

    MIRRORS.forEach((url) => {
      tryMirror(url, body)
        .then((text) => {
          if (!settled) { settled = true; resolve({ ok: true, text }); }
        })
        .catch((e) => {
          errors.push(e.message);
          rejectedCount++;
          if (rejectedCount === MIRRORS.length && !settled) {
            settled = true;
            resolve({ ok: false });
          }
        });
    });
  });

  if (!result.ok) {
    console.error('osm proxy: all mirrors failed', errors);
    return new Response(JSON.stringify({ error: 'All mirrors failed', details: errors }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(result.text, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=120',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
