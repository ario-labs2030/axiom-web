// api/reframe.js  — hardened proxy for Axiom Reframe
// Drop this into your /api/ folder and redeploy.
//
// What this adds over the original:
//   1. Per-IP rate limiting (10 req/min in memory — upgrade to Redis/KV for multi-instance)
//   2. Request body validation — only known models/fields forwarded
//   3. Hard max_tokens cap — prevents cost-farming via large token requests
//   4. Response size cap — prevents memory exhaustion on huge responses
//   5. Structured error responses — never exposes raw Anthropic errors to the client
//   6. CORS locked to your own origin (set ALLOWED_ORIGIN in Vercel env vars)

// ── In-memory rate limiter ──
// Works for single-instance serverless. For multi-instance, swap with
// Vercel KV / Upstash Redis using the same interface.
const ipWindows = new Map(); // ip → { count, windowStart }
const RATE_LIMIT  = 10;       // max requests
const WINDOW_MS   = 60_000;   // per 60 seconds

function isRateLimited(ip) {
  const now = Date.now();
  const entry = ipWindows.get(ip);

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    ipWindows.set(ip, { count: 1, windowStart: now });
    return false;
  }

  if (entry.count >= RATE_LIMIT) return true;

  entry.count++;
  return false;
}

// ── Allowed models ──
const ALLOWED_MODELS = new Set([
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-20250514',
]);

// Hard cap on tokens regardless of what the client requests
const MAX_TOKENS_CAP = 5000;

export default async function handler(req, res) {

  // ── CORS ──
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '';
  const origin = req.headers.origin || '';

  if (allowedOrigin && origin !== allowedOrigin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Rate limiting ──
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }

  // ── Input validation ──
  const body = req.body;

  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const { model, max_tokens, messages } = body;

  if (!ALLOWED_MODELS.has(model)) {
    return res.status(400).json({ error: 'Invalid model' });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages required' });
  }

  // Validate each message has role + string content
  for (const msg of messages) {
    if (!msg.role || typeof msg.content !== 'string') {
      return res.status(400).json({ error: 'Invalid message format' });
    }
    // Cap individual message length to prevent prompt-stuffing
    if (msg.content.length > 12_000) {
      return res.status(400).json({ error: 'Message too long' });
    }
  }

  // ── Build sanitised Anthropic payload ──
  // Only forward known safe fields — drop anything the client appended
  const anthropicPayload = {
    model,
    max_tokens: Math.min(Number(max_tokens) || 1000, MAX_TOKENS_CAP),
    messages: messages.map(m => ({ role: m.role, content: m.content })),
  };

  // ── Forward to Anthropic ──
  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicPayload),
    });
  } catch (networkErr) {
    console.error('Anthropic network error:', networkErr);
    return res.status(502).json({ error: 'Upstream connection failed' });
  }

  // ── Response size guard (prevent memory exhaustion) ──
  const MAX_RESPONSE_BYTES = 1_000_000; // 1MB
  const contentLength = parseInt(anthropicRes.headers.get('content-length') || '0', 10);
  if (contentLength > MAX_RESPONSE_BYTES) {
    return res.status(502).json({ error: 'Response too large' });
  }

  let data;
  try {
    data = await anthropicRes.json();
  } catch (parseErr) {
    console.error('Anthropic response parse error:', parseErr);
    return res.status(502).json({ error: 'Invalid upstream response' });
  }

  // ── Never forward raw Anthropic error details to the client ──
  if (!anthropicRes.ok) {
    console.error('Anthropic API error:', anthropicRes.status, data);
    return res.status(anthropicRes.status === 529 ? 529 : 502).json({
      error: 'AI service error. Please try again.',
    });
  }

  return res.status(200).json(data);
}
