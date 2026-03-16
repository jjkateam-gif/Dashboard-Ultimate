/**
 * Liquidation Risk Indicator
 * Calculates a 0-100 risk score for crypto liquidation cascades
 *
 * Components:
 * 1. Funding Rate Score (25%) — extreme funding = overleveraged market
 * 2. OI Change Velocity (25%) — rapid OI growth without volume = danger
 * 3. Long/Short Ratio Skew (20%) — one-sided positioning = flush risk
 * 4. Price Deviation from MA (15%) — extended moves revert
 * 5. Consecutive Candle Direction (15%) — too many green/red = mean reversion due
 */

const fetch = require('node-fetch');

// Cache to avoid hammering APIs
const cache = {
  data: null,
  ts: 0,
  ttl: 5 * 60 * 1000, // 5 minute cache
};

// ── Fetch BloFin funding rates for top assets ──
async function fetchFundingRates() {
  const assets = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'XRP-USDT', 'DOGE-USDT'];
  const rates = [];

  for (const instId of assets) {
    try {
      const resp = await fetch(`https://openapi.blofin.com/api/v1/market/funding-rate?instId=${instId}`);
      if (!resp.ok) continue;
      const json = await resp.json();
      if (json.code === '0' && json.data && json.data.length > 0) {
        rates.push({
          asset: instId,
          rate: parseFloat(json.data[0].fundingRate),
          nextRate: parseFloat(json.data[0].nextFundingRate) || null,
        });
      }
    } catch (e) {
      console.warn(`[LiqRisk] Funding rate fetch failed for ${instId}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 100)); // rate limit
  }

  return rates;
}

// ── Fetch BloFin tickers for OI proxy (volume analysis) ──
async function fetchTickers() {
  try {
    const resp = await fetch('https://openapi.blofin.com/api/v1/market/tickers');
    if (!resp.ok) throw new Error(`Tickers API error: ${resp.status}`);
    const json = await resp.json();
    if (json.code !== '0') throw new Error(json.msg);

    // Get top assets
    const top = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'XRP-USDT', 'DOGE-USDT'];
    return (json.data || []).filter(t => top.includes(t.instId));
  } catch (e) {
    console.warn('[LiqRisk] Tickers fetch failed:', e.message);
    return [];
  }
}

// ── Fetch recent candles for consecutive direction analysis ──
async function fetchRecentCandles(instId, bar, limit) {
  try {
    const resp = await fetch(`https://openapi.blofin.com/api/v1/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`);
    if (!resp.ok) throw new Error(`Candles error: ${resp.status}`);
    const json = await resp.json();
    if (json.code !== '0') throw new Error(json.msg);
    return (json.data || []).reverse().map(c => ({
      o: parseFloat(c[1]), h: parseFloat(c[2]),
      l: parseFloat(c[3]), c: parseFloat(c[4]),
      v: parseFloat(c[5]) || 0,
    }));
  } catch (e) {
    return [];
  }
}

// ── Score Component 1: Funding Rate (25%) ──
function scoreFundingRate(rates) {
  if (rates.length === 0) return { score: 30, detail: 'No data' };

  // Average absolute funding rate across top assets
  const avgRate = rates.reduce((s, r) => s + Math.abs(r.rate), 0) / rates.length;
  const maxRate = Math.max(...rates.map(r => Math.abs(r.rate)));

  // Direction: positive = longs paying shorts (long-heavy), negative = shorts paying longs
  const avgSigned = rates.reduce((s, r) => s + r.rate, 0) / rates.length;
  const direction = avgSigned > 0 ? 'long-heavy' : 'short-heavy';

  // Scoring (8h funding rate thresholds)
  let score;
  if (avgRate < 0.0001) score = 5;        // ~0.01% — very neutral
  else if (avgRate < 0.0003) score = 15;   // ~0.03% — mild
  else if (avgRate < 0.0005) score = 35;   // ~0.05% — elevated
  else if (avgRate < 0.001) score = 60;    // ~0.10% — high
  else if (avgRate < 0.003) score = 80;    // ~0.30% — very high
  else score = 95;                          // >0.30% — extreme

  return {
    score,
    avgRate: (avgRate * 100).toFixed(4) + '%',
    maxRate: (maxRate * 100).toFixed(4) + '%',
    direction,
    detail: `Avg: ${(avgRate * 100).toFixed(4)}% (${direction})`,
  };
}

// ── Score Component 2: OI Velocity via Volume (25%) ──
function scoreOIVelocity(candles24h, candles7d) {
  if (candles24h.length < 2 || candles7d.length < 5) return { score: 30, detail: 'Insufficient data' };

  // Compare recent 24h volume to 7d average
  const vol24h = candles24h.slice(-6).reduce((s, c) => s + c.v, 0); // last 6 4h candles = 24h
  const vol7d = candles7d.reduce((s, c) => s + c.v, 0);
  const avgVol24h = vol7d / (candles7d.length / 6); // normalized to 24h equivalent

  const volRatio = avgVol24h > 0 ? vol24h / avgVol24h : 1;

  // High volume with strong directional move = potential OI buildup
  // Low volume with price rise = leveraged rally (dangerous)
  const priceChange = candles24h.length >= 2
    ? (candles24h[candles24h.length - 1].c - candles24h[0].o) / candles24h[0].o * 100
    : 0;

  let score;
  if (Math.abs(priceChange) > 5 && volRatio < 0.7) {
    // Big move on LOW volume = leveraged, dangerous
    score = 75;
  } else if (Math.abs(priceChange) > 8 && volRatio > 1.5) {
    // Big move on HIGH volume = organic but stretched
    score = 55;
  } else if (Math.abs(priceChange) > 3 && volRatio < 0.8) {
    // Moderate move on low volume
    score = 50;
  } else if (volRatio > 2.0) {
    // Volume spike = potential cascade already starting
    score = 65;
  } else {
    score = Math.min(40, Math.round(Math.abs(priceChange) * 5));
  }

  return {
    score,
    volRatio: volRatio.toFixed(2) + 'x',
    priceChange24h: priceChange.toFixed(2) + '%',
    detail: `Vol: ${volRatio.toFixed(2)}x avg, Price: ${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}%`,
  };
}

// ── Score Component 3: Long/Short Skew via Funding Direction (20%) ──
function scoreLongShortSkew(rates) {
  if (rates.length === 0) return { score: 30, detail: 'No data' };

  // Count how many assets have positive (long-heavy) vs negative funding
  const longHeavy = rates.filter(r => r.rate > 0.0001).length;
  const shortHeavy = rates.filter(r => r.rate < -0.0001).length;
  const neutral = rates.length - longHeavy - shortHeavy;

  const skewPct = rates.length > 0 ? Math.max(longHeavy, shortHeavy) / rates.length * 100 : 50;
  const dominantSide = longHeavy > shortHeavy ? 'LONG' : shortHeavy > longHeavy ? 'SHORT' : 'BALANCED';

  let score;
  if (skewPct <= 40) score = 10;       // Balanced
  else if (skewPct <= 60) score = 25;   // Mild skew
  else if (skewPct <= 80) score = 50;   // Moderate skew
  else score = 75;                       // Extreme one-sided

  // Amplify if ALL assets skewed same way
  if (longHeavy === rates.length || shortHeavy === rates.length) score = Math.min(95, score + 20);

  return {
    score,
    longHeavy,
    shortHeavy,
    neutral,
    dominantSide,
    detail: `${longHeavy}L/${shortHeavy}S/${neutral}N — ${dominantSide}`,
  };
}

// ── Score Component 4: Price Deviation from 20-period MA (15%) ──
function scorePriceDeviation(candles) {
  if (candles.length < 20) return { score: 30, detail: 'Insufficient data' };

  const closes = candles.map(c => c.c);
  const ma20 = closes.slice(-20).reduce((s, c) => s + c, 0) / 20;
  const last = closes[closes.length - 1];
  const devPct = ((last - ma20) / ma20) * 100;
  const absdev = Math.abs(devPct);

  let score;
  if (absdev < 2) score = 5;
  else if (absdev < 5) score = 20;
  else if (absdev < 10) score = 40;
  else if (absdev < 15) score = 60;
  else if (absdev < 25) score = 80;
  else score = 95;

  return {
    score,
    deviation: (devPct >= 0 ? '+' : '') + devPct.toFixed(2) + '%',
    detail: `${(devPct >= 0 ? '+' : '')}${devPct.toFixed(2)}% from 20-period MA`,
  };
}

// ── Score Component 5: Consecutive Candle Direction (15%) ──
function scoreConsecutiveDirection(candles) {
  if (candles.length < 5) return { score: 20, detail: 'Insufficient data' };

  // Count consecutive green or red candles from the end
  let consecutive = 0;
  const lastDir = candles[candles.length - 1].c >= candles[candles.length - 1].o ? 'green' : 'red';

  for (let i = candles.length - 1; i >= 0; i--) {
    const dir = candles[i].c >= candles[i].o ? 'green' : 'red';
    if (dir === lastDir) consecutive++;
    else break;
  }

  let score;
  if (consecutive <= 2) score = 5;
  else if (consecutive <= 4) score = 20;
  else if (consecutive <= 6) score = 45;
  else if (consecutive <= 8) score = 70;
  else score = 90;

  return {
    score,
    consecutive,
    direction: lastDir === 'green' ? 'UP' : 'DOWN',
    detail: `${consecutive} consecutive ${lastDir} candles`,
  };
}

// ══════════════════════════════════════════════════════════
// MAIN: Calculate Liquidation Risk Score
// ══════════════════════════════════════════════════════════
async function calculateLiquidationRisk() {
  // Check cache
  if (cache.data && Date.now() - cache.ts < cache.ttl) {
    return cache.data;
  }

  console.log('[LiqRisk] Calculating liquidation risk score...');

  // Fetch all data in parallel
  const [fundingRates, btcCandles4h, btcCandles1d] = await Promise.all([
    fetchFundingRates(),
    fetchRecentCandles('BTC-USDT', '4H', 42),  // ~7 days of 4h candles
    fetchRecentCandles('BTC-USDT', '1D', 30),   // 30 days of daily candles
  ]);

  // Calculate each component
  const comp1 = scoreFundingRate(fundingRates);
  const comp2 = scoreOIVelocity(btcCandles4h, btcCandles4h);
  const comp3 = scoreLongShortSkew(fundingRates);
  const comp4 = scorePriceDeviation(btcCandles1d);
  const comp5 = scoreConsecutiveDirection(btcCandles1d);

  // Weighted score
  const overallScore = Math.round(
    comp1.score * 0.25 +
    comp2.score * 0.25 +
    comp3.score * 0.20 +
    comp4.score * 0.15 +
    comp5.score * 0.15
  );

  // Risk level
  const riskLevel = overallScore < 20 ? 'LOW' :
    overallScore < 40 ? 'MODERATE' :
    overallScore < 60 ? 'ELEVATED' :
    overallScore < 80 ? 'HIGH' : 'EXTREME';

  const riskColor = overallScore < 20 ? '#00f5a0' :
    overallScore < 40 ? '#00c9ff' :
    overallScore < 60 ? '#ffd60a' :
    overallScore < 80 ? '#ff8c00' : '#ff4d6d';

  const advice = overallScore < 20 ? 'Normal conditions. Trade as usual.' :
    overallScore < 40 ? 'Monitor leverage levels. No immediate risk.' :
    overallScore < 60 ? 'Elevated risk. Reduce leverage, tighten stops.' :
    overallScore < 80 ? 'High risk of cascade. Consider reducing exposure.' :
    'Extreme risk! Liquidation cascade imminent. Minimize directional exposure.';

  const result = {
    score: overallScore,
    riskLevel,
    riskColor,
    advice,
    components: {
      fundingRate: comp1,
      oiVelocity: comp2,
      longShortSkew: comp3,
      priceDeviation: comp4,
      consecutiveDirection: comp5,
    },
    fundingRates: fundingRates.map(r => ({
      asset: r.asset,
      rate: (r.rate * 100).toFixed(4) + '%',
    })),
    timestamp: new Date().toISOString(),
  };

  cache.data = result;
  cache.ts = Date.now();

  console.log(`[LiqRisk] Score: ${overallScore}/100 (${riskLevel})`);
  return result;
}

module.exports = { calculateLiquidationRisk };
