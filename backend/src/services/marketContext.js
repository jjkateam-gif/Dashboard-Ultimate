/**
 * Market Context Service
 * Fetches and caches macro market data from free APIs:
 * - Alternative.me Fear & Greed Index
 * - CoinGecko global market stats
 * - Deribit BTC DVOL (volatility index)
 * - BTC trend context (computed from BTC candles)
 *
 * All data is cached with appropriate TTLs to respect rate limits.
 */
const fetch = require('node-fetch');
const { fetchKlines } = require('./binance');
const { ema, rsi, sma } = require('./indicators');

// ══════════════════════════════════════════════════════════════
// CACHE STRUCTURE — each source has its own TTL
// ══════════════════════════════════════════════════════════════
const cache = {
  fearGreed: { data: null, ts: 0, ttl: 30 * 60_000 },       // 30 min (API updates every ~8h)
  globalStats: { data: null, ts: 0, ttl: 10 * 60_000 },      // 10 min
  deribitDvol: { data: null, ts: 0, ttl: 15 * 60_000 },      // 15 min
  btcContext: { data: null, ts: 0, ttl: 5 * 60_000 },         // 5 min (computed from candles)
};

function isFresh(entry) {
  return entry.data && (Date.now() - entry.ts < entry.ttl);
}

// ══════════════════════════════════════════════════════════════
// 1. ALTERNATIVE.ME — Fear & Greed Index
// Free, no auth, ~30 req/min limit
// ══════════════════════════════════════════════════════════════
async function fetchFearGreed() {
  if (isFresh(cache.fearGreed)) return cache.fearGreed.data;
  try {
    const resp = await fetch('https://api.alternative.me/fng/?limit=2&format=json', { timeout: 8000 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    const entries = json.data || [];
    if (entries.length === 0) throw new Error('No data');

    const current = entries[0];
    const previous = entries[1] || current;
    const result = {
      value: parseInt(current.value),                          // 0-100
      label: current.value_classification,                     // e.g. "Fear", "Greed", "Extreme Fear"
      previousValue: parseInt(previous.value),
      change: parseInt(current.value) - parseInt(previous.value),
      timestamp: parseInt(current.timestamp) * 1000,
    };
    cache.fearGreed = { data: result, ts: Date.now(), ttl: cache.fearGreed.ttl };
    console.log(`[MarketCtx] Fear & Greed: ${result.value} (${result.label}), change: ${result.change > 0 ? '+' : ''}${result.change}`);
    return result;
  } catch (e) {
    console.warn(`[MarketCtx] Fear & Greed fetch failed: ${e.message}`);
    return cache.fearGreed.data; // return stale if available
  }
}

// ══════════════════════════════════════════════════════════════
// 2. COINGECKO — Global market stats (free tier: 10-30 req/min)
// ══════════════════════════════════════════════════════════════
async function fetchGlobalStats() {
  if (isFresh(cache.globalStats)) return cache.globalStats.data;
  try {
    const resp = await fetch('https://api.coingecko.com/api/v3/global', { timeout: 8000 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    const d = json.data || {};

    const result = {
      totalMarketCap: d.total_market_cap?.usd || null,
      totalVolume24h: d.total_volume?.usd || null,
      btcDominance: d.market_cap_percentage?.btc != null ? Math.round(d.market_cap_percentage.btc * 100) / 100 : null,
      ethDominance: d.market_cap_percentage?.eth != null ? Math.round(d.market_cap_percentage.eth * 100) / 100 : null,
      altcoinMarketCap: d.total_market_cap?.usd && d.market_cap_percentage?.btc
        ? Math.round(d.total_market_cap.usd * (1 - d.market_cap_percentage.btc / 100))
        : null,
      marketCapChangePct24h: d.market_cap_change_percentage_24h_usd != null
        ? Math.round(d.market_cap_change_percentage_24h_usd * 100) / 100 : null,
      activeCryptos: d.active_cryptocurrencies || null,
    };
    cache.globalStats = { data: result, ts: Date.now(), ttl: cache.globalStats.ttl };
    console.log(`[MarketCtx] CoinGecko global: BTC dom ${result.btcDominance}%, MCap change ${result.marketCapChangePct24h}%`);
    return result;
  } catch (e) {
    console.warn(`[MarketCtx] CoinGecko global fetch failed: ${e.message}`);
    return cache.globalStats.data;
  }
}

// ══════════════════════════════════════════════════════════════
// 3. DERIBIT — BTC DVOL (Crypto VIX, public, no auth needed)
// ══════════════════════════════════════════════════════════════
async function fetchDeribitDvol() {
  if (isFresh(cache.deribitDvol)) return cache.deribitDvol.data;
  try {
    const resp = await fetch('https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&resolution=3600&start_timestamp=' + (Date.now() - 4 * 3600_000) + '&end_timestamp=' + Date.now(), { timeout: 8000 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    const points = json.result?.data || [];
    if (points.length === 0) throw new Error('No DVOL data');

    // Points are [timestamp, open, high, low, close]
    const latest = points[points.length - 1];
    const prev = points.length >= 2 ? points[points.length - 2] : latest;
    const result = {
      dvol: Math.round(latest[4] * 100) / 100,               // latest close
      dvolHigh: Math.round(latest[2] * 100) / 100,
      dvolLow: Math.round(latest[3] * 100) / 100,
      dvolPrev: Math.round(prev[4] * 100) / 100,
      dvolChange: Math.round((latest[4] - prev[4]) * 100) / 100,
      dvolLevel: latest[4] > 80 ? 'extreme_high' : latest[4] > 60 ? 'high' : latest[4] > 40 ? 'moderate' : latest[4] > 25 ? 'low' : 'extreme_low',
    };
    cache.deribitDvol = { data: result, ts: Date.now(), ttl: cache.deribitDvol.ttl };
    console.log(`[MarketCtx] Deribit DVOL: ${result.dvol} (${result.dvolLevel}), change: ${result.dvolChange > 0 ? '+' : ''}${result.dvolChange}`);
    return result;
  } catch (e) {
    console.warn(`[MarketCtx] Deribit DVOL fetch failed: ${e.message}`);
    return cache.deribitDvol.data;
  }
}

// ══════════════════════════════════════════════════════════════
// 4. BTC CONTEXT — Computed from BTC candles (1h + 4h + 1d)
// Provides macro trend context for all altcoin trades
// ══════════════════════════════════════════════════════════════
async function fetchBtcContext() {
  if (isFresh(cache.btcContext)) return cache.btcContext.data;
  try {
    // Fetch BTC candles on 1h and 4h
    const [candles1h, candles4h] = await Promise.all([
      fetchKlines('BTCUSDT', '1h', 200),
      fetchKlines('BTCUSDT', '4h', 100),
    ]);

    const result = {};

    // 1h analysis
    if (candles1h && candles1h.length >= 50) {
      const closes1h = candles1h.map(c => c.c);
      const ema20_1h = ema(closes1h, 20);
      const ema50_1h = ema(closes1h, 50);
      const rsi14_1h = rsi(closes1h, 14);
      const last = closes1h.length - 1;

      result.btc_price = closes1h[last];
      result.btc_ema20_1h = ema20_1h[last] != null ? Math.round(ema20_1h[last] * 100) / 100 : null;
      result.btc_ema50_1h = ema50_1h[last] != null ? Math.round(ema50_1h[last] * 100) / 100 : null;
      result.btc_above_ema20_1h = ema20_1h[last] != null ? closes1h[last] > ema20_1h[last] : null;
      result.btc_above_ema50_1h = ema50_1h[last] != null ? closes1h[last] > ema50_1h[last] : null;
      result.btc_rsi_1h = rsi14_1h[last] != null ? Math.round(rsi14_1h[last] * 100) / 100 : null;
      result.btc_ema_trend_1h = ema20_1h[last] > ema50_1h[last] ? 'bullish' : 'bearish';

      // MACD on 1h
      const ema12 = ema(closes1h, 12);
      const ema26 = ema(closes1h, 26);
      if (ema12[last] != null && ema26[last] != null) {
        const macdLine = ema12[last] - ema26[last];
        const macdPrev = (ema12[last - 1] || 0) - (ema26[last - 1] || 0);
        result.btc_macd_1h = Math.round(macdLine * 100) / 100;
        result.btc_macd_bull_1h = macdLine > 0;
        result.btc_macd_expanding_1h = Math.abs(macdLine) > Math.abs(macdPrev);
      }
    }

    // 4h analysis
    if (candles4h && candles4h.length >= 50) {
      const closes4h = candles4h.map(c => c.c);
      const ema20_4h = ema(closes4h, 20);
      const ema50_4h = ema(closes4h, 50);
      const ema200_4h = ema(closes4h, 200);
      const rsi14_4h = rsi(closes4h, 14);
      const last = closes4h.length - 1;

      result.btc_ema20_4h = ema20_4h[last] != null ? Math.round(ema20_4h[last] * 100) / 100 : null;
      result.btc_ema50_4h = ema50_4h[last] != null ? Math.round(ema50_4h[last] * 100) / 100 : null;
      result.btc_above_ema20_4h = ema20_4h[last] != null ? closes4h[last] > ema20_4h[last] : null;
      result.btc_above_ema50_4h = ema50_4h[last] != null ? closes4h[last] > ema50_4h[last] : null;
      result.btc_rsi_4h = rsi14_4h[last] != null ? Math.round(rsi14_4h[last] * 100) / 100 : null;
      result.btc_ema_trend_4h = ema20_4h[last] > ema50_4h[last] ? 'bullish' : 'bearish';
      // EMA200 — may not be available with only 100 candles but try
      if (ema200_4h[last] != null) {
        result.btc_above_ema200_4h = closes4h[last] > ema200_4h[last];
      }

      // 4h MACD
      const ema12_4h = ema(closes4h, 12);
      const ema26_4h = ema(closes4h, 26);
      if (ema12_4h[last] != null && ema26_4h[last] != null) {
        const macdLine = ema12_4h[last] - ema26_4h[last];
        result.btc_macd_4h = Math.round(macdLine * 100) / 100;
        result.btc_macd_bull_4h = macdLine > 0;
      }

      // Overall BTC trend classification
      const bullSignals = [
        result.btc_above_ema20_1h, result.btc_above_ema50_1h,
        result.btc_macd_bull_1h,
        result.btc_above_ema20_4h, result.btc_above_ema50_4h,
        result.btc_macd_bull_4h,
      ].filter(v => v === true).length;
      const bearSignals = [
        result.btc_above_ema20_1h === false, result.btc_above_ema50_1h === false,
        result.btc_macd_bull_1h === false,
        result.btc_above_ema20_4h === false, result.btc_above_ema50_4h === false,
        result.btc_macd_bull_4h === false,
      ].filter(v => v === true).length;

      result.btc_trend = bullSignals >= 5 ? 'strong_bull' : bullSignals >= 3 ? 'bull'
        : bearSignals >= 5 ? 'strong_bear' : bearSignals >= 3 ? 'bear' : 'neutral';
      result.btc_bull_score = bullSignals;
      result.btc_bear_score = bearSignals;
    }

    cache.btcContext = { data: result, ts: Date.now(), ttl: cache.btcContext.ttl };
    console.log(`[MarketCtx] BTC context: $${result.btc_price}, trend=${result.btc_trend}, RSI1h=${result.btc_rsi_1h}, RSI4h=${result.btc_rsi_4h}`);
    return result;
  } catch (e) {
    console.warn(`[MarketCtx] BTC context fetch failed: ${e.message}`);
    return cache.btcContext.data;
  }
}

// ══════════════════════════════════════════════════════════════
// COMBINED FETCH — call once per scan cycle, returns all context
// ══════════════════════════════════════════════════════════════
async function fetchAllMarketContext() {
  // Fetch all sources in parallel — each has its own error handling
  const [fearGreed, globalStats, deribitDvol, btcContext] = await Promise.all([
    fetchFearGreed(),
    fetchGlobalStats(),
    fetchDeribitDvol(),
    fetchBtcContext(),
  ]);

  return {
    fearGreed: fearGreed || {},
    globalStats: globalStats || {},
    deribitDvol: deribitDvol || {},
    btcContext: btcContext || {},
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = {
  fetchFearGreed,
  fetchGlobalStats,
  fetchDeribitDvol,
  fetchBtcContext,
  fetchAllMarketContext,
};
