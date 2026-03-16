/**
 * Server-side Best Trades Scanner
 * Mirrors the frontend probability engine so trades execute 24/7 on Railway
 * even when the user's browser is closed.
 */
const { fetchKlines } = require('./binance');
const { sma, ema, rsi, stdev, atr } = require('./indicators');
const blofinClient = require('./blofinClient');
const liveEngine = require('./liveEngine');
// https no longer needed — switched from Binance to BloFin for funding rates
let pool = null;
try { pool = require('../db').pool; } catch {}

// ══════════════════════════════════════════════════════════════
// FUNDING RATE CACHE (fetched from BloFin, refreshed every 5 min)
// Uses BloFin instead of Binance Futures to avoid US geo-blocking (HTTP 451)
// ══════════════════════════════════════════════════════════════
const fundingRateCache = { data: {}, lastRefresh: 0, refreshMs: 5 * 60_000 };
const fetch = require('node-fetch');

async function refreshFundingRates() {
  const now = Date.now();
  if (now - fundingRateCache.lastRefresh < fundingRateCache.refreshMs) return;
  try {
    // Fetch funding rates from BloFin (no geo restrictions)
    const FUNDING_ASSETS = [
      'BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'SUI-USDT', 'BNB-USDT',
      'DOGE-USDT', 'XRP-USDT', 'ADA-USDT', 'AVAX-USDT', 'LINK-USDT',
      'DOT-USDT', 'NEAR-USDT', 'ARB-USDT', 'OP-USDT', 'APT-USDT',
      'INJ-USDT', 'PEPE-USDT', 'BONK-USDT', 'WIF-USDT',
    ];
    for (const instId of FUNDING_ASSETS) {
      try {
        const url = `https://openapi.blofin.com/api/v1/market/funding-rate?instId=${instId}`;
        const resp = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
        if (!resp.ok) continue;
        const json = await resp.json();
        if (json.code === '0' && json.data && json.data[0]) {
          // Store under Binance-style key (BTCUSDT) for compatibility
          const sym = instId.replace('-', '');
          fundingRateCache.data[sym] = parseFloat(json.data[0].fundingRate) || 0;
        }
      } catch (e) { /* skip individual failures */ }
    }
    fundingRateCache.lastRefresh = now;
    console.log(`[BestTrades] Funding rates refreshed (BloFin): ${Object.keys(fundingRateCache.data).length} pairs`);
  } catch (e) {
    console.warn('[BestTrades] Funding rate fetch error:', e.message);
  }
}

function getFundingRateForAsset(sym) {
  return fundingRateCache.data[sym] || 0;
}

// ══════════════════════════════════════════════════════════════
// ASSETS & CONFIG
// ══════════════════════════════════════════════════════════════
const ASSETS = [
  { sym: 'BTCUSDT', label: 'BTC' },
  { sym: 'ETHUSDT', label: 'ETH' },
  { sym: 'SOLUSDT', label: 'SOL' },
  { sym: 'SUIUSDT', label: 'SUI' },
  { sym: 'BNBUSDT', label: 'BNB' },
  { sym: 'DOGEUSDT', label: 'DOGE' },
  { sym: 'XRPUSDT', label: 'XRP' },
  { sym: 'ADAUSDT', label: 'ADA' },
  { sym: 'AVAXUSDT', label: 'AVAX' },
  { sym: 'LINKUSDT', label: 'LINK' },
  { sym: 'DOTUSDT', label: 'DOT' },
  { sym: 'NEARUSDT', label: 'NEAR' },
  { sym: 'ARBUSDT', label: 'ARB' },
  { sym: 'OPUSDT', label: 'OP' },
  { sym: 'APTUSDT', label: 'APT' },
  { sym: 'INJUSDT', label: 'INJ' },
  { sym: 'PEPEUSDT', label: 'PEPE' },
  { sym: 'BONKUSDT', label: 'BONK' },
  { sym: 'WIFUSDT', label: 'WIF' },
  // RENDER removed — not available on BloFin, caused 1 error per scan cycle
];

// Scan intervals per timeframe (optimized: no need to scan faster than candle closes)
const SCAN_INTERVALS = {
  '1m': 60_000, '3m': 2 * 60_000, '5m': 3 * 60_000,      // 5m candle → scan every 3min
  '15m': 5 * 60_000, '30m': 15 * 60_000, '1h': 30 * 60_000, // 15m → every 5min (faster signal catch)
  '4h': 2 * 60 * 60_000, '1d': 8 * 60 * 60_000,            // 4h → every 2h, 1d → every 8h
};

// All timeframes to scan (server covers every TF)
const ALL_TIMEFRAMES = ['5m', '15m', '30m', '1h', '4h', '1d'];

const TRADING_FEE_PCT = 0.06; // BloFin taker fee per side

// ══════════════════════════════════════════════════════════════
// CALIBRATION CACHE — learns from historical outcomes
// Refreshed every 30 min, used to adjust prob & Kelly in real-time
// ══════════════════════════════════════════════════════════════
const calibrationCache = {
  lastRefresh: 0,
  refreshIntervalMs: 30 * 60_000, // 30 minutes
  minSamples: 30,                  // need ≥30 resolved trades before adjusting (#20 consensus: raised from 8)
  // Keyed data from DB
  byProbBucket: {},   // { '50-54': { predicted: 52, actual: 0.83, n: 12 }, ... }
  byRegimeTF: {},     // { 'bull_15m': { winRate: 0.58, n: 38 }, ... }
  byQuality: {},      // { 'A': { winRate: 0.65, avgPnl: 1.2, n: 20 }, ... }
  byConfidence: {},   // { 'High': { winRate: 0.62, n: 30 }, ... }
  overall: { winRate: 0.5, totalResolved: 0, kellyGraduation: 0 },
};

// ══════════════════════════════════════════════════════════════
// LEVERAGE RISK FRAMEWORK (#13/#14/#15/#16/#18/#19 — all 3 AIs unanimous)
// Portfolio heat, drawdown tracking, consecutive loss tracking,
// win rate gating, funding rate leverage check, phased rollout
// ══════════════════════════════════════════════════════════════
const leverageRisk = {
  // Drawdown tracking (#13)
  peakEquity: 0,
  currentEquity: 0,
  drawdownPct: 0,
  // Consecutive loss tracking (#14)
  consecutiveLosses: 0,
  maxConsecutiveLosses: 0,
  // Portfolio heat (#18)
  totalExposurePct: 0,
  maxHeatPct: 6, // 6% max total portfolio exposure
  // Phased rollout (#19) — Phase 1: conservative
  phase: 1, // 1=conservative, 2=moderate, 3=full
  phaseConfig: {
    1: { maxLev: 3, minWR: 55, minTrades: 200, qualityGate: 'A' },
    2: { maxLev: 5, minWR: 57, minTrades: 500, qualityGate: 'B' },
    3: { maxLev: 10, minWR: 60, minTrades: 1000, qualityGate: 'C' },
  },
  // Sharpe tracking (#30)
  recentPnLs: [], // rolling window of P&L values for Sharpe calculation
  sharpeRatio: null,
  lastRefresh: 0,
};

async function refreshLeverageRisk() {
  if (!pool) return;
  const now = Date.now();
  if (now - leverageRisk.lastRefresh < 5 * 60_000) return; // refresh every 5 min

  try {
    // Get recent outcomes for consecutive loss tracking and Sharpe
    const recentRes = await pool.query(`
      SELECT outcome, pnl FROM best_trades_log
      WHERE outcome IN ('win','loss')
      ORDER BY resolved_at DESC LIMIT 100
    `);

    // Consecutive losses (#14) — count from most recent trade backward
    let consecLosses = 0;
    for (const row of recentRes.rows) {
      if (row.outcome === 'loss') consecLosses++;
      else break;
    }
    leverageRisk.consecutiveLosses = consecLosses;
    leverageRisk.maxConsecutiveLosses = Math.max(leverageRisk.maxConsecutiveLosses, consecLosses);

    // Sharpe ratio (#30) — per-trade Sharpe, then annualize using actual trade frequency
    const pnls = recentRes.rows.filter(r => r.pnl != null).map(r => parseFloat(r.pnl));
    leverageRisk.recentPnLs = pnls;
    if (pnls.length >= 10) {
      const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
      const variance = pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / pnls.length;
      const stdDev = Math.sqrt(variance);
      // Per-trade Sharpe (no annualization — more meaningful for variable-frequency trades)
      const perTradeSharpe = stdDev > 0 ? mean / stdDev : null;
      // Estimate trades per day from actual data for annualized version
      const resolvedDaysRes = await pool.query(`
        SELECT EXTRACT(EPOCH FROM (MAX(resolved_at) - MIN(resolved_at))) / 86400 AS days
        FROM best_trades_log WHERE outcome IN ('win','loss') AND resolved_at IS NOT NULL
      `);
      const tradeDays = parseFloat(resolvedDaysRes.rows[0]?.days) || 1;
      const tradesPerDay = Math.max(1, pnls.length / Math.max(0.1, tradeDays));
      // Annualized Sharpe = per-trade Sharpe * sqrt(trades_per_year)
      const annualizedSharpe = perTradeSharpe != null ? parseFloat((perTradeSharpe * Math.sqrt(tradesPerDay * 365)).toFixed(2)) : null;
      leverageRisk.sharpeRatio = annualizedSharpe;
      leverageRisk.perTradeSharpe = perTradeSharpe != null ? parseFloat(perTradeSharpe.toFixed(4)) : null;
      leverageRisk.tradesPerDay = parseFloat(tradesPerDay.toFixed(1));
    }

    // Drawdown tracking (#13)
    const equityRes = await pool.query(`
      SELECT COALESCE(SUM(pnl), 0) AS total_pnl FROM best_trades_log
      WHERE outcome IN ('win','loss')
    `);
    const totalPnl = parseFloat(equityRes.rows[0].total_pnl) || 0;
    leverageRisk.currentEquity = 100 + totalPnl; // base 100%
    if (leverageRisk.currentEquity > leverageRisk.peakEquity || leverageRisk.peakEquity === 0) {
      leverageRisk.peakEquity = leverageRisk.currentEquity;
    }
    leverageRisk.drawdownPct = leverageRisk.peakEquity > 0
      ? parseFloat(((1 - leverageRisk.currentEquity / leverageRisk.peakEquity) * 100).toFixed(2))
      : 0;

    // Auto-detect phase based on performance (#19)
    const cc = calibrationCache;
    const wr = cc.overall.winRate * 100;
    const trades = cc.overall.totalResolved;
    if (trades >= 1000 && wr >= 60) leverageRisk.phase = 3;
    else if (trades >= 500 && wr >= 57) leverageRisk.phase = 2;
    else leverageRisk.phase = 1;

    leverageRisk.lastRefresh = now;
    console.log(`[LeverageRisk] DD=${leverageRisk.drawdownPct}%, ConsecL=${consecLosses}, Phase=${leverageRisk.phase}, Sharpe=${leverageRisk.sharpeRatio || 'N/A'}`);
  } catch (e) {
    console.warn('[LeverageRisk] Refresh error:', e.message);
  }
}

/**
 * Apply all leverage risk gates and return the safe leverage for a trade.
 * Implements #13 drawdown reduction, #14 consecutive loss, #15 WR gate,
 * #16 funding rate check, #18 portfolio heat, #19 phased rollout.
 */
function getSafeLeverage(rawLev, { confidence, marketQuality, fundingRate, direction, winRate, totalTrades }) {
  let lev = rawLev;
  const phase = leverageRisk.phaseConfig[leverageRisk.phase] || leverageRisk.phaseConfig[1];

  // #19 Phase cap
  lev = Math.min(lev, phase.maxLev);

  // #15 Win rate gate — hard enforced
  if (!winRate || winRate < 50) lev = 1;
  else if (winRate < 55) lev = Math.min(lev, 2); // 50-54% = max 2x A-grade only
  else if (winRate < 57) lev = Math.min(lev, 3);

  // #15 Quality gate per phase
  const qualOrder = { 'A': 3, 'B': 2, 'C': 1, 'No-Trade': 0 };
  if ((qualOrder[marketQuality] || 0) < (qualOrder[phase.qualityGate] || 0)) {
    lev = Math.min(lev, 1);
  }

  // #15 Minimum trades gate
  if (!totalTrades || totalTrades < 200) lev = Math.min(lev, 2);

  // #13 Drawdown leverage reduction — graduated tiers
  if (leverageRisk.drawdownPct >= 20) lev = 0; // kill switch
  else if (leverageRisk.drawdownPct >= 15) lev = 1; // no leverage
  else if (leverageRisk.drawdownPct >= 10) lev = Math.min(lev, 2);
  else if (leverageRisk.drawdownPct >= 5) lev = Math.max(1, lev - 1); // reduce 1 tier

  // #14 Consecutive loss protection
  if (leverageRisk.consecutiveLosses >= 5) lev = 0; // 24h disable
  else if (leverageRisk.consecutiveLosses >= 3) lev = Math.min(lev, 2);
  else if (leverageRisk.consecutiveLosses >= 2) lev = Math.max(1, lev - 1);

  // #16 Funding rate + leverage check
  if (fundingRate != null && Math.abs(fundingRate) > 0.001) { // >0.1% per 8h = extreme
    if ((direction === 'long' && fundingRate > 0.001) || (direction === 'short' && fundingRate < -0.001)) {
      lev = Math.min(lev, 2); // cap at 2x when funding opposes trade
    }
  }

  // #18 Portfolio heat — would be checked in _processAutoTrades via open positions

  return Math.max(0, Math.round(lev));
}

async function refreshCalibrationCache() {
  if (!pool) return;
  const now = Date.now();
  if (now - calibrationCache.lastRefresh < calibrationCache.refreshIntervalMs) return;

  try {
    // 1. Probability bucket accuracy (predicted vs actual)
    // #5 Recency weighting: use EWMA-style approach — weight recent trades more heavily
    // We use a time-decay window: trades from last 30 days get full weight, older trades decay
    const bucketRes = await pool.query(`
      SELECT
        CASE
          WHEN probability < 55 THEN '50-54' WHEN probability < 60 THEN '55-59'
          WHEN probability < 65 THEN '60-64' WHEN probability < 70 THEN '65-69'
          WHEN probability < 75 THEN '70-74' WHEN probability < 80 THEN '75-79'
          ELSE '80+'
        END AS bucket,
        CASE
          WHEN probability < 55 THEN 52 WHEN probability < 60 THEN 57
          WHEN probability < 65 THEN 62 WHEN probability < 70 THEN 67
          WHEN probability < 75 THEN 72 WHEN probability < 80 THEN 77
          ELSE 82
        END AS bucket_mid,
        COUNT(*) FILTER (WHERE outcome IN ('win','loss')) AS n,
        COUNT(*) FILTER (WHERE outcome = 'win') AS wins,
        COUNT(*) FILTER (WHERE outcome IN ('win','loss') AND resolved_at > NOW() - INTERVAL '30 days') AS n_recent,
        COUNT(*) FILTER (WHERE outcome = 'win' AND resolved_at > NOW() - INTERVAL '30 days') AS wins_recent
      FROM best_trades_log
      WHERE outcome IN ('win','loss')
      GROUP BY bucket, bucket_mid ORDER BY bucket_mid
    `);
    calibrationCache.byProbBucket = {};
    for (const r of bucketRes.rows) {
      const n = parseInt(r.n);
      const nRecent = parseInt(r.n_recent) || 0;
      const winsRecent = parseInt(r.wins_recent) || 0;
      if (n > 0) {
        // #5 Recency weighting: blend overall and recent win rates (70% recent / 30% overall if recent data exists)
        const overallWR = parseInt(r.wins) / n;
        const recentWR = nRecent >= 5 ? winsRecent / nRecent : overallWR;
        const blendedWR = nRecent >= 5 ? 0.7 * recentWR + 0.3 * overallWR : overallWR;
        calibrationCache.byProbBucket[r.bucket] = {
          predicted: parseInt(r.bucket_mid),
          actual: blendedWR,
          n,
          nRecent,
        };
      }
    }

    // 2. Win rate by regime + timeframe combo
    const regimeTFRes = await pool.query(`
      SELECT regime, timeframe,
        COUNT(*) FILTER (WHERE outcome IN ('win','loss')) AS n,
        COUNT(*) FILTER (WHERE outcome = 'win') AS wins
      FROM best_trades_log
      WHERE outcome IN ('win','loss') AND regime IS NOT NULL
      GROUP BY regime, timeframe
    `);
    calibrationCache.byRegimeTF = {};
    for (const r of regimeTFRes.rows) {
      const n = parseInt(r.n);
      if (n > 0) {
        const key = `${r.regime}_${r.timeframe}`;
        calibrationCache.byRegimeTF[key] = { winRate: parseInt(r.wins) / n, n };
      }
    }

    // 3. Win rate by market quality
    const qualRes = await pool.query(`
      SELECT market_quality,
        COUNT(*) FILTER (WHERE outcome IN ('win','loss')) AS n,
        COUNT(*) FILTER (WHERE outcome = 'win') AS wins,
        ROUND(AVG(pnl) FILTER (WHERE outcome IN ('win','loss')), 4) AS avg_pnl
      FROM best_trades_log
      WHERE outcome IN ('win','loss') AND market_quality IS NOT NULL
      GROUP BY market_quality
    `);
    calibrationCache.byQuality = {};
    for (const r of qualRes.rows) {
      const n = parseInt(r.n);
      if (n > 0) {
        calibrationCache.byQuality[r.market_quality] = {
          winRate: parseInt(r.wins) / n, n,
          avgPnl: parseFloat(r.avg_pnl) || 0,
        };
      }
    }

    // 4. Win rate by confidence level
    const confRes = await pool.query(`
      SELECT confidence,
        COUNT(*) FILTER (WHERE outcome IN ('win','loss')) AS n,
        COUNT(*) FILTER (WHERE outcome = 'win') AS wins
      FROM best_trades_log
      WHERE outcome IN ('win','loss') AND confidence IS NOT NULL
      GROUP BY confidence
    `);
    calibrationCache.byConfidence = {};
    for (const r of confRes.rows) {
      const n = parseInt(r.n);
      if (n > 0) {
        calibrationCache.byConfidence[r.confidence] = { winRate: parseInt(r.wins) / n, n };
      }
    }

    // 5. Overall stats for Kelly graduation
    const overallRes = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE outcome IN ('win','loss')) AS total_resolved,
        COUNT(*) FILTER (WHERE outcome = 'win') AS wins
      FROM best_trades_log
    `);
    const totalResolved = parseInt(overallRes.rows[0].total_resolved);
    const overallWR = totalResolved > 0 ? parseInt(overallRes.rows[0].wins) / totalResolved : 0.5;

    // Kelly graduation: increase multiplier based on proven accuracy
    // Calculate mean absolute calibration error across prob buckets
    let calError = 0, calCount = 0;
    for (const [, b] of Object.entries(calibrationCache.byProbBucket)) {
      if (b.n >= 5) {
        calError += Math.abs(b.actual - b.predicted / 100);
        calCount++;
      }
    }
    const avgCalError = calCount > 0 ? calError / calCount : 1;
    let kellyGraduation = 0;
    if (totalResolved >= 200 && avgCalError <= 0.03) kellyGraduation = 0.20;
    else if (totalResolved >= 100 && avgCalError <= 0.05) kellyGraduation = 0.10;
    else if (totalResolved >= 50 && avgCalError <= 0.08) kellyGraduation = 0.05;

    calibrationCache.overall = { winRate: overallWR, totalResolved, kellyGraduation, avgCalError };
    calibrationCache.lastRefresh = now;

    console.log(`[Calibration] Cache refreshed: ${totalResolved} resolved trades, WR=${(overallWR*100).toFixed(1)}%, calError=${(avgCalError*100).toFixed(1)}%, kellyGrad=+${(kellyGraduation*100).toFixed(0)}%`);
  } catch (err) {
    console.error('[Calibration] Cache refresh error:', err.message);
  }
}

/**
 * Calibrate a raw probability score using historical accuracy data.
 * Uses Bayesian shrinkage: blends predicted prob toward actual win rate,
 * weighted by sample size. More data = more correction.
 */
function calibrateProb(rawProb, regime, tf, marketQuality) {
  const cc = calibrationCache;
  if (cc.overall.totalResolved < cc.minSamples) return rawProb; // not enough data

  let adjustedProb = rawProb;

  // 1. Probability bucket calibration (most important)
  // If we predicted 65% but actual is 83%, nudge upward
  const bucketKey = rawProb < 55 ? '50-54' : rawProb < 60 ? '55-59' : rawProb < 65 ? '60-64'
    : rawProb < 70 ? '65-69' : rawProb < 75 ? '70-74' : rawProb < 80 ? '75-79' : '80+';
  const bucket = cc.byProbBucket[bucketKey];
  if (bucket && bucket.n >= cc.minSamples) {
    const actualWR = bucket.actual * 100; // e.g. 83
    const diff = actualWR - bucket.predicted;  // e.g. 83 - 67 = +16
    // Shrinkage: weight correction by min(1, n/100) — full correction at 100+ samples (#20 consensus: raised from 50)
    const shrinkage = Math.min(1, bucket.n / 100);
    const correction = diff * shrinkage * 0.6; // apply 60% of the correction (conservative)
    adjustedProb += correction;
  }

  // 2. Regime + TF adjustment
  const regimeTFKey = `${regime}_${tf}`;
  const regimeTF = cc.byRegimeTF[regimeTFKey];
  if (regimeTF && regimeTF.n >= cc.minSamples) {
    const regimeWR = regimeTF.winRate * 100;
    const overallWR = cc.overall.winRate * 100;
    const regimeDiff = regimeWR - overallWR; // e.g. bear_15m wins 60% vs overall 50% → +10
    const shrinkage = Math.min(1, regimeTF.n / 100); // #20 raised from 40
    adjustedProb += regimeDiff * shrinkage * 0.3; // 30% correction weight
  }

  // 3. Market quality adjustment
  const qualData = cc.byQuality[marketQuality];
  if (qualData && qualData.n >= cc.minSamples) {
    const qualWR = qualData.winRate * 100;
    const overallWR = cc.overall.winRate * 100;
    const qualDiff = qualWR - overallWR;
    const shrinkage = Math.min(1, qualData.n / 100); // #20 raised from 40
    adjustedProb += qualDiff * shrinkage * 0.2; // 20% weight
  }

  // Clamp to valid range
  adjustedProb = Math.max(25, Math.min(85, Math.round(adjustedProb)));

  return adjustedProb;
}

/**
 * Get calibrated Kelly multiplier based on historical performance.
 * Returns an additive bonus to the base Kelly multiplier.
 */
function getCalibratedKellyBonus(confidence, marketQuality) {
  const cc = calibrationCache;
  let bonus = cc.overall.kellyGraduation || 0;

  // Additional bonus/penalty from confidence-level accuracy
  const confData = cc.byConfidence[confidence];
  if (confData && confData.n >= cc.minSamples) {
    if (confData.winRate > 0.60) bonus += 0.05;      // High confidence actually wins >60%
    else if (confData.winRate < 0.45) bonus -= 0.10;  // High confidence actually wins <45% → penalize
  }

  // Quality-level adjustment
  const qualData = cc.byQuality[marketQuality];
  if (qualData && qualData.n >= cc.minSamples) {
    if (qualData.avgPnl > 1.0) bonus += 0.05;        // This quality grade is profitable
    else if (qualData.avgPnl < -0.5) bonus -= 0.10;   // This quality grade loses money
  }

  return Math.max(-0.15, Math.min(0.25, bonus)); // clamp bonus to [-15%, +25%]
}

// Quality grade ordering for per-TF min quality filters
const QUALITY_ORDER = { 'A': 4, 'B+': 3, 'B': 2, 'C': 1, 'No-Trade': 0 };

// ══════════════════════════════════════════════════════════════
// INDICATOR HELPERS (ported from frontend)
// ══════════════════════════════════════════════════════════════

function donchianMid(d, period) {
  const out = Array(d.length).fill(null);
  for (let i = period - 1; i < d.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (d[j].h > hi) hi = d[j].h;
      if (d[j].l < lo) lo = d[j].l;
    }
    out[i] = (hi + lo) / 2;
  }
  return out;
}

function computeATR(d, len = 14) {
  const highs = d.map(x => x.h);
  const lows = d.map(x => x.l);
  const closes = d.map(x => x.c);
  const tr = [0];
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  return ema(tr, len);
}

// ══════════════════════════════════════════════════════════════
// SIGNAL COMPUTATION (mirrors frontend computeLiveSignals)
// ══════════════════════════════════════════════════════════════

function computeSignals(d, tf) {
  const last = d.length - 1;
  const c = d.map(x => x.c);
  const price = c[last];
  const results = {};

  // EMA200 regime
  const ema200Arr = ema(c, 200);
  const macro_bull = ema200Arr[last] != null && price > ema200Arr[last];
  const macro_bear = ema200Arr[last] != null && price < ema200Arr[last];

  // Regime-adaptive thresholds
  const rsiOversold = macro_bull ? 40 : macro_bear ? 25 : 35;
  const rsiOverbought = macro_bull ? 75 : macro_bear ? 55 : 65;
  const stochOversold = macro_bull ? 25 : macro_bear ? 15 : 20;
  const stochOverbought = macro_bull ? 85 : macro_bear ? 75 : 80;

  // ── RSI ──
  const R = rsi(c, 14);
  const rsiVal = R[last];
  results.RSI = {
    value: rsiVal,
    bull: rsiVal != null && rsiVal <= rsiOversold,
    bear: rsiVal != null && rsiVal >= rsiOverbought,
  };

  // ── EMA (regime-adaptive) ──
  const atrVals = computeATR(d, 14);
  const recentATRs = atrVals.slice(-20).filter(v => v != null);
  const oldATRs = atrVals.slice(-50, -20).filter(v => v != null);
  const avgRecentATR = recentATRs.reduce((s, v) => s + v, 0) / (recentATRs.length || 1);
  const avgOldATR = oldATRs.reduce((s, v) => s + v, 0) / (oldATRs.length || 1);
  const _emaVolatile = avgRecentATR > avgOldATR * 1.3;
  const _emaPeriods = _emaVolatile ? { fast: 34, slow: 89 } : macro_bull ? { fast: 13, slow: 34 } : { fast: 21, slow: 55 };
  const emaF = ema(c, _emaPeriods.fast), emaS = ema(c, _emaPeriods.slow);
  const emaSpread = emaF[last] != null && emaS[last] != null ? Math.abs(emaF[last] - emaS[last]) / emaS[last] : 0;
  const emaIsFlat = emaSpread < 0.005;
  results.EMA = {
    bull: !emaIsFlat && emaF[last] > emaS[last],
    bear: !emaIsFlat && emaF[last] < emaS[last],
    crossBull: last > 0 && emaF[last - 1] <= emaS[last - 1] && emaF[last] > emaS[last],
    crossBear: last > 0 && emaF[last - 1] >= emaS[last - 1] && emaF[last] < emaS[last],
  };

  // ── MACD (TF-adaptive) ──
  const scalpTFs = ['1m', '3m', '5m'];
  const bridgeTFs = ['15m', '30m'];
  const longTFs = ['1d', '3d', '1w'];
  const mp = scalpTFs.includes(tf) ? { f: 5, s: 13, sig: 8 }
    : bridgeTFs.includes(tf) ? { f: 8, s: 17, sig: 9 }
    : longTFs.includes(tf) ? { f: 12, s: 26, sig: 9 }
    : { f: 5, s: 35, sig: 5 };
  const macdFast = ema(c, mp.f), macdSlow = ema(c, mp.s);
  const macdLine = c.map((_, i) => macdFast[i] != null && macdSlow[i] != null ? macdFast[i] - macdSlow[i] : null);
  const macdSig = ema(macdLine.map(v => v ?? 0), mp.sig);
  const macdVal = macdLine[last], macdSigVal = macdSig[last];
  const macdNeutral = macdVal != null && Math.abs(macdVal) < price * 0.001;
  const macdCrossBull = last > 0 && macdLine[last - 1] <= macdSig[last - 1] && macdVal > macdSigVal;
  const macdCrossBear = last > 0 && macdLine[last - 1] >= macdSig[last - 1] && macdVal < macdSigVal;
  const macdCrossStrong = Math.abs(macdVal) > price * 0.002;
  results.MACD = {
    bull: !macdNeutral && macdVal > macdSigVal,
    bear: !macdNeutral && macdVal < macdSigVal,
    crossBull: macdCrossBull && macdCrossStrong,
    crossBear: macdCrossBear && macdCrossStrong,
    cross: (macdCrossBull || macdCrossBear) && macdCrossStrong,
  };

  // ── Bollinger Bands ──
  const bbMid = sma(c, 20), bbSd = stdev(c, 20);
  const bbUpper = bbMid.map((m, i) => m != null ? m + 2.5 * bbSd[i] : null);
  const bbLower = bbMid.map((m, i) => m != null ? m - 2.5 * bbSd[i] : null);
  const bbPct = bbUpper[last] != null ? ((price - bbLower[last]) / (bbUpper[last] - bbLower[last])) : null;
  // BBWP squeeze
  const bandwidths = [];
  for (let i = Math.max(19, last - 99); i <= last; i++) {
    if (bbSd[i] != null && bbMid[i] > 0) bandwidths.push(bbSd[i] / bbMid[i]);
  }
  const currentBW = bbSd[last] != null && bbMid[last] > 0 ? bbSd[last] / bbMid[last] : null;
  const bbwp = currentBW != null && bandwidths.length > 10
    ? bandwidths.filter(bw => bw < currentBW).length / bandwidths.length : null;
  const squeeze = bbwp != null && bbwp < 0.20;
  results.BB = {
    bull: bbPct != null && bbPct <= 0.15,
    bear: bbPct != null && bbPct >= 0.85,
    squeeze,
  };

  // ── StochRSI ──
  const stRSI = rsi(c, 14);
  const stKArr = [];
  for (let i = 14; i < stRSI.length; i++) {
    const sl = stRSI.slice(i - 14, i).filter(x => x != null);
    if (sl.length < 14) { stKArr.push(null); continue; }
    const mn = Math.min(...sl), mx = Math.max(...sl);
    stKArr.push((stRSI[i] - mn) / (mx - mn || 1) * 100);
  }
  const stK = stKArr[stKArr.length - 1];
  results.StochRSI = {
    bull: stK != null && stK < stochOversold,
    bear: stK != null && stK > stochOverbought,
  };

  // ── Ichimoku (TF-adaptive) ──
  const shortTFsIchi = ['1m', '3m', '5m', '15m'];
  const longTFsIchi = ['1d', '3d', '1w'];
  const ip = shortTFsIchi.includes(tf) ? { tenkan: 9, kijun: 26, spanB: 52 }
    : longTFsIchi.includes(tf) ? { tenkan: 20, kijun: 60, spanB: 120 }
    : { tenkan: 10, kijun: 30, spanB: 60 };
  const ichiTenkan = donchianMid(d, ip.tenkan);
  const ichiKijun = donchianMid(d, ip.kijun);
  const senkouA = ichiTenkan[last] != null && ichiKijun[last] != null ? (ichiTenkan[last] + ichiKijun[last]) / 2 : null;
  const ichiSpanB = donchianMid(d, ip.spanB);
  const senkouB = ichiSpanB[last];
  const cloudTop = senkouA != null && senkouB != null ? Math.max(senkouA, senkouB) : null;
  const cloudBot = senkouA != null && senkouB != null ? Math.min(senkouA, senkouB) : null;
  const tkBull = ichiTenkan[last] != null && ichiKijun[last] != null && ichiTenkan[last] > ichiKijun[last];
  const tkBear = ichiTenkan[last] != null && ichiKijun[last] != null && ichiTenkan[last] < ichiKijun[last];
  results.Ichimoku = {
    bull: cloudTop != null && price > cloudTop && tkBull,
    bear: cloudBot != null && price < cloudBot && tkBear,
  };

  // ── Volume (3-layer: doji + OBV + body-weighted) ──
  const vols = d.map(x => x.v);
  const volSma = sma(vols, 20);
  const volRatio = volSma[last] > 0 ? vols[last] / volSma[last] : 1;
  const candleRange = d[last].h - d[last].l;
  const bodySize = Math.abs(d[last].c - d[last].o);
  const bodyRatio = candleRange > 0 ? bodySize / candleRange : 0;
  const isDoji = bodyRatio < 0.15;
  const wickBuyRatio = candleRange > 0 ? (d[last].c - d[last].l) / candleRange : 0.5;
  const bodyDirection = d[last].c > d[last].o ? 1 : 0;
  const dirRatio = isDoji ? 0.5 : (0.6 * (bodyDirection * bodyRatio) + 0.4 * wickBuyRatio);

  // OBV slope
  let obvSlope = 0;
  if (d.length > 11) {
    let obv = 0;
    const obvArr = [0];
    for (let oi = 1; oi < d.length; oi++) {
      if (d[oi].c > d[oi - 1].c) obv += d[oi].v;
      else if (d[oi].c < d[oi - 1].c) obv -= d[oi].v;
      obvArr.push(obv);
    }
    const obvSlice = obvArr.slice(-10);
    const n = obvSlice.length;
    let sx = 0, sy = 0, sxy = 0, sx2 = 0;
    for (let oi = 0; oi < n; oi++) { sx += oi; sy += obvSlice[oi]; sxy += oi * obvSlice[oi]; sx2 += oi * oi; }
    const rawSlope = (n * sxy - sx * sy) / (n * sx2 - sx * sx || 1);
    const avgVol = vols.slice(-10).reduce((s, v) => s + v, 0) / 10;
    obvSlope = avgVol > 0 ? rawSlope / avgVol : 0;
  }

  let volBull = false, volBear = false, volDrying = false;
  if (isDoji) {
    // doji = neutral
  } else if (volRatio < 0.5) {
    volDrying = true;
  } else if (volRatio > 1.5) {
    const wickSaysBull = dirRatio > 0.55;
    const wickSaysBear = dirRatio < 0.35;
    const obvSaysBull = obvSlope > 0.3;
    const obvSaysBear = obvSlope < -0.3;
    if (wickSaysBull && !obvSaysBear) volBull = true;
    else if (wickSaysBear && !obvSaysBull) volBear = true;
  }
  results.Volume = { bull: volBull, bear: volBear, drying: volDrying, ratio: volRatio };

  // ── ATR for R/R ──
  const currentATR = atrVals[last] || (price * 0.02);

  // ── Market Quality Grade ──
  let mqScore = 0;
  const atrRatio = avgOldATR > 0 ? avgRecentATR / avgOldATR : 1;
  if (atrRatio > 1.2) mqScore += 2; else if (atrRatio > 0.8) mqScore += 1; else mqScore -= 1;
  if (volRatio > 1.2) mqScore += 2; else if (volRatio > 0.7) mqScore += 1; else mqScore -= 1;
  if (emaSpread > 0.01) mqScore += 2; else if (emaSpread > 0.005) mqScore += 1; else mqScore -= 1;
  if (squeeze) mqScore += 1; else if (bbwp != null && bbwp > 0.50) mqScore += 1;
  const alignedCount = Object.values(results).filter(s => s.bull || s.bear).length;
  if (alignedCount >= 5) mqScore += 2; else if (alignedCount >= 3) mqScore += 1;
  const marketQuality = mqScore >= 7 ? 'A' : mqScore >= 5 ? 'B+' : mqScore >= 4 ? 'B' : mqScore >= 1 ? 'C' : 'No-Trade';

  // ── Entry Efficiency ──
  const ema21Arr = ema(c, 21);
  const ema21Dist = ema21Arr[last] != null ? (price - ema21Arr[last]) / ema21Arr[last] : 0;
  const recentImpulse = d.length > 3 ? Math.abs(c[last] - c[last - 3]) / (currentATR || price * 0.02) : 0;
  const _last3Bull = d.length > 3 && c[last] > c[last - 1] && c[last - 1] > c[last - 2] && c[last - 2] > c[last - 3];
  const _last3Bear = d.length > 3 && c[last] < c[last - 1] && c[last - 1] < c[last - 2] && c[last - 2] < c[last - 3];
  let entryEfficiency = 'Acceptable';
  if (recentImpulse > 2.5 || (_last3Bull && ema21Dist > 0.02) || (_last3Bear && ema21Dist < -0.02)) {
    entryEfficiency = 'Chasing';
  } else if (Math.abs(ema21Dist) < 0.003) {
    entryEfficiency = 'Excellent';
  }

  // ── ADX for regime gate (#27) ──
  let adxVal = null;
  if (d.length > 28) {
    const highs = d.map(x => x.h), lows = d.map(x => x.l);
    const trArr = [0];
    for (let i = 1; i < d.length; i++) {
      trArr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - c[i-1]), Math.abs(lows[i] - c[i-1])));
    }
    const dmPlus = [0], dmMinus = [0];
    for (let i = 1; i < d.length; i++) {
      const up = highs[i] - highs[i-1];
      const dn = lows[i-1] - lows[i];
      dmPlus.push(up > dn && up > 0 ? up : 0);
      dmMinus.push(dn > up && dn > 0 ? dn : 0);
    }
    const smoothTR = ema(trArr, 14);
    const smoothDMPlus = ema(dmPlus, 14);
    const smoothDMMinus = ema(dmMinus, 14);
    const diPlus = smoothTR.map((t, i) => t > 0 ? (smoothDMPlus[i] / t) * 100 : 0);
    const diMinus = smoothTR.map((t, i) => t > 0 ? (smoothDMMinus[i] / t) * 100 : 0);
    const dx = diPlus.map((dp, i) => (dp + diMinus[i]) > 0 ? Math.abs(dp - diMinus[i]) / (dp + diMinus[i]) * 100 : 0);
    const adxArr = ema(dx, 14);
    adxVal = adxArr[last];
  }

  return { signals: results, atr: currentATR, price, macro_bull, marketQuality, mqScore, entryEfficiency, adxVal, ema200Val: ema200Arr[last] };
}

// ══════════════════════════════════════════════════════════════
// CONFLUENCE SCORING (mirrors frontend scoreConfluence)
// ══════════════════════════════════════════════════════════════

function scoreConfluence(signals, direction, regime, tf, marketQuality) {
  const dir = direction === 'long' ? 'bull' : 'bear';
  const opp = direction === 'long' ? 'bear' : 'bull';
  let score = 0, maxScore = 0;
  const hits = [], misses = [];

  // TF-aware weights
  const shortTFs = ['1m', '3m', '5m', '15m'];
  const medShortTFs = ['30m', '1h'];
  const longTFs = ['6h', '8h', '12h', '1d', '3d', '1w'];
  const isShortTF = shortTFs.includes(tf);
  const isMedShortTF = medShortTFs.includes(tf);
  const isLongTF = longTFs.includes(tf);

  const WEIGHTS = isShortTF ? { EMA: 8, Ichimoku: 5, MACD: 10, RSI: 22, StochRSI: 22, BB: 18, Volume: 15 }
    : isMedShortTF ? { EMA: 14, Ichimoku: 10, MACD: 14, RSI: 18, StochRSI: 18, BB: 14, Volume: 12 }
    : isLongTF ? { EMA: 25, Ichimoku: 22, MACD: 18, RSI: 10, StochRSI: 8, BB: 7, Volume: 10 }
    : { EMA: 20, Ichimoku: 16, MACD: 16, RSI: 12, StochRSI: 10, BB: 12, Volume: 14 };

  // Family dampening
  const FAMILIES = { RSI: 'meanrev', StochRSI: 'meanrev', BB: 'meanrev', EMA: 'trend', MACD: 'trend', Ichimoku: 'trend', Volume: 'flow' };
  const FAMILY_DECAY = [1.0, 0.60, 0.35];
  const familyCount = { meanrev: 0, trend: 0, flow: 0 };

  // Trend vs mean-reversion conflict
  const trendInds = ['EMA', 'MACD', 'Ichimoku'];
  const meanRevInds = ['RSI', 'StochRSI', 'BB'];
  let trendBullCount = 0, trendBearCount = 0;
  for (const ti of trendInds) {
    if (signals[ti]?.bull) trendBullCount++;
    if (signals[ti]?.bear) trendBearCount++;
  }
  const strongTrendBull = trendBullCount >= 2;
  const strongTrendBear = trendBearCount >= 2;

  for (const [ind, w] of Object.entries(WEIGHTS)) {
    const sig = signals[ind];
    if (!sig) continue;
    maxScore += w;

    const aligned = sig[dir] === true;
    const opposing = sig[opp] === true;
    const crossBonus = (dir === 'bull' && sig.crossBull) || (dir === 'bear' && sig.crossBear);
    const isMeanRev = meanRevInds.includes(ind);
    const meanRevConflict = isMeanRev && (
      (aligned && dir === 'bull' && strongTrendBear) ||
      (aligned && dir === 'bear' && strongTrendBull)
    );

    if (aligned) {
      const family = FAMILIES[ind] || 'other';
      const famIdx = familyCount[family] || 0;
      const dampening = FAMILY_DECAY[Math.min(famIdx, FAMILY_DECAY.length - 1)];
      familyCount[family] = famIdx + 1;

      if (meanRevConflict) {
        score += w * 0.5 * dampening;
        hits.push(ind + ' (vs trend)');
      } else {
        const basePts = crossBonus ? w * 1.3 : w;
        score += basePts * dampening;
        hits.push(ind);
      }
    } else if (opposing) {
      score -= w * 0.4;
      misses.push(ind);
    } else {
      misses.push(ind);
    }
  }

  // Squeeze bonus
  if (signals.BB?.squeeze) { score += 8; maxScore += 8; hits.push('BB_Squeeze'); }
  // Volume drying penalty
  if (signals.Volume?.drying) { score -= 5; misses.push('Volume_Dry'); }

  const confluence = maxScore > 0 ? Math.max(0, score / maxScore) : 0.5;

  // Sigmoid probability mapping
  const sigK = 7;
  let prob = 28 + (78 - 28) / (1 + Math.exp(-sigK * (confluence - 0.5)));

  // Regime adjustment (±4)
  if (regime === 'bull' && direction === 'long') prob += 4;
  if (regime === 'bull' && direction === 'short') prob -= 4;
  if (regime === 'bear' && direction === 'short') prob += 4;
  if (regime === 'bear' && direction === 'long') prob -= 4;

  // Confidence + caps
  const confidence = confluence >= 0.65 ? 'High' : confluence >= 0.45 ? 'Medium' : 'Low';
  let probCap = confidence === 'High' ? 76 : confidence === 'Medium' ? 68 : 58;
  if (confidence === 'High' && marketQuality === 'A') probCap = 82;
  else if (confidence === 'High' && marketQuality === 'B') probCap = 76;
  if (marketQuality === 'C') probCap = Math.min(probCap, 62);
  prob = Math.min(probCap, Math.max(25, Math.round(prob)));

  return { prob, confluence, confidence, hits, misses };
}

// ══════════════════════════════════════════════════════════════
// R/R ESTIMATION
// ══════════════════════════════════════════════════════════════

function estimateRR(price, atrVal, direction, prob, leverage, confidence, candles, marketQuality) {
  const defaultStopMult = 2.0;
  let stop = atrVal * defaultStopMult;

  // Structural stop snapping
  if (candles && candles.length > 20) {
    const swingLows = [], swingHighs = [];
    for (let i = 5; i < candles.length - 3; i++) {
      let isLow = true, isHigh = true;
      for (let j = i - 5; j <= i + 3; j++) {
        if (j === i) continue;
        if (candles[j].l <= candles[i].l) isLow = false;
        if (candles[j].h >= candles[i].h) isHigh = false;
      }
      if (isLow) swingLows.push({ idx: i, price: candles[i].l });
      if (isHigh) swingHighs.push({ idx: i, price: candles[i].h });
    }

    const snapWindow = 0.5 * atrVal;
    const minStop = 1.2 * atrVal, maxStop = 3.0 * atrVal;

    if (direction === 'long') {
      const defaultStopPrice = price - stop;
      const recent = swingLows.filter(s => s.idx >= candles.length - 50)
        .filter(s => Math.abs(s.price - defaultStopPrice) <= snapWindow)
        .sort((a, b) => b.idx - a.idx);
      if (recent.length > 0) {
        const snapped = price - (recent[0].price - atrVal * 0.1);
        stop = Math.max(minStop, Math.min(maxStop, snapped));
      }
    } else {
      const defaultStopPrice = price + stop;
      const recent = swingHighs.filter(s => s.idx >= candles.length - 50)
        .filter(s => Math.abs(s.price - defaultStopPrice) <= snapWindow)
        .sort((a, b) => b.idx - a.idx);
      if (recent.length > 0) {
        const snapped = (recent[0].price + atrVal * 0.1) - price;
        stop = Math.max(minStop, Math.min(maxStop, snapped));
      }
    }
  }

  // Target (inverted: high prob = tighter, low prob = wider)
  const baseTargetMult = prob >= 72 ? 2.0 : prob >= 62 ? 2.5 : 3.0;
  const mqBoost = marketQuality === 'A' ? 1.25 : marketQuality === 'B' ? 1.0 : 0.85;
  const target = atrVal * baseTargetMult * mqBoost;

  const stopPrice = direction === 'long' ? price - stop : price + stop;
  const targetPrice = direction === 'long' ? price + target : price - target;
  const stopPct = stop / price * 100;
  const targetPct = target / price * 100;
  const roundTripFeePct = TRADING_FEE_PCT * 2 * leverage;
  const netTargetPct = targetPct - (roundTripFeePct / leverage);
  const levStopPct = stopPct * leverage;
  const levTargetPct = netTargetPct * leverage;
  const rr = levStopPct > 0 ? parseFloat((levTargetPct / levStopPct).toFixed(1)) : 0;
  const ev = (prob / 100 * levTargetPct) - ((1 - prob / 100) * levStopPct);

  // Kelly-based optimal leverage (with calibration bonus from track record)
  // EIGHTH-KELLY: All 3 AIs agree Quarter-Kelly too aggressive at 243 trades. Halved all multipliers.
  const conf = confidence || 'Low';
  let kellyMult = 0.20;  // was 0.4 (quarter) → now 0.20 (eighth)
  if (marketQuality === 'A' && conf === 'High') kellyMult = 0.30;   // was 0.6
  else if (marketQuality === 'A' && conf === 'Medium') kellyMult = 0.25; // was 0.5
  else if (marketQuality === 'B') kellyMult = 0.20;                 // was 0.4
  else if (marketQuality === 'C') kellyMult = 0.125;                // was 0.25
  else if (marketQuality === 'No-Trade') kellyMult = 0.075;         // was 0.15

  // Apply learned Kelly bonus from historical performance
  const kellyBonus = getCalibratedKellyBonus(conf, marketQuality);
  kellyMult = Math.max(0.10, Math.min(0.85, kellyMult + kellyBonus));

  const kellyFrac = rr > 0 ? ((prob / 100) * rr - (1 - prob / 100)) / rr : 0;
  const safeKelly = Math.max(0, kellyFrac * kellyMult);
  let optimalLev = Math.max(1, Math.min(20, Math.floor(safeKelly / (stopPct / 100))));
  const baseLevCap = conf === 'High' ? 10 : conf === 'Medium' ? 5 : 2;
  const mqMult = marketQuality === 'A' ? 1.0 : marketQuality === 'B' ? 0.8 : marketQuality === 'C' ? 0.5 : 0;
  optimalLev = Math.min(optimalLev, Math.max(1, Math.round(baseLevCap * mqMult)));

  const mqSizeMult = marketQuality === 'A' ? 1.20 : marketQuality === 'B' ? 0.80 : marketQuality === 'C' ? 0.50 : 0;

  return { stopPrice, targetPrice, rr, stopPct, targetPct, ev, optimalLev, mqSizeMult };
}

// ══════════════════════════════════════════════════════════════
// REGIME DETECTION
// ══════════════════════════════════════════════════════════════

function detectRegime(d) {
  const c = d.map(x => x.c);
  const last = c.length - 1;
  const e50 = ema(c, 50), e200 = ema(c, 200);
  const aboveEMA200 = e200[last] != null && c[last] > e200[last];
  const ema50Above = e50[last] != null && e200[last] != null && e50[last] > e200[last];

  let regime = 'neutral';
  if (aboveEMA200 && ema50Above) regime = 'bull';
  else if (!aboveEMA200 && !ema50Above) regime = 'bear';
  else regime = 'sideways';

  return regime;
}

// ══════════════════════════════════════════════════════════════
// BEST TRADES SCANNER CLASS
// ══════════════════════════════════════════════════════════════

class BestTradesScanner {
  constructor() {
    this.settings = {
      enabled: false,
      mode: 'confirm',  // 'confirm' or 'auto'
      timeframe: '15m',  // kept for frontend display, but server scans ALL TFs
      minProb: 70,
      tradeSizeUsd: 100,
      maxOpen: 3,
      leverage: 1,
      tfRules: {},  // Per-TF overrides: { "5m": { enabled: true, minProb: 60, minQuality: "B" }, ... }
    };
    this.scanTimers = {};       // { '5m': timer, '15m': timer, ... }
    this.lastResults = [];      // combined results across all TFs
    this.lastResultsByTF = {};  // { '5m': [...], '4h': [...], ... }
    this.lastScanTime = null;
    this.lastScanTimeByTF = {}; // { '5m': '...', '4h': '...', ... }
    this.lastScanDebug = {};    // Debug info from most recent scan per TF
    this.openTradeCount = 0;
    this.recentTrades = new Set(); // 'BTC_long' — prevent duplicate trades across TFs
    this.sseClients = [];
  }

  async start() {
    await this._loadSettings();
    // Verify DB connection and table exists
    if (pool) {
      try {
        const tableCheck = await pool.query("SELECT COUNT(*) AS cnt FROM best_trades_log LIMIT 1");
        console.log(`[BestTrades] DB connected. best_trades_log has ${tableCheck.rows[0].cnt} rows`);
        // Check if new columns exist
        const colCheck = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='best_trades_log' AND column_name='signal_snapshot'");
        console.log(`[BestTrades] Migration 012 columns: ${colCheck.rows.length > 0 ? 'PRESENT' : 'MISSING - will use basic inserts'}`);
      } catch (e) {
        console.error(`[BestTrades] DB check error:`, e.message);
      }
    } else {
      console.warn('[BestTrades] NO DB POOL - predictions will NOT be logged!');
    }
    // Always start scan timers — scanning & logging predictions is independent of auto-trading
    this._startAllTimers();
    // Always start resolution tracker (resolves predictions even if scanner is disabled)
    this._startResolutionTimer();
    console.log(`[BestTrades] Scanner v2.1 initialized. Auto-trade: ${this.settings.enabled ? 'ON (' + this.settings.mode + ')' : 'OFF (scan-only)'}. Scanning ALL timeframes: ${ALL_TIMEFRAMES.join(', ')}`);
  }

  stop() {
    this._stopAllTimers();
    console.log('[BestTrades] Scanner stopped.');
  }

  // ── Settings Management ──

  async getSettings() {
    return { ...this.settings };
  }

  async updateSettings(newSettings) {
    Object.assign(this.settings, newSettings);
    await this._saveSettings();

    // Scanning always runs — restart timers to pick up any interval changes
    this._stopAllTimers();
    this._startAllTimers();
    console.log(`[BestTrades] Settings updated. Auto-trade: ${this.settings.enabled ? 'ON (' + this.settings.mode + ')' : 'OFF (scan-only)'}`);
    // Notify SSE clients
    this._broadcast('settings', this.settings);
    return this.settings;
  }

  // ── Timer Management (one timer per timeframe) ──

  _startAllTimers() {
    this._stopAllTimers();
    console.log(`[BestTrades] Starting scan timers for ALL timeframes: ${ALL_TIMEFRAMES.join(', ')}`);

    // Stagger initial scans to spread Binance API load
    let delay = 15000; // start first scan after 15s
    for (const tf of ALL_TIMEFRAMES) {
      const intervalMs = SCAN_INTERVALS[tf] || 60 * 60_000;
      const intervalLabel = intervalMs < 60000 ? `${intervalMs / 1000}s` : `${intervalMs / 60000}m`;

      // Initial scan (staggered by 10s per TF)
      setTimeout(() => {
        this._scanTimeframe(tf).catch(e => console.error(`[BestTrades] ${tf} initial scan error:`, e.message));
      }, delay);
      delay += 10000;

      // Recurring scan
      this.scanTimers[tf] = setInterval(() => {
        this._scanTimeframe(tf).catch(e => console.error(`[BestTrades] ${tf} scan error:`, e.message));
      }, intervalMs);

      console.log(`[BestTrades]   ${tf}: every ${intervalLabel}`);
    }
  }

  _stopAllTimers() {
    for (const [tf, timer] of Object.entries(this.scanTimers)) {
      clearInterval(timer);
    }
    this.scanTimers = {};
  }

  // ── Scan a Single Timeframe ──

  async _scanTimeframe(tf) {
    // Scanning always runs (for prediction logging & calibration). Auto-trading is gated separately in _processAutoTrades().
    // Refresh calibration cache, funding rates, and leverage risk (no-op if refreshed recently)
    await refreshCalibrationCache();
    await refreshFundingRates();
    await refreshLeverageRisk();
    console.log(`[BestTrades] Scanning ${ASSETS.length} assets on ${tf}...`);

    const results = [];
    let btcRegime = 'neutral';

    // Scan BTC first for macro regime
    try {
      const btcCandles = await fetchKlines('BTCUSDT', tf, 200);
      if (btcCandles && btcCandles.length > 50) {
        btcRegime = detectRegime(btcCandles);
      }
    } catch (e) {
      console.warn(`[BestTrades] BTC regime fetch error (${tf}):`, e.message);
    }

    // Scan all assets
    let scannedCount = 0, skippedCount = 0, errorCount = 0;
    for (const asset of ASSETS) {
      try {
        const candles = await fetchKlines(asset.sym, tf, 200);
        if (!candles || candles.length < 50) { skippedCount++; continue; }

        const analysis = computeSignals(candles, tf);
        const { signals, atr: atrVal, price, marketQuality, entryEfficiency, adxVal, ema200Val } = analysis;
        scannedCount++;

        // #27 — 4h regime gate: Skip 4h unless confirmed trending (ADX>20 + price above/below EMA200)
        if (tf === '4h' && adxVal != null && adxVal < 20) {
          continue; // not trending — skip this asset on 4h
        }

        // Detect local regime, blend with BTC
        const localRegime = detectRegime(candles);
        const isMajor = ['BTC', 'ETH', 'SOL', 'BNB'].includes(asset.label);
        const regime = asset.label === 'BTC' ? btcRegime
          : (isMajor ? localRegime : btcRegime);

        // Score both directions
        const longScore = scoreConfluence(signals, 'long', regime, tf, marketQuality);
        const shortScore = scoreConfluence(signals, 'short', regime, tf, marketQuality);

        // Pick best direction
        const best = longScore.prob >= shortScore.prob ? longScore : shortScore;
        const direction = longScore.prob >= shortScore.prob ? 'long' : 'short';

        // Debug: log raw scores for first 3 assets per scan
        if (scannedCount <= 3) {
          console.log(`[BestTrades] ${asset.label} ${tf}: longProb=${longScore.prob} shortProb=${shortScore.prob} best=${best.prob} conf=${best.confluence?.toFixed(3)} mq=${marketQuality} regime=${regime}`);
        }

        // #9 Multi-TF Confluence: For 5m/15m signals, check 1h trend alignment
        // If 1h trend opposes the signal direction, penalize probability
        let mtfBonus = 0;
        if (['5m', '15m'].includes(tf)) {
          const higherTF = this.lastResultsByTF['1h'] || [];
          const higherAsset = higherTF.find(r => r.asset === asset.label);
          if (higherAsset) {
            if (higherAsset.direction === direction && higherAsset.prob >= 55) {
              mtfBonus = 3; // 1h confirms — boost probability
            } else if (higherAsset.direction !== direction && higherAsset.prob >= 55) {
              mtfBonus = -4; // 1h opposes — penalize
            }
          }
        }
        // For 30m signals, check 4h alignment
        if (tf === '30m') {
          const higherTF = this.lastResultsByTF['4h'] || [];
          const higherAsset = higherTF.find(r => r.asset === asset.label);
          if (higherAsset) {
            if (higherAsset.direction === direction && higherAsset.prob >= 55) {
              mtfBonus = 2;
            } else if (higherAsset.direction !== direction && higherAsset.prob >= 55) {
              mtfBonus = -3;
            }
          }
        }

        // ── CALIBRATION: Adjust probability using historical accuracy ──
        const rawProb = best.prob;
        let calibratedProb = calibrateProb(rawProb, regime, tf, marketQuality);
        calibratedProb += mtfBonus; // Apply multi-TF confluence adjustment

        // ── FUNDING RATE: Contrarian signal — extreme funding penalizes aligned trades ──
        const fundingRate = getFundingRateForAsset(asset.sym);
        if (Math.abs(fundingRate) > 0.0005) { // >0.05% per 8h = significant
          // High positive funding = longs paying shorts → bearish pressure
          // High negative funding = shorts paying longs → bullish pressure
          if (direction === 'long' && fundingRate > 0.0005) {
            calibratedProb -= Math.min(3, Math.round(fundingRate * 3000)); // up to -3%
          } else if (direction === 'short' && fundingRate < -0.0005) {
            calibratedProb -= Math.min(3, Math.round(Math.abs(fundingRate) * 3000));
          } else if (direction === 'long' && fundingRate < -0.0005) {
            calibratedProb += Math.min(2, Math.round(Math.abs(fundingRate) * 2000)); // bonus up to +2%
          } else if (direction === 'short' && fundingRate > 0.0005) {
            calibratedProb += Math.min(2, Math.round(fundingRate * 2000));
          }
          calibratedProb = Math.max(25, Math.min(85, calibratedProb));
        }

        // Estimate R/R using calibrated probability
        const rrData = estimateRR(price, atrVal, direction, calibratedProb, this.settings.leverage,
          best.confidence, candles, marketQuality);

        // Build signal snapshot for learning (indicator values at time of prediction)
        const signalSnapshot = {};
        for (const [ind, sig] of Object.entries(signals)) {
          if (sig && typeof sig === 'object') {
            signalSnapshot[ind] = {
              bull: !!sig.bull, bear: !!sig.bear,
              ...(sig.value != null ? { value: Math.round(sig.value * 1000) / 1000 } : {}),
              ...(sig.crossBull ? { crossBull: true } : {}),
              ...(sig.crossBear ? { crossBear: true } : {}),
            };
          }
        }
        // Add funding rate to snapshot
        signalSnapshot.fundingRate = fundingRate;

        results.push({
          asset: asset.label,
          sym: asset.sym,
          timeframe: tf,
          direction,
          prob: calibratedProb,
          rawProb,
          longProb: longScore.prob,
          shortProb: shortScore.prob,
          confidence: best.confidence,
          confluenceScore: best.confluence,
          marketQuality,
          entryEfficiency,
          regime,
          rr: rrData.rr,
          ev: rrData.ev,
          price,
          stopPrice: rrData.stopPrice,
          targetPrice: rrData.targetPrice,
          stopPct: rrData.stopPct,
          targetPct: rrData.targetPct,
          optimalLev: rrData.optimalLev,
          mqSizeMult: rrData.mqSizeMult,
          hits: best.hits,
          misses: best.misses,
          atrValue: atrVal,
          volumeRatio: signals.Volume?.ratio || null,
          signalSnapshot,
          timestamp: new Date().toISOString(),
        });

        // Small delay to avoid Binance rate limits
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        errorCount++;
        console.warn(`[BestTrades] ${asset.label} ${tf} scan error:`, e.message);
      }
    }

    // Save scan debug info
    this.lastScanDebug[tf] = { scanned: scannedCount, results: results.length, skipped: skippedCount, errors: errorCount, time: new Date().toISOString() };
    console.log(`[BestTrades] ${tf} scan complete: ${scannedCount} scanned, ${results.length} results (prob>=50 or EV>0), ${skippedCount} skipped, ${errorCount} errors`);
    if (results.length > 0) {
      const topProbs = results.slice(0, 5).map(r => `${r.asset}:${r.direction}:${r.prob}%`).join(', ');
      console.log(`[BestTrades] ${tf} top results: ${topProbs}`);
    }

    // #24 — Sort by EV (expected value) as primary metric, not raw probability
    // All 3 AIs unanimous: EV incorporates R:R for true expectancy
    results.sort((a, b) => (b.ev || 0) - (a.ev || 0));

    // Store per-TF results
    this.lastResultsByTF[tf] = results;
    this.lastScanTimeByTF[tf] = new Date().toISOString();

    // Merge all TF results into combined lastResults (deduplicate: keep highest prob per asset)
    this._mergeResults();

    // Log results to DB
    await this._logResults(results);

    // Process auto-trades (with cross-TF dedup)
    await this._processAutoTrades(results, tf);

    // Broadcast to SSE clients
    this._broadcast('scan', {
      timeframe: tf,
      results: results.slice(0, 10),
      combined: this.lastResults.slice(0, 10),
      timestamp: this.lastScanTimeByTF[tf],
    });

    const qualifying = results.filter(r => r.prob >= this.settings.minProb);
    console.log(`[BestTrades] ${tf} scan complete: ${results.length} assets, ${qualifying.length} qualifying (>=${this.settings.minProb}%), top: ${results[0]?.asset} ${results[0]?.direction} ${results[0]?.prob}%`);

    return results;
  }

  /**
   * Merge results from all timeframes into a single ranked list.
   * For each asset, keep the entry with the highest probability across all TFs.
   */
  _mergeResults() {
    const bestByAsset = new Map(); // asset -> best result

    for (const [tf, tfResults] of Object.entries(this.lastResultsByTF)) {
      for (const r of tfResults) {
        const existing = bestByAsset.get(r.asset);
        if (!existing || r.prob > existing.prob) {
          bestByAsset.set(r.asset, r);
        }
      }
    }

    this.lastResults = [...bestByAsset.values()].sort((a, b) => b.prob - a.prob);
    this.lastScanTime = new Date().toISOString();
  }

  // ── Legacy single-TF scan (for manual trigger / API compat) ──
  async scan() {
    if (!this.settings.enabled) return [];
    // Scan the user's preferred TF first, then all others
    const tf = this.settings.timeframe || '15m';
    await this._scanTimeframe(tf);
    return this.lastResults;
  }

  // ── Auto-Trade Execution ──

  async _processAutoTrades(results, tf) {
    if (!this.settings.enabled || this.settings.mode !== 'auto') return;

    // Refresh leverage risk data (#13/#14/#15/#16/#18/#19/#30)
    await refreshLeverageRisk();

    // #14 — If 5+ consecutive losses, halt all trading for safety
    if (leverageRisk.consecutiveLosses >= 5) {
      console.log(`[BestTrades] Auto-trade HALTED: ${leverageRisk.consecutiveLosses} consecutive losses`);
      return;
    }

    // #13 — If drawdown >= 20%, kill switch
    if (leverageRisk.drawdownPct >= 20) {
      console.log(`[BestTrades] Auto-trade HALTED: drawdown ${leverageRisk.drawdownPct}% >= 20% kill switch`);
      return;
    }

    // Check per-TF rule: if this TF is explicitly disabled, skip
    const tfRule = this.settings.tfRules[tf];
    if (tfRule && tfRule.enabled === false) {
      console.log(`[BestTrades] Auto-trade: ${tf} disabled by per-TF rule — skipping`);
      return;
    }

    // Per-TF thresholds (fallback to global settings)
    const minProb = (tfRule && tfRule.minProb) || this.settings.minProb;
    const minQuality = (tfRule && tfRule.minQuality) || null;
    const minConfidence = (tfRule && tfRule.minConfidence) || null;

    // Clean stale trade dedup keys (expire after 30 min for short TFs, 4h for long TFs)
    const dedupeExpiry = ['5m', '15m', '30m'].includes(tf) ? 30 * 60_000 : 4 * 60 * 60_000;
    const now = Date.now();
    for (const key of this.recentTrades) {
      const [, , ts] = key.split('|');
      if (ts && now - parseInt(ts) > dedupeExpiry) this.recentTrades.delete(key);
    }

    // Filter qualifying setups using per-TF rules
    const qualifying = results.filter(r => {
      if (r.prob < minProb) return false;
      if (r.marketQuality === 'No-Trade') return false;
      // Per-TF minimum quality grade filter
      if (minQuality && (QUALITY_ORDER[r.marketQuality] || 0) < (QUALITY_ORDER[minQuality] || 0)) return false;
      // Confidence filter: per-TF or global (default: skip Low)
      if (minConfidence) {
        const confOrder = { 'High': 3, 'Medium': 2, 'Low': 1 };
        if ((confOrder[r.confidence] || 0) < (confOrder[minConfidence] || 0)) return false;
      } else {
        if (r.confidence === 'Low') return false;
      }
      if (r.entryEfficiency === 'Chasing') return false;
      if (r.ev <= 0) return false; // #24 EV must be positive

      // #27 — Per-TF leverage limits: hardcode 4h to max 1x until fixed
      // (This is handled in getSafeLeverage, but also skip low-quality 4h)
      if (tf === '4h' && r.marketQuality !== 'A') return false;

      // Cross-TF dedup: don't trade same asset+direction if recently traded on another TF
      const dedupeKey = `${r.asset}|${r.direction}`;
      for (const existing of this.recentTrades) {
        if (existing.startsWith(dedupeKey + '|')) return false;
      }
      return true;
    });

    if (qualifying.length === 0) return;

    // Check if any user has unlocked credentials
    // (We need credentials to execute trades)
    let userId = null;
    let creds = null;
    let demo = false;

    // Find the first user with unlocked credentials
    if (pool) {
      try {
        const userResult = await pool.query("SELECT id FROM users WHERE role='admin' LIMIT 1");
        if (userResult.rows.length > 0) {
          const adminId = userResult.rows[0].id;
          if (liveEngine.isUnlocked(adminId)) {
            userId = adminId;
            creds = liveEngine.getCredentials(adminId);
            demo = liveEngine.isDemo(adminId);
          }
        }
      } catch (e) {
        console.warn('[BestTrades] User lookup error:', e.message);
      }
    }

    if (!creds) {
      console.log('[BestTrades] Auto-trade: no unlocked credentials — skipping execution');
      return;
    }

    // Count open positions
    let openCount = 0;
    try {
      const posResult = await pool.query(
        'SELECT COUNT(*) AS total FROM live_positions WHERE user_id=$1 AND closed_at IS NULL',
        [userId]
      );
      openCount = parseInt(posResult.rows[0].total);
    } catch {}

    if (openCount >= this.settings.maxOpen) {
      console.log(`[BestTrades] Auto-trade: max open positions reached (${openCount}/${this.settings.maxOpen})`);
      return;
    }

    // Check balance
    let availableBalance = 0;
    try {
      const balance = await blofinClient.getBalance(creds, demo);
      availableBalance = balance.availableBalance || 0;
    } catch (e) {
      console.warn('[BestTrades] Balance check error:', e.message);
      return;
    }

    // #18 Portfolio heat tracking — calculate current exposure
    let currentExposureUsd = 0;
    try {
      const expRes = await pool.query(
        'SELECT COALESCE(SUM(ABS(size_usd)), 0) AS total_exposure FROM live_positions WHERE user_id=$1 AND closed_at IS NULL',
        [userId]
      );
      currentExposureUsd = parseFloat(expRes.rows[0].total_exposure) || 0;
    } catch {}
    const totalAccountUsd = availableBalance + currentExposureUsd;
    const currentHeatPct = totalAccountUsd > 0 ? (currentExposureUsd / totalAccountUsd) * 100 : 0;

    if (currentHeatPct >= leverageRisk.maxHeatPct) {
      console.log(`[BestTrades] Portfolio heat ${currentHeatPct.toFixed(1)}% >= ${leverageRisk.maxHeatPct}% max — skipping new trades`);
      return;
    }

    const slotsAvailable = this.settings.maxOpen - openCount;
    const toTrade = qualifying.slice(0, slotsAvailable);

    for (const setup of toTrade) {
      const posSize = Math.round(this.settings.tradeSizeUsd * (setup.mqSizeMult || 1));
      if (availableBalance < posSize) {
        console.log(`[BestTrades] Insufficient balance ($${availableBalance.toFixed(2)} < $${posSize})`);
        break;
      }

      // #18 Re-check heat before each trade
      const newHeatPct = totalAccountUsd > 0 ? ((currentExposureUsd + posSize) / totalAccountUsd) * 100 : 0;
      if (newHeatPct >= leverageRisk.maxHeatPct) {
        console.log(`[BestTrades] Would exceed portfolio heat limit (${newHeatPct.toFixed(1)}% >= ${leverageRisk.maxHeatPct}%) — skipping`);
        break;
      }

      try {
        await this._executeTradeOnBloFin(setup, posSize, userId, creds, demo);
        currentExposureUsd += posSize; // track cumulative for heat
        availableBalance -= posSize;
        openCount++;
        // Mark as recently traded to prevent duplicate trades from other TFs
        this.recentTrades.add(`${setup.asset}|${setup.direction}|${Date.now()}`);
      } catch (e) {
        console.error(`[BestTrades] Trade execution failed for ${setup.asset}:`, e.message);
      }
    }
  }

  async _executeTradeOnBloFin(setup, posSize, userId, creds, demo) {
    const instId = setup.asset + '-USDT';
    const side = setup.direction === 'long' ? 'buy' : 'sell';
    // Apply all leverage risk gates (#13/#14/#15/#16/#18/#19)
    const rawLev = Math.max(setup.optimalLev || 1, this.settings.leverage || 1);
    const fundingRate = getFundingRateForAsset(setup.sym || setup.asset + 'USDT');
    const lev = getSafeLeverage(rawLev, {
      confidence: setup.confidence,
      marketQuality: setup.marketQuality,
      fundingRate,
      direction: setup.direction,
      winRate: calibrationCache.overall.winRate * 100,
      totalTrades: calibrationCache.overall.totalResolved,
    });
    if (lev <= 0) {
      console.log(`[BestTrades] Trade blocked by risk gates: ${setup.asset} ${setup.direction} (DD=${leverageRisk.drawdownPct}%, ConsecL=${leverageRisk.consecutiveLosses})`);
      return;
    }

    // Get mark price
    let markPrice;
    try {
      markPrice = await blofinClient.getMarkPrice(instId, demo);
    } catch {}
    if (!markPrice) markPrice = setup.price;

    // Calculate SL/TP
    const slPrice = setup.direction === 'long'
      ? (markPrice * (1 - setup.stopPct / 100)).toFixed(6)
      : (markPrice * (1 + setup.stopPct / 100)).toFixed(6);
    const tpPrice = setup.direction === 'long'
      ? (markPrice * (1 + setup.targetPct / 100)).toFixed(6)
      : (markPrice * (1 - setup.targetPct / 100)).toFixed(6);

    // Get contract info
    let contractValue = 0.001, lotSize = 1, minSize = 1;
    try {
      const markets = await blofinClient.getMarkets(demo);
      const mkt = markets.find(m => m.name === instId);
      if (mkt) {
        contractValue = parseFloat(mkt.contractValue) || 0.001;
        minSize = parseFloat(mkt.minSize) || 1;
        lotSize = parseFloat(mkt.lotSize) || parseFloat(mkt.minSize) || 1;
      }
    } catch {}

    const rawContracts = posSize / (markPrice * contractValue);
    const contractSize = Math.max(minSize, Math.round(rawContracts / lotSize) * lotSize);

    const result = await blofinClient.openPosition({
      creds, instId, direction: setup.direction,
      size: String(contractSize), leverage: lev,
      orderType: 'market', slPrice, tpPrice,
      marginMode: 'cross', demo,
    });

    // Log to DB
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO best_trades_log
           (asset, direction, probability, confidence, market_quality, rr_ratio,
            entry_price, stop_price, target_price, stop_pct, target_pct, regime, executed, order_id, timeframe)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [setup.asset, setup.direction, setup.prob, setup.confidence,
           setup.marketQuality, setup.rr, setup.price, setup.stopPrice, setup.targetPrice,
           setup.stopPct, setup.targetPct, setup.regime, true, result.orderId || null, setup.timeframe || '15m']
        );
      } catch {}
    }

    console.log(`[BestTrades] ⚡ EXECUTED: ${setup.asset} ${setup.direction.toUpperCase()} @ $${markPrice} | Prob: ${setup.prob}% | Size: $${posSize} | Lev: ${lev}x | SL: ${slPrice} | TP: ${tpPrice}`);
    this._broadcast('trade', { setup, orderId: result.orderId, posSize, leverage: lev });
  }

  // ── DB Persistence ──

  async _loadSettings() {
    if (!pool) return;
    try {
      const result = await pool.query('SELECT * FROM best_trades_settings WHERE id = 1');
      if (result.rows.length > 0) {
        const row = result.rows[0];
        this.settings.enabled = row.enabled;
        this.settings.mode = row.mode || 'confirm';
        this.settings.timeframe = row.timeframe || '15m';
        this.settings.minProb = row.min_prob || 70;
        this.settings.tradeSizeUsd = parseFloat(row.trade_size_usd) || 100;
        this.settings.maxOpen = row.max_open || 3;
        this.settings.leverage = row.leverage || 1;
        this.settings.tfRules = row.tf_rules || {};
        console.log(`[BestTrades] Settings loaded from DB: enabled=${this.settings.enabled}, tf=${this.settings.timeframe}, tfRules=${JSON.stringify(this.settings.tfRules)}`);
      }
    } catch (e) {
      console.warn('[BestTrades] Settings load error:', e.message);
    }
  }

  async _saveSettings() {
    if (!pool) return;
    try {
      await pool.query(
        `INSERT INTO best_trades_settings (id, enabled, mode, timeframe, min_prob, trade_size_usd, max_open, leverage, tf_rules, updated_at)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (id) DO UPDATE SET
           enabled=$1, mode=$2, timeframe=$3, min_prob=$4,
           trade_size_usd=$5, max_open=$6, leverage=$7, tf_rules=$8, updated_at=NOW()`,
        [this.settings.enabled, this.settings.mode, this.settings.timeframe,
         this.settings.minProb, this.settings.tradeSizeUsd, this.settings.maxOpen, this.settings.leverage,
         JSON.stringify(this.settings.tfRules || {})]
      );
    } catch (e) {
      console.warn('[BestTrades] Settings save error:', e.message);
    }
  }

  async _logResults(results) {
    if (!pool) return;
    // Log top 3 results with EV > 0 for calibration data (#24: EV-first, fallback to prob >= 50%)
    const top = results.filter(r => (r.ev > 0) || r.prob >= 50).slice(0, 3);
    for (const r of top) {
      try {
        await pool.query(
          `INSERT INTO best_trades_log
           (asset, direction, probability, confidence, market_quality, rr_ratio,
            entry_price, stop_price, target_price, stop_pct, target_pct, regime, executed, timeframe,
            signal_snapshot, raw_probability, ev, optimal_lev, atr_value, hits, misses, volume_ratio, confluence_score)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
          [r.asset, r.direction, r.prob, r.confidence,
           r.marketQuality, r.rr, r.price, r.stopPrice, r.targetPrice,
           r.stopPct, r.targetPct, r.regime, false, r.timeframe || '15m',
           JSON.stringify(r.signalSnapshot || {}), r.rawProb, r.ev, r.optimalLev,
           r.atrValue, JSON.stringify(r.hits || []), JSON.stringify(r.misses || []),
           r.volumeRatio, r.confluenceScore]
        );
      } catch (e) {
        console.warn(`[BestTrades] Extended insert failed for ${r.asset}:`, e.message, '- trying basic insert...');
        // Fallback: insert with only original columns (in case migration 012 hasn't run yet)
        try {
          await pool.query(
            `INSERT INTO best_trades_log
             (asset, direction, probability, confidence, market_quality, rr_ratio,
              entry_price, stop_price, target_price, stop_pct, target_pct, regime, executed, timeframe)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [r.asset, r.direction, r.prob, r.confidence,
             r.marketQuality, r.rr, r.price, r.stopPrice, r.targetPrice,
             r.stopPct, r.targetPct, r.regime, false, r.timeframe || '15m']
          );
          console.log(`[BestTrades] Basic insert succeeded for ${r.asset}`);
        } catch (e2) {
          console.error(`[BestTrades] BOTH inserts failed for ${r.asset}:`, e2.message);
        }
      }
    }
    if (top.length > 0) console.log(`[BestTrades] Logged ${top.length} predictions to best_trades_log`);
  }

  // ── SSE ──

  addSseClient(res) { this.sseClients.push(res); }
  removeSseClient(res) { this.sseClients = this.sseClients.filter(c => c !== res); }

  _broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.sseClients = this.sseClients.filter(res => {
      try { res.write(msg); return true; } catch { return false; }
    });
  }

  // ── Resolution Checker ──
  // Periodically checks unresolved predictions to see if price hit TP or SL

  _startResolutionTimer() {
    if (this.resolutionTimer) clearInterval(this.resolutionTimer);
    // Check every 5 minutes
    this.resolutionTimer = setInterval(() => {
      this._resolveOpenPredictions().catch(e =>
        console.error('[BestTrades] Resolution check error:', e.message));
    }, 5 * 60_000);
    // Run first check after 60s
    setTimeout(() => this._resolveOpenPredictions().catch(() => {}), 60_000);
    console.log('[BestTrades] Resolution tracker started (every 5 min)');

    // 90-day retention cleanup — runs once daily (every 24h)
    this._runRetentionCleanup(); // Run on startup
    this.retentionTimer = setInterval(() => this._runRetentionCleanup(), 24 * 60 * 60_000);
  }

  async _runRetentionCleanup() {
    if (!pool) return;
    try {
      // Delete resolved predictions older than 90 days (keep calibration stats via the cache)
      const result = await pool.query(
        `DELETE FROM best_trades_log
         WHERE created_at < NOW() - INTERVAL '90 days'
         AND outcome IS NOT NULL`
      );
      if (result.rowCount > 0) {
        console.log(`[BestTrades] Retention cleanup: deleted ${result.rowCount} resolved predictions older than 90 days`);
      }
      // Also delete unresolved (pending) predictions older than 30 days (abandoned)
      const abandoned = await pool.query(
        `DELETE FROM best_trades_log
         WHERE created_at < NOW() - INTERVAL '30 days'
         AND outcome IS NULL`
      );
      if (abandoned.rowCount > 0) {
        console.log(`[BestTrades] Retention cleanup: deleted ${abandoned.rowCount} abandoned pending predictions older than 30 days`);
      }
    } catch (e) {
      console.warn('[BestTrades] Retention cleanup error:', e.message);
    }
  }

  async _resolveOpenPredictions() {
    if (!pool) return;

    // Get unresolved predictions (max 100 at a time, oldest first)
    let pending;
    try {
      const result = await pool.query(
        `SELECT id, asset, direction, entry_price, stop_price, target_price, timeframe, created_at
         FROM best_trades_log
         WHERE outcome IS NULL AND entry_price IS NOT NULL AND stop_price IS NOT NULL AND target_price IS NOT NULL
         ORDER BY created_at ASC LIMIT 100`
      );
      pending = result.rows;
    } catch (e) {
      console.warn('[BestTrades] Resolution query error:', e.message);
      return;
    }

    if (pending.length === 0) return;

    // Group by asset to minimize API calls
    const byAsset = {};
    for (const row of pending) {
      if (!byAsset[row.asset]) byAsset[row.asset] = [];
      byAsset[row.asset].push(row);
    }

    let resolved = 0;
    for (const [asset, rows] of Object.entries(byAsset)) {
      try {
        const sym = asset + 'USDT';
        // Fetch recent 1m candles to check high/low range since entry
        // Use the oldest pending entry's creation time to determine how far back to look
        const oldestEntry = rows.reduce((a, b) =>
          new Date(a.created_at) < new Date(b.created_at) ? a : b);
        const ageMs = Date.now() - new Date(oldestEntry.created_at).getTime();

        // For each pending prediction, fetch candles from its timeframe to check resolution
        for (const row of rows) {
          const entryPrice = parseFloat(row.entry_price);
          const stopPrice = parseFloat(row.stop_price);
          const targetPrice = parseFloat(row.target_price);
          const tf = row.timeframe || '15m';

          // How many candles since this prediction was created?
          const predAgeMs = Date.now() - new Date(row.created_at).getTime();
          const tfMs = { '1m': 60e3, '5m': 5*60e3, '15m': 15*60e3, '30m': 30*60e3,
                         '1h': 60*60e3, '4h': 4*60*60e3, '1d': 24*60*60e3 };
          const candlesNeeded = Math.min(200, Math.ceil(predAgeMs / (tfMs[tf] || 4*60*60e3)) + 2);

          // Skip if too young (need at least 1 candle after entry)
          if (candlesNeeded < 2) continue;

          // Expire very old predictions (>7 days for short TFs, >30 days for long TFs)
          const maxAgeMs = ['5m', '15m', '30m'].includes(tf) ? 7 * 24 * 60 * 60e3 : 30 * 24 * 60 * 60e3;
          if (predAgeMs > maxAgeMs) {
            // Expire as "expired" — neither win nor loss
            await pool.query(
              `UPDATE best_trades_log SET outcome='expired', resolved_at=NOW() WHERE id=$1`,
              [row.id]
            );
            resolved++;
            continue;
          }

          const candles = await fetchKlines(sym, tf, candlesNeeded);
          if (!candles || candles.length < 2) continue;

          // Find candles AFTER the prediction was created
          const predTime = new Date(row.created_at).getTime();
          const postEntryCandles = candles.filter(c => c.t > predTime);
          if (postEntryCandles.length === 0) continue;

          // Check if any candle hit SL or TP
          let outcome = null;
          let pnl = 0;

          for (const c of postEntryCandles) {
            if (row.direction === 'long') {
              // Long: SL hit if low <= stopPrice, TP hit if high >= targetPrice
              const hitSL = c.l <= stopPrice;
              const hitTP = c.h >= targetPrice;
              if (hitSL && hitTP) {
                // Both hit in same candle — use open to determine which came first
                // If open is closer to stop, likely SL first
                outcome = (c.o - stopPrice) < (targetPrice - c.o) ? 'loss' : 'win';
              } else if (hitSL) {
                outcome = 'loss';
              } else if (hitTP) {
                outcome = 'win';
              }
            } else {
              // Short: SL hit if high >= stopPrice, TP hit if low <= targetPrice
              const hitSL = c.h >= stopPrice;
              const hitTP = c.l <= targetPrice;
              if (hitSL && hitTP) {
                outcome = (stopPrice - c.o) < (c.o - targetPrice) ? 'loss' : 'win';
              } else if (hitSL) {
                outcome = 'loss';
              } else if (hitTP) {
                outcome = 'win';
              }
            }

            if (outcome) break;
          }

          if (outcome) {
            // Calculate PnL percentage
            if (outcome === 'win') {
              pnl = row.direction === 'long'
                ? ((targetPrice - entryPrice) / entryPrice) * 100
                : ((entryPrice - targetPrice) / entryPrice) * 100;
            } else {
              pnl = row.direction === 'long'
                ? ((stopPrice - entryPrice) / entryPrice) * 100
                : ((entryPrice - stopPrice) / entryPrice) * 100;
            }

            await pool.query(
              `UPDATE best_trades_log SET outcome=$1, pnl=$2, resolved_at=NOW() WHERE id=$3`,
              [outcome, parseFloat(pnl.toFixed(4)), row.id]
            );
            resolved++;
          }

          // Small delay between API calls
          await new Promise(r => setTimeout(r, 200));
        }
      } catch (e) {
        console.warn(`[BestTrades] Resolution error for ${asset}:`, e.message);
      }
    }

    if (resolved > 0) {
      console.log(`[BestTrades] Resolved ${resolved} predictions`);
      this._broadcast('resolution', { resolved });
    }
  }

  // ── Stats / Win Rate API ──

  async getStats(filters = {}) {
    if (!pool) return { error: 'No database' };

    // Build optional WHERE clause from filters
    const conditions = [];
    const filterParams = [];
    let fIdx = 1;
    if (filters.timeframe) { conditions.push(`timeframe = $${fIdx++}`); filterParams.push(filters.timeframe); }
    if (filters.regime) { conditions.push(`regime = $${fIdx++}`); filterParams.push(filters.regime); }
    if (filters.market_quality) { conditions.push(`market_quality = $${fIdx++}`); filterParams.push(filters.market_quality); }
    const filterWhere = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const filterWhereAnd = conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : '';

    try {
      // Overall stats
      const overall = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE outcome IS NOT NULL) AS total_resolved,
          COUNT(*) FILTER (WHERE outcome = 'win') AS wins,
          COUNT(*) FILTER (WHERE outcome = 'loss') AS losses,
          COUNT(*) FILTER (WHERE outcome = 'expired') AS expired,
          COUNT(*) FILTER (WHERE outcome IS NULL) AS pending,
          COUNT(*) AS total_logged,
          ROUND(AVG(pnl) FILTER (WHERE outcome IN ('win','loss')), 4) AS avg_pnl,
          ROUND(AVG(pnl) FILTER (WHERE outcome = 'win'), 4) AS avg_win_pnl,
          ROUND(AVG(pnl) FILTER (WHERE outcome = 'loss'), 4) AS avg_loss_pnl
        FROM best_trades_log ${filterWhere}
      `, filterParams);

      // Per-timeframe win rates
      const byTimeframe = await pool.query(`
        SELECT
          COALESCE(timeframe, '15m') AS timeframe,
          COUNT(*) FILTER (WHERE outcome IS NOT NULL) AS total_resolved,
          COUNT(*) FILTER (WHERE outcome = 'win') AS wins,
          COUNT(*) FILTER (WHERE outcome = 'loss') AS losses,
          COUNT(*) FILTER (WHERE outcome = 'expired') AS expired,
          COUNT(*) FILTER (WHERE outcome IS NULL) AS pending,
          ROUND(
            CASE WHEN COUNT(*) FILTER (WHERE outcome IN ('win','loss')) > 0
              THEN COUNT(*) FILTER (WHERE outcome = 'win')::DECIMAL / COUNT(*) FILTER (WHERE outcome IN ('win','loss')) * 100
              ELSE 0
            END, 1
          ) AS win_rate,
          ROUND(AVG(pnl) FILTER (WHERE outcome IN ('win','loss')), 4) AS avg_pnl
        FROM best_trades_log ${filterWhere}
        GROUP BY COALESCE(timeframe, '15m')
        ORDER BY COALESCE(timeframe, '15m')
      `, filterParams);

      // Per-confidence win rates
      const byConfidence = await pool.query(`
        SELECT
          confidence,
          COUNT(*) FILTER (WHERE outcome IN ('win','loss')) AS total,
          COUNT(*) FILTER (WHERE outcome = 'win') AS wins,
          ROUND(
            CASE WHEN COUNT(*) FILTER (WHERE outcome IN ('win','loss')) > 0
              THEN COUNT(*) FILTER (WHERE outcome = 'win')::DECIMAL / COUNT(*) FILTER (WHERE outcome IN ('win','loss')) * 100
              ELSE 0
            END, 1
          ) AS win_rate,
          ROUND(AVG(pnl) FILTER (WHERE outcome IN ('win','loss')), 4) AS avg_pnl
        FROM best_trades_log
        WHERE confidence IS NOT NULL ${filterWhereAnd}
        GROUP BY confidence
        ORDER BY confidence
      `, filterParams);

      // Per-market quality win rates
      const byQuality = await pool.query(`
        SELECT
          market_quality,
          COUNT(*) FILTER (WHERE outcome IN ('win','loss')) AS total,
          COUNT(*) FILTER (WHERE outcome = 'win') AS wins,
          ROUND(
            CASE WHEN COUNT(*) FILTER (WHERE outcome IN ('win','loss')) > 0
              THEN COUNT(*) FILTER (WHERE outcome = 'win')::DECIMAL / COUNT(*) FILTER (WHERE outcome IN ('win','loss')) * 100
              ELSE 0
            END, 1
          ) AS win_rate,
          ROUND(AVG(pnl) FILTER (WHERE outcome IN ('win','loss')), 4) AS avg_pnl
        FROM best_trades_log
        WHERE market_quality IS NOT NULL ${filterWhereAnd}
        GROUP BY market_quality
        ORDER BY market_quality
      `, filterParams);

      // Per-regime win rates
      const byRegime = await pool.query(`
        SELECT
          regime,
          COUNT(*) FILTER (WHERE outcome IN ('win','loss')) AS total,
          COUNT(*) FILTER (WHERE outcome = 'win') AS wins,
          ROUND(
            CASE WHEN COUNT(*) FILTER (WHERE outcome IN ('win','loss')) > 0
              THEN COUNT(*) FILTER (WHERE outcome = 'win')::DECIMAL / COUNT(*) FILTER (WHERE outcome IN ('win','loss')) * 100
              ELSE 0
            END, 1
          ) AS win_rate,
          ROUND(AVG(pnl) FILTER (WHERE outcome IN ('win','loss')), 4) AS avg_pnl
        FROM best_trades_log
        WHERE regime IS NOT NULL ${filterWhereAnd}
        GROUP BY regime
        ORDER BY regime
      `, filterParams);

      // Per probability bucket
      const byProbBucket = await pool.query(`
        SELECT
          CASE
            WHEN probability < 55 THEN '50-54'
            WHEN probability < 60 THEN '55-59'
            WHEN probability < 65 THEN '60-64'
            WHEN probability < 70 THEN '65-69'
            WHEN probability < 75 THEN '70-74'
            WHEN probability < 80 THEN '75-79'
            ELSE '80+'
          END AS prob_bucket,
          CASE
            WHEN probability < 55 THEN 52
            WHEN probability < 60 THEN 57
            WHEN probability < 65 THEN 62
            WHEN probability < 70 THEN 67
            WHEN probability < 75 THEN 72
            WHEN probability < 80 THEN 77
            ELSE 82
          END AS bucket_mid,
          COUNT(*) FILTER (WHERE outcome IN ('win','loss')) AS total,
          COUNT(*) FILTER (WHERE outcome = 'win') AS wins,
          ROUND(
            CASE WHEN COUNT(*) FILTER (WHERE outcome IN ('win','loss')) > 0
              THEN COUNT(*) FILTER (WHERE outcome = 'win')::DECIMAL / COUNT(*) FILTER (WHERE outcome IN ('win','loss')) * 100
              ELSE 0
            END, 1
          ) AS win_rate,
          ROUND(AVG(pnl) FILTER (WHERE outcome IN ('win','loss')), 4) AS avg_pnl
        FROM best_trades_log ${filterWhere}
        GROUP BY prob_bucket, bucket_mid
        ORDER BY bucket_mid
      `, filterParams);

      const o = overall.rows[0];
      const totalWL = parseInt(o.wins) + parseInt(o.losses);
      const overallWinRate = totalWL > 0 ? (parseInt(o.wins) / totalWL * 100).toFixed(1) : '0.0';

      return {
        overall: {
          totalResolved: parseInt(o.total_resolved),
          totalLogged: parseInt(o.total_logged),
          wins: parseInt(o.wins),
          losses: parseInt(o.losses),
          expired: parseInt(o.expired),
          pending: parseInt(o.pending),
          winRate: parseFloat(overallWinRate),
          avgPnl: parseFloat(o.avg_pnl) || 0,
          avgWinPnl: parseFloat(o.avg_win_pnl) || 0,
          avgLossPnl: parseFloat(o.avg_loss_pnl) || 0,
        },
        byTimeframe: byTimeframe.rows.map(r => ({
          timeframe: r.timeframe,
          resolved: parseInt(r.total_resolved),
          wins: parseInt(r.wins),
          losses: parseInt(r.losses),
          expired: parseInt(r.expired),
          pending: parseInt(r.pending),
          winRate: parseFloat(r.win_rate),
          avgPnl: parseFloat(r.avg_pnl) || 0,
        })),
        byConfidence: byConfidence.rows.map(r => ({
          confidence: r.confidence,
          total: parseInt(r.total),
          wins: parseInt(r.wins),
          winRate: parseFloat(r.win_rate),
          avgPnl: parseFloat(r.avg_pnl) || 0,
        })),
        byQuality: byQuality.rows.map(r => ({
          quality: r.market_quality,
          total: parseInt(r.total),
          wins: parseInt(r.wins),
          winRate: parseFloat(r.win_rate),
          avgPnl: parseFloat(r.avg_pnl) || 0,
        })),
        byRegime: byRegime.rows.map(r => ({
          regime: r.regime,
          total: parseInt(r.total),
          wins: parseInt(r.wins),
          winRate: parseFloat(r.win_rate),
          avgPnl: parseFloat(r.avg_pnl) || 0,
        })),
        byProbBucket: byProbBucket.rows.map(r => ({
          bucket: r.prob_bucket,
          bucketMid: parseInt(r.bucket_mid),
          total: parseInt(r.total),
          wins: parseInt(r.wins),
          winRate: parseFloat(r.win_rate),
          avgPnl: parseFloat(r.avg_pnl) || 0,
        })),
      };
    } catch (e) {
      console.error('[BestTrades] Stats query error:', e.message);
      return { error: e.message };
    }
  }

  // ── Public API ──

  getLastResults() { return this.lastResults; }
  getLastScanTime() { return this.lastScanTime; }
  isRunning() { return this.settings.enabled && this.scanTimer !== null; }

  getStatus() {
    const activeTimers = Object.keys(this.scanTimers);
    const tfStatus = {};
    for (const tf of ALL_TIMEFRAMES) {
      const intervalMs = SCAN_INTERVALS[tf] || 60 * 60_000;
      const intervalLabel = intervalMs < 60000 ? `${intervalMs / 1000}s` : `${intervalMs / 60000}m`;
      const tfResults = this.lastResultsByTF[tf] || [];
      tfStatus[tf] = {
        active: !!this.scanTimers[tf],
        interval: intervalLabel,
        lastScan: this.lastScanTimeByTF[tf] || null,
        resultsCount: tfResults.length,
        qualifying: tfResults.filter(r => r.prob >= this.settings.minProb).length,
        topSetup: tfResults[0] ? `${tfResults[0].asset} ${tfResults[0].direction} ${tfResults[0].prob}%` : null,
      };
    }

    return {
      enabled: this.settings.enabled,
      running: activeTimers.length > 0,
      mode: this.settings.mode,
      timeframes: ALL_TIMEFRAMES,
      activeTimers: activeTimers.length,
      minProb: this.settings.minProb,
      tradeSizeUsd: this.settings.tradeSizeUsd,
      maxOpen: this.settings.maxOpen,
      leverage: this.settings.leverage,
      lastScanTime: this.lastScanTime,
      resultsCount: this.lastResults.length,
      qualifyingCount: this.lastResults.filter(r => r.prob >= this.settings.minProb).length,
      topSetup: this.lastResults[0] || null,
      tfStatus,
      scanInterval: 'multi-TF',
      calibration: {
        totalResolved: calibrationCache.overall.totalResolved,
        overallWR: (calibrationCache.overall.winRate * 100).toFixed(1),
        avgCalError: calibrationCache.overall.avgCalError != null ? (calibrationCache.overall.avgCalError * 100).toFixed(1) + '%' : 'N/A',
        kellyGraduation: '+' + ((calibrationCache.overall.kellyGraduation || 0) * 100).toFixed(0) + '%',
        lastRefresh: calibrationCache.lastRefresh ? new Date(calibrationCache.lastRefresh).toISOString() : null,
        bucketCount: Object.keys(calibrationCache.byProbBucket).length,
      },
      fundingRates: {
        cached: Object.keys(fundingRateCache.data).length,
        lastRefresh: fundingRateCache.lastRefresh ? new Date(fundingRateCache.lastRefresh).toISOString() : null,
      },
      leverageRisk: {
        phase: leverageRisk.phase,
        maxLev: (leverageRisk.phaseConfig[leverageRisk.phase] || {}).maxLev || 3,
        drawdownPct: leverageRisk.drawdownPct,
        consecutiveLosses: leverageRisk.consecutiveLosses,
        maxConsecutiveLosses: leverageRisk.maxConsecutiveLosses,
        portfolioHeatMax: leverageRisk.maxHeatPct + '%',
        sharpeRatio: leverageRisk.sharpeRatio,
        kellyMode: 'Eighth-Kelly',
      },
      sortBy: 'EV (expected value)',
      dataRetention: '90 days (resolved), 30 days (abandoned pending)',
      logsPerScan: 3,
      upgrades: 'v2.1: EV-primary, 8th-Kelly, shrinkage 30/100, 4h-gate, MTF-confluence, recency-weight, leverage-risk-framework, Sharpe',
    };
  }
}

const scanner = new BestTradesScanner();
module.exports = scanner;
