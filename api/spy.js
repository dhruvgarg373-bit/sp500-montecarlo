// api/spy.js — Vercel serverless proxy (regime-aware)
//
// WHY THIS EXISTS:
// Alpha Vantage blocks browser requests (CORS). This runs server-side on Vercel,
// fetches full SPY history, slices to requested lookback, and returns a clean
// normalised array — so App.jsx never has to parse raw Alpha Vantage JSON.
//
// QUERY PARAMS:
//   apikey   — Alpha Vantage key (required)
//   lookback — trading sessions: "100" | "365" | "730" | "1825" (default 252)
//
// RESPONSE:
//   { prices: number[], startPrice: number, meta: { ... } }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { apikey, lookback } = req.query;

  // ── Validate ────────────────────────────────────────────────────────────
  if (!apikey || !apikey.trim()) {
    return res.status(400).json({
      error: 'Missing apikey parameter. Get a free key at alphavantage.co',
    });
  }

  // Map lookback label → number of trading sessions to keep (slice newest N)
  const LOOKBACK_MAP = {
    '100':  100,   // ~5 months  — current regime only
    '365':  365,   // ~1.4 years — medium term
    '730':  730,   // ~2.9 years — includes 2022 rate shock
    '1825': 1825,  // ~7.2 years — includes COVID + full bull run
  };
  const sessionCount = LOOKBACK_MAP[String(lookback)] || 252;

  // ── Fetch from Alpha Vantage ─────────────────────────────────────────────
  // IMPORTANT: outputsize=full returns 20+ years. "compact" only returns 100.
  // We always fetch full and slice server-side so the user can choose any window.
  const AV_URL = [
    'https://www.alphavantage.co/query',
    '?function=TIME_SERIES_DAILY_ADJUSTED',
    '&symbol=SPY',
    '&outputsize=full',
    `&apikey=${encodeURIComponent(apikey.trim())}`,
  ].join('');

  let raw;
  try {
    const response = await fetch(AV_URL, {
      headers: { 'User-Agent': 'sp500-montecarlo/2.0' },
    });
    if (!response.ok) {
      return res.status(502).json({
        error: `Alpha Vantage HTTP error ${response.status}. Try again in a moment.`,
      });
    }
    raw = await response.json();
  } catch (err) {
    return res.status(502).json({
      error: `Network error reaching Alpha Vantage: ${err.message}`,
    });
  }

  // ── Surface Alpha Vantage API errors ─────────────────────────────────────
  if (raw['Note']) {
    return res.status(429).json({
      error: 'Alpha Vantage rate limit (5 calls/min on free tier). Wait 60s and retry.',
    });
  }
  if (raw['Information'] && raw['Information'].includes('premium')) {
    return res.status(429).json({
      error: "Alpha Vantage daily limit reached (25 calls/day on free tier). Try again tomorrow or use Demo Mode.",
    });
  }
  if (raw['Error Message']) {
    return res.status(401).json({
      error: `Alpha Vantage rejected key: ${raw['Error Message']}`,
    });
  }

  const timeSeries = raw['Time Series (Daily)'];
  if (!timeSeries || typeof timeSeries !== 'object') {
    return res.status(502).json({
      error: 'Alpha Vantage returned no price data. Verify your API key is active.',
    });
  }

  // ── Normalise data ────────────────────────────────────────────────────────
  // Keys are "YYYY-MM-DD" strings — lexicographic sort = chronological for ISO dates.
  // Sort ascending (oldest first), then slice the last N sessions.
  const allDates    = Object.keys(timeSeries).sort();
  const slicedDates = allDates.slice(-sessionCount);

  const prices = [];
  for (const date of slicedDates) {
    const val = parseFloat(timeSeries[date]['5. adjusted close']);
    if (isNaN(val) || val <= 0) {
      return res.status(502).json({
        error: `Unexpected price value on ${date}. Alpha Vantage data may be malformed.`,
      });
    }
    prices.push(val);
  }

  if (prices.length < 30) {
    return res.status(502).json({
      error: `Only ${prices.length} sessions available — not enough to calibrate models reliably. Try a longer lookback.`,
    });
  }

  return res.status(200).json({
    prices,                               // chronological adjusted close prices
    startPrice: prices[prices.length - 1], // S₀ = most recent adjusted close
    meta: {
      sessionsReturned:  prices.length,
      totalAvailable:    allDates.length,
      oldestDate:        slicedDates[0],
      newestDate:        slicedDates[slicedDates.length - 1],
      source:            `Alpha Vantage SPY (full history, sliced to ${prices.length} sessions)`,
    },
  });
}
