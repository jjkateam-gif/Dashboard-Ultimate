const fetch = require('node-fetch');

// Global rate limiter for BloFin API (max 4 req/sec with queue)
const _rateQueue = [];
let _rateTokens = 4;
const _rateMax = 4;
const _rateRefillMs = 250;
let _rateInterval = null;
function _ensureRateInterval() {
  if (_rateInterval) return;
  _rateInterval = setInterval(() => {
    if (_rateTokens < _rateMax) _rateTokens++;
    while (_rateTokens > 0 && _rateQueue.length > 0) {
      _rateTokens--;
      _rateQueue.shift()();
    }
  }, _rateRefillMs);
  if (_rateInterval.unref) _rateInterval.unref();
}
function _waitForRateSlot() {
  _ensureRateInterval();
  if (_rateTokens > 0) { _rateTokens--; return Promise.resolve(); }
  return new Promise(resolve => _rateQueue.push(resolve));
}

const cache = new Map();
const CACHE_TTL = 55000; // 55 seconds

// BloFin instId mapping: BTCUSDT → BTC-USDT
function toBlofinInstId(symbol) {
  // Handle common patterns: BTCUSDT → BTC-USDT, SOLUSDT → SOL-USDT
  const base = symbol.replace(/USDT$/, '');
  return `${base}-USDT`;
}

// BloFin timeframe mapping: our format → BloFin bar format
const BLOFIN_BAR_MAP = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6H', '12h': '12H',
  '1d': '1D', '3d': '3D', '1w': '1W',
};

// Primary: BloFin public API (works from any server, no geo restrictions)
async function fetchKlinesBloFin(symbol, interval, limit) {
  const instId = toBlofinInstId(symbol);
  const bar = BLOFIN_BAR_MAP[interval] || interval;
  const blofinLimit = Math.min(limit || 200, 300); // BloFin max is 300
  const url = `https://openapi.blofin.com/api/v1/market/candles?instId=${instId}&bar=${bar}&limit=${blofinLimit}`;
  await _waitForRateSlot();
  const resp = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
  if (!resp.ok) throw new Error(`BloFin candles API error: ${resp.status}`);
  const json = await resp.json();
  if (json.code !== '0') throw new Error(`BloFin candles: ${json.msg || json.code}`);

  // BloFin returns: [[timestamp, open, high, low, close, vol, volCurrency, volCurrencyQuote, confirm], ...]
  // Data comes newest-first, so reverse to get oldest-first (like Binance)
  const data = (json.data || []).reverse().map(c => ({
    t: parseInt(c[0]),          // timestamp ms
    o: parseFloat(c[1]),        // open
    h: parseFloat(c[2]),        // high
    l: parseFloat(c[3]),        // low
    c: parseFloat(c[4]),        // close
    v: parseFloat(c[5]) || parseFloat(c[6]) || 0,  // volume (contracts or currency)
    ct: parseInt(c[0]) + 1      // close time (approx)
  }));

  return data;
}

// Fallback: Binance (may fail on US-hosted servers with 451)
async function fetchKlinesBinance(symbol, interval, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Binance API error: ${resp.status}`);
  const raw = await resp.json();

  const data = raw.map(c => ({
    t: c[0],       // open time
    o: parseFloat(c[1]),
    h: parseFloat(c[2]),
    l: parseFloat(c[3]),
    c: parseFloat(c[4]),
    v: parseFloat(c[5]),
    ct: c[6]       // close time
  }));

  return data;
}

// Main fetchKlines: BloFin first, Binance fallback
async function fetchKlines(symbol, interval, limit = 200) {
  const key = `${symbol}_${interval}_${limit}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  let data;
  try {
    // Primary: BloFin (no geo restrictions, works from Railway US servers)
    data = await fetchKlinesBloFin(symbol, interval, limit);
  } catch (blofinErr) {
    console.warn(`[Klines] BloFin failed for ${symbol} ${interval}: ${blofinErr.message} — trying Binance...`);
    try {
      data = await fetchKlinesBinance(symbol, interval, limit);
    } catch (binanceErr) {
      throw new Error(`Both APIs failed for ${symbol} ${interval}: BloFin(${blofinErr.message}), Binance(${binanceErr.message})`);
    }
  }

  cache.set(key, { data, ts: Date.now() });
  return data;
}

module.exports = { fetchKlines };
