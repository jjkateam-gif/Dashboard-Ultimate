/**
 * Server-side Best Trades Scanner
 * Mirrors the frontend probability engine so trades execute 24/7 on Railway
 * even when the user's browser is closed.
 */
const { fetchKlines } = require('./binance');
const { sma, ema, rsi, stdev, atr } = require('./indicators');
const blofinClient = require('./blofinClient');
const liveEngine = require('./liveEngine');
const { detectPatterns } = require('./chartPatterns');
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
      'INJ-USDT', 'PEPE-USDT', 'WIF-USDT',
      // BONK-USDT removed 2026-03-20: not listed on BloFin (error 152002)
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
      } catch (e) {
        console.warn(`[BestTrades] Funding rate fetch failed for ${instId}: ${e.message}`);
      }
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
  { sym: 'RENDERUSDT', label: 'RENDER' },
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
  refreshIntervalMs: 10 * 60_000, // 10 minutes
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

  // #15 Quality gate per phase (B+ sits between A and B)
  const qualOrder = { 'A': 4, 'B+': 3, 'B': 2, 'C': 1, 'No-Trade': 0 };
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
    // Only learn from clean assets and post-fix trades (2026-03-18 calibration reset)
    const CALIBRATION_RESET_DATE = '2026-03-18T00:00:00Z';
    const CALIBRATION_EXCLUDED_ASSETS = ['AVAX','SUI','BNB','PEPE','APT','RENDER'];
    const excludeClause = `AND asset NOT IN (${CALIBRATION_EXCLUDED_ASSETS.map(a => `'${a}'`).join(',')}) AND resolved_at > '${CALIBRATION_RESET_DATE}'`;

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
      WHERE outcome IN ('win','loss') ${excludeClause}
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
      WHERE outcome IN ('win','loss') AND regime IS NOT NULL ${excludeClause}
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
      WHERE outcome IN ('win','loss') AND market_quality IS NOT NULL ${excludeClause}
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
      WHERE outcome IN ('win','loss') AND confidence IS NOT NULL ${excludeClause}
      GROUP BY confidence
    `);
    calibrationCache.byConfidence = {};
    for (const r of confRes.rows) {
      const n = parseInt(r.n);
      if (n > 0) {
        calibrationCache.byConfidence[r.confidence] = { winRate: parseInt(r.wins) / n, n };
      }
    }

    // 5. Overall stats for Kelly graduation (filtered to clean post-fix data)
    const overallRes = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE outcome IN ('win','loss')) AS total_resolved,
        COUNT(*) FILTER (WHERE outcome = 'win') AS wins
      FROM best_trades_log
      WHERE 1=1 ${excludeClause}
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
    const correction = diff * shrinkage * 0.4; // was 0.8, reduced to 0.4 until clean post-fix data builds up (2026-03-18)
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
    fastValue: emaF[last] != null ? Math.round(emaF[last] * 1e8) / 1e8 : null,
    slowValue: emaS[last] != null ? Math.round(emaS[last] * 1e8) / 1e8 : null,
    spreadPct: emaSpread ? Math.round(emaSpread * 1e4) / 1e4 : null,
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
    line: macdVal != null ? Math.round(macdVal * 1e8) / 1e8 : null,
    signal: macdSigVal != null ? Math.round(macdSigVal * 1e8) / 1e8 : null,
    histogram: (macdVal != null && macdSigVal != null) ? Math.round((macdVal - macdSigVal) * 1e8) / 1e8 : null,
    histogramPrev: (last > 0 && macdLine[last-1] != null && macdSig[last-1] != null) ? Math.round((macdLine[last-1] - macdSig[last-1]) * 1e8) / 1e8 : null,
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
    upper: bbUpper[last] != null ? Math.round(bbUpper[last] * 1e8) / 1e8 : null,
    lower: bbLower[last] != null ? Math.round(bbLower[last] * 1e8) / 1e8 : null,
    middle: bbMid[last] != null ? Math.round(bbMid[last] * 1e8) / 1e8 : null,
    positionPct: bbPct != null ? Math.round(bbPct * 1e4) / 1e4 : null,
    widthPct: (bbUpper[last] != null && bbLower[last] != null && bbMid[last] > 0) ? Math.round((bbUpper[last] - bbLower[last]) / bbMid[last] * 1e4) / 1e4 : null,
    bbwp: bbwp != null ? Math.round(bbwp * 1e4) / 1e4 : null,
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
    kValue: stK != null ? Math.round(stK * 100) / 100 : null,
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
    tenkan: ichiTenkan[last] != null ? Math.round(ichiTenkan[last] * 1e8) / 1e8 : null,
    kijun: ichiKijun[last] != null ? Math.round(ichiKijun[last] * 1e8) / 1e8 : null,
    cloudTop: cloudTop != null ? Math.round(cloudTop * 1e8) / 1e8 : null,
    cloudBottom: cloudBot != null ? Math.round(cloudBot * 1e8) / 1e8 : null,
    cloudThicknessPct: (cloudTop && cloudBot && price > 0) ? Math.round(Math.abs(cloudTop - cloudBot) / price * 1e4) / 1e4 : null,
    priceVsCloud: cloudTop && cloudBot ? (price > cloudTop ? 'above' : price < cloudBot ? 'below' : 'inside') : null,
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
  results.Volume = {
    bull: volBull, bear: volBear, drying: volDrying, ratio: volRatio,
    obvSlope: obvSlope ? Math.round(obvSlope * 1e4) / 1e4 : null,
    bodyRatio: bodyRatio ? Math.round(bodyRatio * 1e4) / 1e4 : null,
    isDoji,
  };

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
  const longTFs = ['4h', '6h', '8h', '12h', '1d', '3d', '1w'];
  const isShortTF = shortTFs.includes(tf);
  const isMedShortTF = medShortTFs.includes(tf);
  const isLongTF = longTFs.includes(tf);

  // Weights rebalanced 2026-03-18: EMA (+25pp edge) and Ichimoku (+22pp edge) highest,
  // MACD (+14pp edge) elevated, mean-reversion (RSI/StochRSI/BB) drastically reduced (bear-only now)
  let WEIGHTS = isShortTF ? { RSI: 7, StochRSI: 3, BB: 2, Volume: 15, MACD: 18, EMA: 30, Ichimoku: 25 }    // 5m, 15m — total 100
    : isMedShortTF ? { RSI: 8, StochRSI: 5, BB: 3, Volume: 14, MACD: 18, EMA: 28, Ichimoku: 24 }              // 30m, 1h — total 100
    : isLongTF ? { RSI: 6, StochRSI: 3, BB: 3, Volume: 12, MACD: 20, EMA: 30, Ichimoku: 26 }                   // 4h, 1d — total 100
    : { RSI: 8, StochRSI: 5, BB: 3, Volume: 14, MACD: 18, EMA: 28, Ichimoku: 24 };                             // fallback — total 100

  // Direction-aware weight override for shorts
  // MACD has +30pp edge on shorts (highest), EMA has -7pp (lagging)
  if (dir === 'bear') {
    WEIGHTS = { RSI: 10, StochRSI: 3, BB: 2, Volume: 15, MACD: 28, EMA: 20, Ichimoku: 22 };
  }

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

    let aligned = sig[dir] === true;
    const opposing = sig[opp] === true;
    const crossBonus = (dir === 'bull' && sig.crossBull) || (dir === 'bear' && sig.crossBear);
    const isMeanRev = meanRevInds.includes(ind);

    // ── DISABLE MEAN-REVERSION BULL SIGNALS FOR LONGS ──
    // Data analysis on 619+ trades shows these signals destroy long edge:
    // RSI oversold bull signal DISABLED — data shows -18.1pp edge on 619 trades
    // BB lower band bull signal DISABLED — data shows -13.8pp edge
    // StochRSI oversold bull signal DISABLED — data shows -7.6pp edge
    // Keep bear signals (overbought/upper band) for shorts — those work.
    if (dir === 'bull' && aligned && (ind === 'RSI' || ind === 'BB' || ind === 'StochRSI')) {
      aligned = false; // treat as neutral for longs
    }

    // Weak asset confirmation: mean-reversion oversold signals CONFIRM shorts
    // MACD bear + RSI oversold = 87.5% WR on 64 trades (golden combo)
    if (dir === 'bear' && aligned && (ind === 'RSI' || ind === 'StochRSI' || ind === 'BB')) {
      // RSI/StochRSI/BB showing oversold on a short = asset is WEAK, not bouncing
      const boostFactor = ind === 'RSI' ? 1.5 : ind === 'StochRSI' ? 1.3 : 1.2;
      const family = FAMILIES[ind] || 'other';
      const famIdx = familyCount[family] || 0;
      const dampening = FAMILY_DECAY[Math.min(famIdx, FAMILY_DECAY.length - 1)];
      familyCount[family] = famIdx + 1;
      score += w * boostFactor * dampening;
      aligned = false; // Don't double-count in normal scoring below
    }

    // StochRSI overbought (bear) on shorts has -27pp edge — fires when short is overextended
    if (dir === 'bear' && ind === 'StochRSI' && sig.bear) {
      aligned = false; // Disable stochrsi_bear contribution to shorts
    }

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
  let prob = 35 + (65 - 35) / (1 + Math.exp(-sigK * (confluence - 0.5)));

  // Regime adjustment (±4)
  if (regime === 'bull' && direction === 'long') prob += 4;
  if (regime === 'bull' && direction === 'short') prob -= 4;
  if (regime === 'bear' && direction === 'short') prob += 4;
  if (regime === 'bear' && direction === 'long') prob -= 4;

  // Confidence thresholds: tuned to actual confluence distribution
  // With family dampening [1.0, 0.60, 0.35] and opposing penalty (-0.4w),
  // typical confluence is 0.15-0.40. Max possible ~0.72 (all 7 aligned, no opposition).
  // Thresholds: High >= 0.38 (strong alignment), Medium >= 0.22 (decent), Low < 0.22
  const confidence = confluence >= 0.38 ? 'High' : confluence >= 0.22 ? 'Medium' : 'Low';
  let probCap = confidence === 'High' ? 80 : confidence === 'Medium' ? 72 : 62;
  if (confidence === 'High' && marketQuality === 'A') probCap = 85;
  else if (confidence === 'High' && marketQuality === 'B+') probCap = 80;
  else if (confidence === 'High' && marketQuality === 'B') probCap = 76;
  if (marketQuality === 'C') probCap = Math.min(probCap, 65);
  if (marketQuality === 'No-Trade') probCap = Math.min(probCap, 55);
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
      tradeSizeMode: 'fixed',  // 'fixed' ($) or 'percent' (% of wallet balance)
      sizingMode: 'kelly',    // 'kelly' = Kelly-adjusted sizing/leverage, 'fixed' = exact size, no Kelly scaling
      maxOpen: 3,
      leverage: 1,
      tfRules: {},  // Per-TF overrides: { "5m": { enabled: true, minProb: 60, minQuality: "B" }, ... }
      bannedAssets: [],  // Assets banned from LIVE TRADING (still scanned & logged for data collection)
      assetOverrides: { 'ETH': { minProb: 72 } },  // Per-asset minimum probability overrides
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
    this.watchlistCandidates = {};
    this.signalDirectionHistory = {}; // { 'BTC_15m': { direction: 'short', count: 5 } }
  }

  _updateWatchlistCandidate(asset, tf, scanResult) {
    const key = `${asset}_${tf}`;
    const prev = this.watchlistCandidates[key];

    // Calculate readiness from available scan data
    // scanResult has: prob, direction, marketQuality, confidence, indicators from signal computation
    // Readiness = how close to qualifying (prob >= 50 and EV > 0)
    const probReadiness = Math.min(100, Math.max(0, (scanResult.prob || 0) / 50 * 100));
    const evReadiness = scanResult.ev > 0 ? 100 : Math.min(100, Math.max(0, 50 + (scanResult.ev || -1) * 50));
    const qualityBonus = scanResult.marketQuality === 'A' ? 20 : scanResult.marketQuality === 'B+' ? 10 : 0;

    const readiness = Math.round(Math.min(100, probReadiness * 0.5 + evReadiness * 0.3 + qualityBonus));

    if (readiness < 40) {
      delete this.watchlistCandidates[key];
      return;
    }

    const history = [...(prev?.history || []).slice(-4), readiness];
    const trajectory = history.length >= 3 ? history[history.length - 1] - history[0] : 0;

    this.watchlistCandidates[key] = {
      asset,
      timeframe: tf,
      direction: scanResult.direction || 'long',
      readinessScore: readiness,
      prob: scanResult.prob || 0,
      ev: scanResult.ev || 0,
      marketQuality: scanResult.marketQuality || '?',
      confidence: scanResult.confidence || '?',
      history,
      trajectory,
      lastUpdate: new Date().toISOString(),
    };
  }

  getWatchlistCandidates() {
    return Object.values(this.watchlistCandidates)
      .filter(c => c.readinessScore >= 40)
      .sort((a, b) => b.readinessScore - a.readinessScore);
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
        // Auto-migrate: add cross-TF summary columns
        await pool.query(`
          ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS tf_bear_count INTEGER;
          ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS tf_bull_count INTEGER;
          ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS tf_alignment_score INTEGER;
          ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS highest_tf_conflict VARCHAR(10);
        `).catch(() => {});
        console.log(`[BestTrades] Cross-TF columns migration applied`);
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
    console.log(`[BestTrades] Scanner v2.2 initialized. Auto-trade: ${this.settings.enabled ? 'ON (' + this.settings.mode + ')' : 'OFF (scan-only)'}. Scanning ALL timeframes: ${ALL_TIMEFRAMES.join(', ')}`);
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
      delay += 30000; // 30s stagger between TFs to avoid BloFin rate limits

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

  // ── Ranging Market Detection ──

  _isRangingMarket(candles, atr) {
    if (!candles || candles.length < 20 || !atr) return false;
    const last20 = candles.slice(-20);
    const high = Math.max(...last20.map(c => parseFloat(c.h || c.high || c[2] || 0)));
    const low = Math.min(...last20.map(c => parseFloat(c.l || c.low || c[3] || 0)));
    const range = high - low;
    const rangeToATR = range / (atr * 20);
    return rangeToATR < 1.5;
  }

  // ── Market Structure Detection (HH/HL) — logging only, does NOT affect scoring ──

  _detectMarketStructure(candles) {
    if (!candles || candles.length < 50) return { structure: 'unknown', swings: [] };

    // Find swing highs and lows using a 5-bar lookback
    const swingHighs = [];
    const swingLows = [];

    for (let i = 5; i < candles.length - 5; i++) {
      const high = parseFloat(candles[i].h || candles[i].high || candles[i][2] || 0);
      const low = parseFloat(candles[i].l || candles[i].low || candles[i][3] || 0);

      let isSwingHigh = true;
      let isSwingLow = true;

      for (let j = 1; j <= 5; j++) {
        const prevH = parseFloat(candles[i-j].h || candles[i-j].high || candles[i-j][2] || 0);
        const nextH = parseFloat(candles[i+j].h || candles[i+j].high || candles[i+j][2] || 0);
        const prevL = parseFloat(candles[i-j].l || candles[i-j].low || candles[i-j][3] || 0);
        const nextL = parseFloat(candles[i+j].l || candles[i+j].low || candles[i+j][3] || 0);

        if (high <= prevH || high <= nextH) isSwingHigh = false;
        if (low >= prevL || low >= nextL) isSwingLow = false;
      }

      if (isSwingHigh) swingHighs.push({ index: i, price: high });
      if (isSwingLow) swingLows.push({ index: i, price: low });
    }

    // Need at least 3 swing highs and 3 swing lows
    const recentHighs = swingHighs.slice(-3);
    const recentLows = swingLows.slice(-3);

    if (recentHighs.length < 2 || recentLows.length < 2) {
      return { structure: 'insufficient_data', swings: { highs: recentHighs.length, lows: recentLows.length } };
    }

    const higherHighs = recentHighs.length >= 2 && recentHighs[recentHighs.length-1].price > recentHighs[recentHighs.length-2].price;
    const higherLows = recentLows.length >= 2 && recentLows[recentLows.length-1].price > recentLows[recentLows.length-2].price;
    const lowerHighs = recentHighs.length >= 2 && recentHighs[recentHighs.length-1].price < recentHighs[recentHighs.length-2].price;
    const lowerLows = recentLows.length >= 2 && recentLows[recentLows.length-1].price < recentLows[recentLows.length-2].price;

    let structure = 'ranging';
    if (higherHighs && higherLows) structure = 'uptrend';
    else if (lowerHighs && lowerLows) structure = 'downtrend';
    else if (higherHighs && lowerLows) structure = 'expanding';
    else if (lowerHighs && higherLows) structure = 'contracting';

    return {
      structure,
      higherHighs,
      higherLows,
      lowerHighs,
      lowerLows,
      lastSwingHigh: recentHighs[recentHighs.length-1]?.price || null,
      lastSwingLow: recentLows[recentLows.length-1]?.price || null,
      swingHighCount: swingHighs.length,
      swingLowCount: swingLows.length,
    };
  }

  // ── Funding Rate Scoring — logging only, does NOT affect scoring ──

  _scoreFundingRate(fundingRate, direction) {
    if (!fundingRate && fundingRate !== 0) return { score: 0, signal: 'unavailable', percentile: null };

    // Thresholds based on typical crypto perpetual funding rates
    // Positive = longs paying shorts (market overleveraged long)
    // Negative = shorts paying longs (market overleveraged short)
    const rate = parseFloat(fundingRate) || 0;

    let signal = 'neutral';
    let score = 0; // -1 to +1 scale
    let strength = 'neutral';

    if (rate > 0.0005) {
      signal = 'extreme_long_crowding';
      score = direction === 'short' ? 1.0 : -1.0; // Favors shorts
      strength = 'strong';
    } else if (rate > 0.0002) {
      signal = 'elevated_long_bias';
      score = direction === 'short' ? 0.5 : -0.5;
      strength = 'moderate';
    } else if (rate < -0.0005) {
      signal = 'extreme_short_crowding';
      score = direction === 'long' ? 1.0 : -1.0; // Favors longs (squeeze risk)
      strength = 'strong';
    } else if (rate < -0.0002) {
      signal = 'elevated_short_bias';
      score = direction === 'long' ? 0.5 : -0.5;
      strength = 'moderate';
    }

    // What probability adjustment WOULD be at 8% weight
    const hypotheticalProbAdj = Math.round(score * 8); // -8 to +8 pp

    return {
      rate,
      signal,
      score,
      strength,
      favors: score > 0 ? direction : (score < 0 ? (direction === 'long' ? 'short' : 'long') : 'neutral'),
      hypothetical_prob_adj: hypotheticalProbAdj,
      hypothetical_weight_pct: 8,
    };
  }

  // ── Cross-Timeframe Snapshot Collection ──

  _getCrossTFSnapshot(asset, entryTF) {
    const TFS = ['5m', '15m', '30m', '1h', '4h'];
    const snapshot = {};

    for (const tf of TFS) {
      // Get the most recent scan results for this TF
      const tfResults = this.lastResultsByTF[tf] || [];
      const assetResult = tfResults.find(r => r.asset === asset);

      if (!assetResult || !assetResult.signalSnapshot) {
        snapshot[tf] = { available: false, stale: true };
        continue;
      }

      // Check freshness — if data is too old, mark as stale
      const scanTime = this.lastScanTimeByTF[tf];
      const ageMs = scanTime ? Date.now() - new Date(scanTime).getTime() : Infinity;
      const maxAgeMs = { '5m': 10*60000, '15m': 20*60000, '30m': 40*60000, '1h': 90*60000, '4h': 180*60000 };
      const isStale = ageMs > (maxAgeMs[tf] || 90*60000);

      const sig = assetResult.signalSnapshot || {};
      snapshot[tf] = {
        available: true,
        stale: isStale,
        ageMinutes: Math.round(ageMs / 60000),
        // Per-indicator data (keys match computeSignals output: RSI, EMA, MACD, Ichimoku, StochRSI, BB, Volume)
        macd_bull: sig.MACD?.bull || false,
        macd_bear: sig.MACD?.bear || false,
        ema_bull: sig.EMA?.bull || false,
        ema_bear: sig.EMA?.bear || false,
        ichimoku_bull: sig.Ichimoku?.bull || false,
        ichimoku_bear: sig.Ichimoku?.bear || false,
        rsi_value: sig.RSI?.value || 0,
        rsi_bull: sig.RSI?.bull || false,
        rsi_bear: sig.RSI?.bear || false,
        stochrsi_bull: sig.StochRSI?.bull || false,
        stochrsi_bear: sig.StochRSI?.bear || false,
        bb_bull: sig.BB?.bull || false,
        bb_bear: sig.BB?.bear || false,
        volume_bull: sig.Volume?.bull || false,
        volume_bear: sig.Volume?.bear || false,
        volume_ratio: sig.Volume?.ratio || 0,
      };
    }

    return snapshot;
  }

  // ── Cross-Timeframe Summary Calculator ──

  _calculateCrossTFSummary(crossTF, direction) {
    const TF_WEIGHTS = { '5m': 1, '15m': 2, '30m': 3, '1h': 4, '4h': 5 };
    let bearCount = 0, bullCount = 0, alignmentScore = 0;
    let macdBearCount = 0, macdBullCount = 0;
    let volumeConfirming = 0;
    let highestConflictTF = null;
    const rsiValues = {};

    for (const [tf, data] of Object.entries(crossTF)) {
      if (!data.available || data.stale) continue;
      const weight = TF_WEIGHTS[tf] || 1;

      // Count bear/bull indicators on this TF
      const bearSignals = [data.macd_bear, data.ema_bear, data.ichimoku_bear, data.rsi_bear, data.stochrsi_bear, data.bb_bear, data.volume_bear].filter(Boolean).length;
      const bullSignals = [data.macd_bull, data.ema_bull, data.ichimoku_bull, data.rsi_bull, data.stochrsi_bull, data.bb_bull, data.volume_bull].filter(Boolean).length;

      const tfDirection = bearSignals > bullSignals ? 'bear' : bullSignals > bearSignals ? 'bull' : 'neutral';

      if (tfDirection === 'bear') bearCount++;
      if (tfDirection === 'bull') bullCount++;

      // Alignment with trade direction
      if ((direction === 'short' && tfDirection === 'bear') || (direction === 'long' && tfDirection === 'bull')) {
        alignmentScore += weight;
      } else if (tfDirection !== 'neutral') {
        // This TF conflicts with trade direction
        if (!highestConflictTF || weight > (TF_WEIGHTS[highestConflictTF] || 0)) {
          highestConflictTF = tf;
        }
      }

      if (data.macd_bear) macdBearCount++;
      if (data.macd_bull) macdBullCount++;
      if ((direction === 'short' && data.volume_bear) || (direction === 'long' && data.volume_bull)) volumeConfirming++;

      if (data.rsi_value) rsiValues[tf] = data.rsi_value;
    }

    // Detect RSI cascade
    const orderedTFs = ['5m', '15m', '30m', '1h', '4h'];
    const rsiOrdered = orderedTFs.map(tf => rsiValues[tf]).filter(v => v > 0);
    let rsiCascade = 'mixed';
    if (rsiOrdered.length >= 3) {
      const ascending = rsiOrdered.every((v, i) => i === 0 || v >= rsiOrdered[i-1]);
      const descending = rsiOrdered.every((v, i) => i === 0 || v <= rsiOrdered[i-1]);
      if (ascending) rsiCascade = 'ascending';
      if (descending) rsiCascade = 'descending';
    }

    // Ichimoku cascade
    const ichiCounts = Object.values(crossTF).filter(d => d.available && !d.stale);
    const ichiBearCount = ichiCounts.filter(d => d.ichimoku_bear).length;
    const ichiBullCount = ichiCounts.filter(d => d.ichimoku_bull).length;
    const ichiCascade = ichiBearCount === ichiCounts.length ? 'full_bear' : ichiBullCount === ichiCounts.length ? 'full_bull' : 'mixed';

    return {
      bear_alignment: bearCount,
      bull_alignment: bullCount,
      alignment_score: alignmentScore, // 0-15 (TF weighted)
      max_score: 15,
      highest_conflict_tf: highestConflictTF,
      macd_bear_count: macdBearCount,
      macd_bull_count: macdBullCount,
      volume_confirming: volumeConfirming,
      rsi_cascade: rsiCascade,
      ichimoku_cascade: ichiCascade,
    };
  }

  // ── Flip Confidence Gate ──

  _checkFlipConfidence(asset, tf, direction) {
    const key = `${asset}_${tf}`;
    const prev = this.signalDirectionHistory[key];

    if (!prev || prev.direction !== direction) {
      // Direction changed — first signal in new direction
      this.signalDirectionHistory[key] = { direction, count: 1 };
      return { skip: true, reason: `Trend flip on ${asset} ${tf} — waiting for confirmation (was ${prev?.direction || 'none'}, now ${direction})` };
    }

    prev.count++;
    this.signalDirectionHistory[key] = prev;

    return { skip: false, count: prev.count };
  }

  // ── Scan a Single Timeframe ──

  async _scanTimeframe(tf) {
    // BULLETPROOF: Entire scan wrapped in master try/catch. This function must NEVER throw
    // because if it does, predictions stop logging and the engine stops learning.
    try {
    // Scanning always runs (for prediction logging & calibration). Auto-trading is gated separately in _processAutoTrades().
    // Refresh calibration cache, funding rates, and leverage risk (no-op if refreshed recently)
    await refreshCalibrationCache();
    await refreshFundingRates();
    await refreshLeverageRisk();
    console.log(`[BestTrades] Scanning ${ASSETS.length} assets on ${tf}...`);

    const results = [];
    let btcRegime = 'neutral';

    // Scan BTC on 1d for macro regime (always daily, regardless of scan TF)
    try {
      const btcCandles = await fetchKlines('BTCUSDT', '1d', 200);
      if (btcCandles && btcCandles.length > 50) {
        btcRegime = detectRegime(btcCandles);
      }
    } catch (e) {
      console.warn(`[BestTrades] BTC regime fetch error (1d):`, e.message);
    }

    // Scan all assets
    let scannedCount = 0, skippedCount = 0, errorCount = 0;
    for (const asset of ASSETS) {
      try {
        // Fetch more candles for short TFs so EMA200 has enough history
        // 5m: 500 candles = ~41.7h, 15m: 500 = ~5.2 days (was 200 = 16.7h/2.1d)
        const candleCount = (tf === '5m' || tf === '15m') ? 500 : 200;
        const candles = await fetchKlines(asset.sym, tf, candleCount);
        if (!candles || candles.length < 50) { skippedCount++; continue; }

        const analysis = computeSignals(candles, tf);
        const { signals, atr: atrVal, price, marketQuality, entryEfficiency, adxVal, ema200Val } = analysis;
        scannedCount++;

        // #27 — 4h regime gate: Skip 4h unless confirmed trending (ADX>20 + price above/below EMA200)
        if (tf === '4h' && adxVal != null && adxVal < 20) {
          continue; // not trending — skip this asset on 4h
        }

        // Ranging market detection — soft flag (penalty, NOT hard block)
        // User requirement: "make money in ANY market condition"
        // Hard block was killing ALL signals in choppy markets — now logs + applies -4pp penalty
        const isRanging = this._isRangingMarket(candles, atrVal);
        if (isRanging) {
          if (!this.lastLogAttempt) this.lastLogAttempt = {};
          if (!this.lastLogAttempt[tf]) this.lastLogAttempt[tf] = {};
          this.lastLogAttempt[tf].rangingDetected = (this.lastLogAttempt[tf].rangingDetected || 0) + 1;
        }

        // All assets use BTC 1d regime for consistency
        const regime = btcRegime;

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

        // ── CHART PATTERN DETECTION ──
        const patternResult = detectPatterns(candles, tf, regime);
        const patternAdj = patternResult.probabilityAdj || 0;

        // Log detected patterns (MUST be after patternResult declaration)
        if (patternResult.patterns.length > 0 && scannedCount <= 5) {
          console.log(`[BestTrades] ${asset.label} ${tf} PATTERNS: ${patternResult.patternSummary} → adj: ${patternAdj > 0 ? '+' : ''}${patternAdj.toFixed(1)}%`);
        }

        // ── VOLUME AS MOMENTUM SIGNAL — data shows 1-2x is danger zone, >3x is real ──
        const volumeRatio = signals.Volume?.ratio || 1;
        let volAdjustedProb = best.prob;
        if (volumeRatio > 5.0)       volAdjustedProb *= 1.20;
        else if (volumeRatio > 3.0)  volAdjustedProb *= 1.12;
        else if (volumeRatio > 2.0)  volAdjustedProb *= 1.05;
        else if (volumeRatio >= 1.0 && volumeRatio < 2.0) volAdjustedProb *= 0.95; // danger zone
        else if (volumeRatio >= 0.5 && volumeRatio < 1.0) volAdjustedProb *= 0.92; // below-average volume
        else if (volumeRatio < 0.5)  volAdjustedProb *= 0.85;

        // ── CALIBRATION: Adjust probability using historical accuracy ──
        const rawProb = Math.max(25, Math.min(85, Math.round(volAdjustedProb)));
        let calibratedProb = calibrateProb(rawProb, regime, tf, marketQuality);
        calibratedProb += mtfBonus; // Apply multi-TF confluence adjustment
        calibratedProb += patternAdj; // Apply chart pattern adjustment (±15% cap)
        calibratedProb = Math.max(25, Math.min(85, calibratedProb));

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

        // ── CROSS-TIMEFRAME INDICATOR LOGGING ──
        let crossTF = {};
        let crossTFSummary = null;
        try {
          crossTF = this._getCrossTFSnapshot(asset.label, tf);
          crossTFSummary = this._calculateCrossTFSummary(crossTF, direction);
        } catch (ctfErr) {
          console.warn(`[BestTrades] Cross-TF snapshot/summary error for ${asset.label} ${tf}:`, ctfErr.message);
        }

        // Cross-TF alignment adjustment
        if (crossTFSummary && crossTFSummary.alignment_score !== undefined) {
          const score = crossTFSummary.alignment_score;
          let tfAdj = 0;
          if (score >= 12) tfAdj = 6;        // Excellent alignment: +6pp
          else if (score >= 9) tfAdj = 3;    // Good alignment: +3pp
          else if (score >= 6) tfAdj = 0;    // Marginal: no change
          else tfAdj = -6;                    // Weak alignment: -6pp

          calibratedProb += tfAdj;
          calibratedProb = Math.max(25, Math.min(85, calibratedProb));
        }

        // Ranging market penalty — soft adjustment, NOT a hard block
        if (isRanging) {
          calibratedProb -= 4;  // -4pp penalty for choppy market
          calibratedProb = Math.max(25, Math.min(85, calibratedProb));
        }

        // Market structure detection (logging only — does NOT affect scoring)
        let marketStructure = { structure: 'unknown', swings: [] };
        try {
          marketStructure = this._detectMarketStructure(candles);
        } catch (msErr) {
          console.warn(`[BestTrades] Market structure error for ${asset.label} ${tf}:`, msErr.message);
        }

        // Funding rate scoring (logging only — does NOT affect scoring)
        let fundingRateScore = { score: 0, signal: 'unavailable', percentile: null };
        try {
          fundingRateScore = this._scoreFundingRate(fundingRate, direction);
        } catch (frErr) {
          console.warn(`[BestTrades] Funding rate score error for ${asset.label} ${tf}:`, frErr.message);
        }

        // Estimate R/R using calibrated probability
        const rrData = estimateRR(price, atrVal, direction, calibratedProb, this.settings.leverage,
          best.confidence, candles, marketQuality);

        // Build signal snapshot for learning — copies ALL fields including numeric values
        const signalSnapshot = {};
        for (const [ind, sig] of Object.entries(signals)) {
          if (sig && typeof sig === 'object') {
            signalSnapshot[ind] = { ...sig };
          }
        }
        // Add funding rate to snapshot
        signalSnapshot.fundingRate = fundingRate;
        // Add chart patterns to snapshot for learning/calibration
        if (patternResult.patterns.length > 0) {
          signalSnapshot.chartPatterns = patternResult.patterns.map(p => ({
            name: p.name, type: p.type, direction: p.direction,
            stage: p.stage, score: Math.round(p.score * 1000) / 1000,
            baseWinRate: p.baseWinRate,
          }));
          signalSnapshot.patternAdj = patternAdj;
          signalSnapshot.patternComposite = patternResult.compositeScore;
        }

        const _scanResult = {
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
          patterns: patternResult.patterns,
          patternAdj,
          patternSummary: patternResult.patternSummary,
          signalSnapshot,
          isRanging,
          crossTF,
          crossTFSummary,
          marketStructure,
          fundingRateScore,
          timestamp: new Date().toISOString(),
        };
        results.push(_scanResult);

        // Update watchlist candidate (before qualifying filter)
        try {
          this._updateWatchlistCandidate(_scanResult.asset, tf, _scanResult);
        } catch (wlErr) {
          console.warn(`[BestTrades] Watchlist update error for ${_scanResult.asset} ${tf}:`, wlErr.message);
        }

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
    try {
      await this._logResults(results);
    } catch (logErr) {
      console.error(`[BestTrades] _logResults crashed for ${tf}: ${logErr.message}`);
    }

    // Process auto-trades (with cross-TF dedup)
    try {
      await this._processAutoTrades(results, tf);
    } catch (autoTradeErr) {
      console.error(`[BestTrades] _processAutoTrades crashed for ${tf}: ${autoTradeErr.message}`);
    }

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
    } catch (masterError) {
      // BULLETPROOF: Log but NEVER let this crash. The engine must keep learning.
      console.error(`[BestTrades] ❌ MASTER CATCH — ${tf} scan failed entirely: ${masterError.message}`);
      console.error(`[BestTrades] Stack: ${masterError.stack?.split('\n').slice(0, 3).join(' | ')}`);
      return [];
    }
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

    // 2026-03-18: Disable 1h auto-trade execution until data proves quality
    // Auto re-enable when 1h post-fix WR >= 55% on 30+ resolved trades
    if (tf === '1h') {
      try {
        const h1Check = await pool.query(`
          SELECT COUNT(*) FILTER (WHERE outcome IS NOT NULL) as resolved,
                 ROUND(100.0 * COUNT(*) FILTER (WHERE outcome='win') / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as wr
          FROM best_trades_log WHERE timeframe = '1h' AND created_at > '2026-03-18'
        `);
        const h1Resolved = parseInt(h1Check.rows[0]?.resolved) || 0;
        const h1WR = parseFloat(h1Check.rows[0]?.wr) || 0;
        if (h1Resolved < 30 || h1WR < 55) {
          console.log(`[BestTrades] Auto-trade: 1h DISABLED (scan-only) — post-fix WR ${h1WR}% on ${h1Resolved} trades (need 55%+ on 30+)`);
          return;
        }
        console.log(`[BestTrades] Auto-trade: 1h RE-ENABLED — post-fix WR ${h1WR}% on ${h1Resolved} trades`);
      } catch (h1Err) {
        console.warn(`[BestTrades] 1h WR gate query failed (skipping auto-trade for safety):`, h1Err.message);
        return;
      }
    }

    // Check per-TF rule: if this TF is explicitly disabled, skip
    const tfRule = this.settings.tfRules[tf];
    if (tfRule && tfRule.enabled === false) {
      console.log(`[BestTrades] Auto-trade: ${tf} disabled by per-TF rule — skipping`);
      return;
    }

    // Per-TF thresholds (fallback to global settings)
    const minProb = (tfRule && tfRule.minProb) || this.settings.minProb;
    // 2026-03-18: Raise 15m quality floor from C to B
    const minQuality = tf === '15m' ? 'B' : ((tfRule && tfRule.minQuality) || null);
    const minConfidence = (tfRule && tfRule.minConfidence) || null;

    // Clean stale trade dedup keys (expire after 30 min for short TFs, 4h for long TFs)
    const dedupeExpiry = ['5m', '15m', '30m'].includes(tf) ? 30 * 60_000 : 4 * 60 * 60_000;
    const now = Date.now();
    for (const key of this.recentTrades) {
      const [, , ts] = key.split('|');
      if (ts && now - parseInt(ts) > dedupeExpiry) this.recentTrades.delete(key);
    }

    // Filter qualifying setups using per-TF rules (with debug logging)
    const rejectReasons = {};
    const bannedSet = new Set((this.settings.bannedAssets || []).map(a => a.toUpperCase()));
    const qualifying = results.filter(r => {
      // BANNED ASSET CHECK — asset is banned from live trading (still logged for data collection)
      if (bannedSet.has(r.asset.toUpperCase())) { rejectReasons[r.asset] = `BANNED from live trading`; return false; }

      // Market structure gate — validated March 20: contracting/uptrend shorts = 0-18% WR
      if (r.marketStructure && r.marketStructure.structure) {
        const ms = r.marketStructure.structure;
        if (ms === 'contracting') {
          rejectReasons[r.asset] = `Market structure CONTRACTING — all signals blocked (0% WR)`;
          return false;
        }
        if (ms === 'uptrend' && r.direction === 'short') {
          rejectReasons[r.asset] = `Market structure UPTREND — shorts blocked (18% WR)`;
          return false;
        }
        if (ms === 'downtrend' && r.direction === 'long') {
          rejectReasons[r.asset] = `Market structure DOWNTREND — longs blocked`;
          return false;
        }
      }

      // 4h conflict: LOG as flag but do NOT block — collecting data to validate first
      if (r.crossTFSummary) {
        const h4Data = r.crossTF?.['4h'];
        if (h4Data && h4Data.available && !h4Data.stale) {
          const h4Bear = [h4Data.macd_bear, h4Data.ema_bear, h4Data.ichimoku_bear].filter(Boolean).length;
          const h4Bull = [h4Data.macd_bull, h4Data.ema_bull, h4Data.ichimoku_bull].filter(Boolean).length;
          const h4Direction = h4Bear > h4Bull ? 'bear' : h4Bull > h4Bear ? 'bull' : 'neutral';

          if (r.direction === 'short' && h4Direction === 'bull') {
            r.h4Conflict = true;
            r.h4ConflictReason = '4h bullish — short against macro trend';
          } else if (r.direction === 'long' && h4Direction === 'bear') {
            r.h4Conflict = true;
            r.h4ConflictReason = '4h bearish — long against macro trend';
          }
        }
      }

      // Per-asset minimum probability override
      const assetOverride = (this.settings.assetOverrides || {})[r.asset.toUpperCase()] || {};
      const effectiveMinProb = assetOverride.minProb || minProb;
      if (r.prob < effectiveMinProb) { rejectReasons[r.asset] = `prob ${r.prob}% < min ${effectiveMinProb}%`; return false; }
      if (r.marketQuality !== 'A') { rejectReasons[r.asset] = `quality ${r.marketQuality} — only A-grade allowed`; return false; }
      if (minQuality && (QUALITY_ORDER[r.marketQuality] || 0) < (QUALITY_ORDER[minQuality] || 0)) { rejectReasons[r.asset] = `quality ${r.marketQuality} < min ${minQuality}`; return false; }
      // Confidence filter: only apply if per-TF rule explicitly sets minConfidence
      if (minConfidence) {
        const confOrder = { 'High': 3, 'Medium': 2, 'Low': 1 };
        if ((confOrder[r.confidence] || 0) < (confOrder[minConfidence] || 0)) { rejectReasons[r.asset] = `conf ${r.confidence} < min ${minConfidence}`; return false; }
      }
      if (r.entryEfficiency === 'Chasing') { rejectReasons[r.asset] = 'Chasing entry — extended move, poor entry location'; return false; }
      if (r.ev <= 0) { rejectReasons[r.asset] = `Negative EV (${r.ev.toFixed(3)}) — risk exceeds reward`; return false; }

      // Volume bull on shorts = -20pp edge — buying pressure fights the short
      if (r.direction === 'short' && r.signalSnapshot?.Volume?.bull && (r.volumeRatio || 0) > 2) {
        rejectReasons[r.asset] = 'Volume conflict — buying volume (ratio ' + (r.volumeRatio||0).toFixed(1) + 'x) fighting short';
        return false;
      }

      // Direction-aware minimum probability (raised March 20 — 60%+ trades = 78.7% WR post-fix)
      const dirMinProb = r.direction === 'long' ? 65 : 60;

      // 3/4 bear signal minimum gate for shorts (validated: 4/4 = 83.1% WR, 3/4 = 59.5% WR, 2/4 = 44.4% WR)
      if (r.direction === 'short') {
        const coreBearCount = [
          r.signalSnapshot?.EMA?.bear,
          r.signalSnapshot?.MACD?.bear,
          r.signalSnapshot?.Ichimoku?.bear,
          r.signalSnapshot?.Volume?.bear,
        ].filter(Boolean).length;
        if (coreBearCount < 3) {
          rejectReasons[r.asset] = `Only ${coreBearCount}/4 core bear signals — minimum 3 required for auto-trade`;
          return false;
        }
      }
      const effectiveDirMinProb = Math.max(assetOverride.minProb || minProb, dirMinProb);
      if (r.prob < effectiveDirMinProb) { rejectReasons[r.asset] = `prob ${r.prob}% < dir-aware min ${effectiveDirMinProb}%`; return false; }

      // Flip confidence gate — skip first trade after direction change (34.2% WR)
      const flipCheck = this._checkFlipConfidence(r.asset, tf, r.direction);
      if (flipCheck.skip) {
        rejectReasons[r.asset] = flipCheck.reason;
        return false;
      }

      // #27 — Per-TF leverage limits: hardcode 4h to max 1x until fixed
      if (tf === '4h' && r.marketQuality !== 'A') { rejectReasons[r.asset] = '4h non-A quality'; return false; }

      // Cross-TF dedup: don't trade same asset+direction if recently traded on another TF
      const dedupeKey = `${r.asset}|${r.direction}`;
      for (const existing of this.recentTrades) {
        if (existing.startsWith(dedupeKey + '|')) { rejectReasons[r.asset] = 'cross-TF dedup'; return false; }
      }
      return true;
    });

    // Log why trades were rejected (first 5) + store for debug endpoint
    const rejectEntries = Object.entries(rejectReasons).slice(0, 5);
    if (!this.lastTradeRejections) this.lastTradeRejections = {};
    this.lastTradeRejections[tf] = rejectReasons;
    if (rejectEntries.length > 0) {
      console.log(`[BestTrades] ${tf} auto-trade rejections: ${rejectEntries.map(([a, r]) => `${a}(${r})`).join(', ')}`);
    }
    if (qualifying.length > 0) {
      console.log(`[BestTrades] ${tf} auto-trade QUALIFYING: ${qualifying.map(r => `${r.asset}(${r.prob}%,${r.marketQuality},${r.confidence},EV:${r.ev.toFixed(2)},entry:${r.entryEfficiency})`).join(', ')}`);
    }

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
      console.log(`[BestTrades] ${tf} auto-trade: no unlocked credentials — skipping execution (${qualifying.length} qualifying)`);
      return;
    }
    console.log(`[BestTrades] ${tf} auto-trade: ${qualifying.length} qualifying, creds unlocked for user ${userId}`);

    // Count open positions
    let openCount = 0;
    try {
      const posResult = await pool.query(
        'SELECT COUNT(*) AS total FROM live_positions WHERE user_id=$1 AND closed_at IS NULL',
        [userId]
      );
      openCount = parseInt(posResult.rows[0].total);
    } catch (e) {
      console.warn('[BestTrades] Open position count query failed:', e.message);
    }

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
    } catch (e) {
      console.warn('[BestTrades] Exposure query failed:', e.message);
    }
    const totalAccountUsd = availableBalance + currentExposureUsd;
    const currentHeatPct = totalAccountUsd > 0 ? (currentExposureUsd / totalAccountUsd) * 100 : 0;

    if (currentHeatPct >= leverageRisk.maxHeatPct) {
      console.log(`[BestTrades] Portfolio heat ${currentHeatPct.toFixed(1)}% >= ${leverageRisk.maxHeatPct}% max — skipping new trades`);
      return;
    }

    const slotsAvailable = this.settings.maxOpen - openCount;
    const toTrade = qualifying.slice(0, slotsAvailable);

    for (const setup of toTrade) {
      // Position sizing: fixed $ or % of total wallet balance
      let basePosSize = this.settings.tradeSizeUsd;
      if (this.settings.tradeSizeMode === 'percent') {
        basePosSize = Math.round(totalAccountUsd * (this.settings.tradeSizeUsd / 100));
        console.log(`[BestTrades] % sizing: ${this.settings.tradeSizeUsd}% of $${totalAccountUsd.toFixed(2)} = $${basePosSize}`);
      }
      // Sizing mode: 'kelly' applies mqSizeMult (quality-based scaling), 'fixed' uses exact user amount
      const useKelly = this.settings.sizingMode !== 'fixed';
      const posSize = useKelly ? Math.round(basePosSize * (setup.mqSizeMult || 1)) : Math.round(basePosSize);
      if (useKelly) {
        console.log(`[BestTrades] Kelly sizing: base=$${basePosSize} × mqMult=${setup.mqSizeMult} = $${posSize}`);
      } else {
        console.log(`[BestTrades] Fixed sizing: $${posSize} (Kelly disabled by user)`);
      }
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
    // In fixed sizing mode, use only user's set leverage (no Kelly-optimal override)
    const rawLev = this.settings.sizingMode === 'fixed'
      ? (this.settings.leverage || 1)
      : Math.max(setup.optimalLev || 1, this.settings.leverage || 1);
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

    // Calculate SL/TP with dynamic precision for small-price assets (e.g., PEPE at $0.000003)
    // Must preserve enough decimals so SL ≠ TP ≠ entry after rounding
    const pricePrecision = markPrice < 0.0001 ? 10 : markPrice < 0.01 ? 8 : markPrice < 1 ? 6 : markPrice < 100 ? 4 : 2;
    const slPrice = setup.direction === 'long'
      ? (markPrice * (1 - setup.stopPct / 100)).toFixed(pricePrecision)
      : (markPrice * (1 + setup.stopPct / 100)).toFixed(pricePrecision);
    const tpPrice = setup.direction === 'long'
      ? (markPrice * (1 + setup.targetPct / 100)).toFixed(pricePrecision)
      : (markPrice * (1 - setup.targetPct / 100)).toFixed(pricePrecision);

    // Safety: verify SL and TP are actually different from each other AND from entry
    if (slPrice === tpPrice || parseFloat(slPrice) === markPrice || parseFloat(tpPrice) === markPrice) {
      console.error(`[BestTrades] ❌ SL/TP precision error for ${setup.asset}: entry=${markPrice}, SL=${slPrice}, TP=${tpPrice} — aborting trade`);
      return;
    }

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
            entry_price, stop_price, target_price, stop_pct, target_pct, regime, executed, order_id, timeframe,
            signal_snapshot, raw_probability, ev, optimal_lev, atr_value, hits, misses, volume_ratio, confluence_score,
            tf_bear_count, tf_bull_count, tf_alignment_score, highest_tf_conflict)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
          [setup.asset, setup.direction, setup.prob, setup.confidence,
           setup.marketQuality, setup.rr, setup.price, setup.stopPrice, setup.targetPrice,
           setup.stopPct, setup.targetPct, setup.regime, true, result.orderId || null, setup.timeframe || '15m',
           JSON.stringify({ ...(setup.signalSnapshot || {}), cross_tf: setup.crossTF, cross_tf_summary: setup.crossTFSummary, market_structure: setup.marketStructure, funding_rate_score: setup.fundingRateScore }),
           setup.rawProb, setup.ev, setup.optimalLev,
           setup.atrValue, JSON.stringify(setup.hits || []), JSON.stringify(setup.misses || []),
           setup.volumeRatio, setup.confluenceScore,
           setup.crossTFSummary?.bear_alignment || 0, setup.crossTFSummary?.bull_alignment || 0,
           setup.crossTFSummary?.alignment_score || 0, setup.crossTFSummary?.highest_conflict_tf || null]
        );
      } catch (execLogErr) {
        console.warn(`[BestTrades] Auto-execute DB log failed for ${setup.asset}: ${execLogErr.message} — trying basic insert...`);
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
        } catch (basicLogErr) {
          console.error(`[BestTrades] Auto-execute BOTH DB logs failed for ${setup.asset}: ${basicLogErr.message}`);
        }
      }
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
        this.settings.tradeSizeMode = row.trade_size_mode || 'fixed';
        this.settings.sizingMode = row.sizing_mode || 'kelly';
        this.settings.maxOpen = row.max_open || 3;
        this.settings.leverage = row.leverage || 1;
        this.settings.tfRules = row.tf_rules || {};
        this.settings.bannedAssets = row.banned_assets || [];
        this.settings.assetOverrides = row.asset_overrides || { 'ETH': { minProb: 72 } };
        console.log(`[BestTrades] Settings loaded from DB: enabled=${this.settings.enabled}, tf=${this.settings.timeframe}, banned=${(this.settings.bannedAssets || []).length} assets, tfRules=${JSON.stringify(this.settings.tfRules)}, assetOverrides=${JSON.stringify(this.settings.assetOverrides)}`);
      }
    } catch (e) {
      console.warn('[BestTrades] Settings load error:', e.message);
    }
  }

  async _saveSettings() {
    if (!pool) return;
    // Ensure banned_assets and asset_overrides columns exist (auto-migration)
    try {
      await pool.query(`ALTER TABLE best_trades_settings ADD COLUMN IF NOT EXISTS banned_assets JSONB DEFAULT '[]'::jsonb`);
    } catch (migErr) { /* column may already exist or table doesn't support IF NOT EXISTS */ }
    try {
      await pool.query(`ALTER TABLE best_trades_settings ADD COLUMN IF NOT EXISTS asset_overrides JSONB DEFAULT '{}'::jsonb`);
    } catch (migErr) { /* column may already exist */ }

    try {
      await pool.query(
        `INSERT INTO best_trades_settings (id, enabled, mode, timeframe, min_prob, trade_size_usd, trade_size_mode, sizing_mode, max_open, leverage, tf_rules, banned_assets, asset_overrides, updated_at)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
         ON CONFLICT (id) DO UPDATE SET
           enabled=$1, mode=$2, timeframe=$3, min_prob=$4,
           trade_size_usd=$5, trade_size_mode=$6, sizing_mode=$7, max_open=$8, leverage=$9, tf_rules=$10, banned_assets=$11, asset_overrides=$12, updated_at=NOW()`,
        [this.settings.enabled, this.settings.mode, this.settings.timeframe,
         this.settings.minProb, this.settings.tradeSizeUsd, this.settings.tradeSizeMode || 'fixed',
         this.settings.sizingMode || 'kelly',
         this.settings.maxOpen, this.settings.leverage,
         JSON.stringify(this.settings.tfRules || {}),
         JSON.stringify(this.settings.bannedAssets || []),
         JSON.stringify(this.settings.assetOverrides || {})]
      );
    } catch (e) {
      console.warn('[BestTrades] Settings save error (trying without banned_assets):', e.message);
      try {
        await pool.query(
          `INSERT INTO best_trades_settings (id, enabled, mode, timeframe, min_prob, trade_size_usd, trade_size_mode, sizing_mode, max_open, leverage, tf_rules, updated_at)
           VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
           ON CONFLICT (id) DO UPDATE SET
             enabled=$1, mode=$2, timeframe=$3, min_prob=$4,
             trade_size_usd=$5, trade_size_mode=$6, sizing_mode=$7, max_open=$8, leverage=$9, tf_rules=$10, updated_at=NOW()`,
          [this.settings.enabled, this.settings.mode, this.settings.timeframe,
           this.settings.minProb, this.settings.tradeSizeUsd, this.settings.tradeSizeMode || 'fixed',
           this.settings.sizingMode || 'kelly',
           this.settings.maxOpen, this.settings.leverage,
           JSON.stringify(this.settings.tfRules || {})]
        );
      } catch (e2) {
        console.error('[BestTrades] Settings save fallback also failed:', e2.message);
      }
    }
  }

  async _logResults(results) {
    if (!pool) { this.lastLogAttempt = { time: new Date().toISOString(), error: 'NO POOL' }; return; }
    // Debug: show raw top values before filtering
    const sortedByEv = [...results].sort((a, b) => (b.ev || 0) - (a.ev || 0));
    const rawTop5 = sortedByEv.slice(0, 5).map(r => ({
      a: r.asset, d: r.direction, tf: r.timeframe,
      prob: r.prob, ev: r.ev, evType: typeof r.ev,
      probGte50: r.prob >= 50, evGt0: r.ev > 0
    }));
    // Build flip confidence direction history for ALL results (not just top 3)
    for (const r of results) {
      this._checkFlipConfidence(r.asset, r.timeframe || 'unknown', r.direction);
    }
    // Log top 3 results with EV > 0 for calibration data (#24: EV-first, fallback to prob >= 50%)
    const top = results.filter(r => (r.ev > 0) || r.prob >= 50).slice(0, 3);
    // CRITICAL: probability column is INTEGER in PostgreSQL — must round all decimal probs
    for (const r of top) {
      r.prob = Math.round(r.prob);
      if (r.rawProb != null) r.rawProb = Math.round(r.rawProb);
    }
    let inserted = 0, updated = 0;
    const debugInfo = { candidates: top.length, fromResults: results.length, rawTop5, errors: [] };
    for (const r of top) {
      try {
        // DEDUPLICATION: Check if identical RECENT pending signal already exists
        // Only dedup within a time window based on TF — after that, allow new predictions
        // This prevents the same signal from blocking new entries for days
        const tfDedup = { '5m': '2 hours', '15m': '4 hours', '30m': '8 hours',
                          '1h': '16 hours', '4h': '2 days', '1d': '5 days' };
        const dedupWindow = tfDedup[r.timeframe] || '4 hours';
        const existing = await pool.query(
          `SELECT id, scan_count FROM best_trades_log
           WHERE asset = $1 AND direction = $2 AND timeframe = $3 AND outcome IS NULL
           AND created_at > NOW() - INTERVAL '${dedupWindow}'
           ORDER BY created_at DESC LIMIT 1`,
          [r.asset, r.direction, r.timeframe || '15m']
        );

        if (existing.rows.length > 0) {
          // Recent signal still pending — increment scan_count and update latest data
          const row = existing.rows[0];
          try {
            await pool.query(
              `UPDATE best_trades_log SET
                scan_count = COALESCE(scan_count, 1) + 1,
                last_seen_at = NOW(),
                probability = $2, confidence = $3, market_quality = $4,
                ev = $5, raw_probability = $6, confluence_score = $7,
                signal_snapshot = $8,
                tf_bear_count = $9, tf_bull_count = $10,
                tf_alignment_score = $11, highest_tf_conflict = $12
               WHERE id = $1`,
              [row.id, r.prob, r.confidence, r.marketQuality,
               r.ev, r.rawProb, r.confluenceScore,
               JSON.stringify({ ...(r.signalSnapshot || {}), cross_tf: r.crossTF, cross_tf_summary: r.crossTFSummary, market_structure: r.marketStructure, funding_rate_score: r.fundingRateScore }),
               r.crossTFSummary?.bear_alignment || 0, r.crossTFSummary?.bull_alignment || 0,
               r.crossTFSummary?.alignment_score || 0, r.crossTFSummary?.highest_conflict_tf || null]
            );
            debugInfo.errors.push({ asset: r.asset, stage: 'dedup_update_ok', id: row.id });
          } catch (updateErr) {
            debugInfo.errors.push({ asset: r.asset, stage: 'dedup_update_fail', msg: updateErr.message });
            // Fallback if scan_count/last_seen_at columns don't exist yet
            await pool.query(
              `UPDATE best_trades_log SET probability = $2, confidence = $3, market_quality = $4 WHERE id = $1`,
              [row.id, r.prob, r.confidence, r.marketQuality]
            );
          }
          updated++;
          continue;
        }

        // No existing pending signal — insert new row
        debugInfo.errors.push({ asset: r.asset, stage: 'inserting_new', tf: r.timeframe, prob: r.prob });
        await pool.query(
          `INSERT INTO best_trades_log
           (asset, direction, probability, confidence, market_quality, rr_ratio,
            entry_price, stop_price, target_price, stop_pct, target_pct, regime, executed, timeframe,
            signal_snapshot, raw_probability, ev, optimal_lev, atr_value, hits, misses, volume_ratio, confluence_score,
            tf_bear_count, tf_bull_count, tf_alignment_score, highest_tf_conflict)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
          [r.asset, r.direction, r.prob, r.confidence,
           r.marketQuality, r.rr, r.price, r.stopPrice, r.targetPrice,
           r.stopPct, r.targetPct, r.regime, false, r.timeframe || '15m',
           JSON.stringify({ ...(r.signalSnapshot || {}), cross_tf: r.crossTF, cross_tf_summary: r.crossTFSummary, market_structure: r.marketStructure, funding_rate_score: r.fundingRateScore }),
           r.rawProb, r.ev, r.optimalLev,
           r.atrValue, JSON.stringify(r.hits || []), JSON.stringify(r.misses || []),
           r.volumeRatio, r.confluenceScore,
           r.crossTFSummary?.bear_alignment || 0, r.crossTFSummary?.bull_alignment || 0,
           r.crossTFSummary?.alignment_score || 0, r.crossTFSummary?.highest_conflict_tf || null]
        );
        inserted++;
      } catch (e) {
        debugInfo.errors.push({ asset: r.asset, stage: 'extended_insert', msg: e.message });
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
          inserted++;
        } catch (e2) {
          debugInfo.errors.push({ asset: r.asset, stage: 'basic_insert', msg: e2.message });
          console.error(`[BestTrades] BOTH inserts failed for ${r.asset}:`, e2.message);
        }
      }
    }
    // Always log — even when 0 inserts — so we can diagnose issues
    const topInfo = top.map(r => `${r.asset}/${r.direction}/${r.timeframe}(${r.prob}%,ev=${r.ev?.toFixed(3)})`).join(', ');
    console.log(`[BestTrades] _logResults: ${inserted} new, ${updated} updated, ${top.length} candidates from ${results.length} results [${topInfo}]`);
    if (!this.lastLogAttempts) this.lastLogAttempts = {};
    const tf = top[0]?.timeframe || results[0]?.timeframe || 'unknown';
    this.lastLogAttempts[tf] = { time: new Date().toISOString(), inserted, updated, ...debugInfo, top: topInfo };
    this.lastLogAttempt = this.lastLogAttempts;
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
    if (filters.confidence) { conditions.push(`confidence = $${fIdx++}`); filterParams.push(filters.confidence); }
    if (filters.date_from) { conditions.push(`created_at >= $${fIdx++}`); filterParams.push(filters.date_from); }
    if (filters.date_to) { conditions.push(`created_at <= $${fIdx++}`); filterParams.push(filters.date_to); }
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
