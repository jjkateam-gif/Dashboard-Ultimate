const fetch = require('node-fetch');

const cache = new Map();
const CACHE_TTL = 55000; // 55 seconds

async function fetchKlines(symbol, interval, limit = 1000) {
  const key = `${symbol}_${interval}_${limit}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

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

  cache.set(key, { data, ts: Date.now() });
  return data;
}

module.exports = { fetchKlines };
