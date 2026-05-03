// /api/osm.js — Vercel Edge function
// Proxies Overpass API requests server-side, bypassing CORS/allowlist restrictions.
// The browser calls /api/osm; this calls the real mirrors without Origin headers.

export const config = { runtime: 'edge' };

const MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

const TIMEOUT_MS = 25000;

async function tryMirror(url, body, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal,
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();
  if (text.length < 10) throw new Error('Empty response');
  const json = JSON.parse(text); // throws if invalid
  if (!Array.isArray(json.elements)) throw new Error('No elements array');
  return text; // return raw text to pass through
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
    return new Response(JSON.stringify({ error: 'Invalid body — expected data=<query>' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Try each mirror in order; first success wins
  const errors = [];
  for (const mirror of MIRRORS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const text = await tryMirror(mirror, body, ctrl.signal);
      clearTimeout(timer);
      return new Response(text, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, s-maxage=120',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (e) {
      clearTimeout(timer);
      errors.push(mirror.split('/')[2] + ': ' + e.message);
    }
  }

  return new Response(JSON.stringify({ error: 'All mirrors failed', details: errors }), {
    status: 502, headers: { 'Content-Type': 'application/json' },
  });
}
