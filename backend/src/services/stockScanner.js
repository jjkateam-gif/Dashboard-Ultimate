/**
 * Stock Scanner for Best Trades System
 * Scan-only, logging-only engine (NO auto-trading)
 * Completely separate from the crypto scanner (bestTradesScanner.js)
 * Uses BloFin stock-linked perpetuals (TSLAUSDT, SPYUSDT, etc.)
 */
const { fetchKlines } = require('./binance');
const { sma, ema, rsi, stdev, atr } = require('./indicators');
let pool = null;
try { pool = require('../db').pool; } catch {}

// ══════════════════════════════════════════════════════════════
// STOCK ASSETS & CONFIG
// ══════════════════════════════════════════════════════════════

const STOCK_ASSETS = [
  { sym: 'TSLAUSDT', label: 'TSLA' },
  { sym: 'CRCULUSDT', label: 'CRCL' },
  { sym: 'COINUSDT', label: 'COIN' },
  { sym: 'EWJUSDT', label: 'EWJ' },
  { sym: 'MSTRUSDT', label: 'MSTR' },
  { sym: 'PLTRUSDT', label: 'PLTR' },
  { sym: 'SPYUSDT', label: 'SPY' },
  { sym: 'INTCUSDT', label: 'INTC' },
  { sym: 'HOODUSDT', label: 'HOOD' },
  { sym: 'AMZNUSDT', label: 'AMZN' },
  { sym: 'QQQUSDT', label: 'QQQ' },
];

// Scan intervals per timeframe (stocks don't need 5m)
const STOCK_SCAN_INTERVALS = {
  '15m': 5 * 60_000,       // every 5 min
  '1h':  15 * 60_000,      // every 15 min
  '4h':  60 * 60_000,      // every 60 min
  '1d':  240 * 60_000,     // every 240 min
};

const STOCK_TIMEFRAMES = ['15m', '1h', '4h', '1d'];

// Stock-specific indicator weights (mean-reversion dominant)
// VWAP=18 planned but not implemented yet — weight reserved
// TODO: Implement VWAP indicator and assign 18% weight. Redistribute from other indicators proportionally.
const STOCK_WEIGHTS_LONG = {
  RSI: 22, BB: 17, Volume: 15, EMA: 12, MACD: 6, StochRSI: 5, Ichimoku: 5,
  // VWAP: 18 — TODO: reserved, not yet implemented
};

// Shorts require higher threshold (75% min vs 65% for longs)
const STOCK_WEIGHTS_SHORT = {
  RSI: 20, BB: 15, Volume: 13, EMA: 14, MACD: 10, StochRSI: 5, Ichimoku: 5,
  // VWAP: 18 — TODO: reserved, not yet implemented
};

const LONG_MIN_PROB = 65;
const SHORT_MIN_PROB = 75;

// ══════════════════════════════════════════════════════════════
// US MARKET SESSION DETECTION
// ══════════════════════════════════════════════════════════════

function getUSSessionMultiplier() {
  // Returns a multiplier based on US market hours (Eastern Time)
  // Full weight: 9:30 AM - 4:00 PM ET
  // Pre/Post market: 4:00 AM - 9:30 AM and 4:00 PM - 8:00 PM ET = 0.6x
  // Overnight: 8:00 PM - 4:00 AM ET = 0.3x

  const now = new Date();
  // Convert to ET (Eastern Time)
  const etString = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etDate = new Date(etString);
  const hours = etDate.getHours();
  const minutes = etDate.getMinutes();
  const timeDecimal = hours + minutes / 60;

  // Regular market hours: 9:30 AM - 4:00 PM ET
  if (timeDecimal >= 9.5 && timeDecimal < 16) {
    return { multiplier: 1.0, session: 'regular' };
  }
  // Pre-market: 4:00 AM - 9:30 AM ET
  if (timeDecimal >= 4 && timeDecimal < 9.5) {
    return { multiplier: 0.6, session: 'pre-market' };
  }
  // Post-market: 4:00 PM - 8:00 PM ET
  if (timeDecimal >= 16 && timeDecimal < 20) {
    return { multiplier: 0.6, session: 'post-market' };
  }
  // Overnight: 8:00 PM - 4:00 AM ET
  return { multiplier: 0.3, session: 'overnight' };
}

// ══════════════════════════════════════════════════════════════
// CALIBRATION CACHE (stock-specific, separate from crypto)
// ══════════════════════════════════════════════════════════════

const stockCalibrationCache = {
  lastRefresh: 0,
  refreshIntervalMs: 10 * 60_000,
  minSamples: 30,
  byProbBucket: {},
  byRegimeTF: {},
  byQuality: {},
  byConfidence: {},
  overall: { winRate: 0.5, totalResolved: 0 },
};

async function refreshStockCalibration() {
  if (!pool) return;
  const now = Date.now();
  if (now - stockCalibrationCache.lastRefresh < stockCalibrationCache.refreshIntervalMs) return;

  try {
    // Overall stats from stock_trades_log only
    const overallRes = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE outcome IN ('win','loss')) AS total_resolved,
        COUNT(*) FILTER (WHERE outcome = 'win') AS wins
      FROM stock_trades_log
    `);
    const totalResolved = parseInt(overallRes.rows[0].total_resolved) || 0;
    const overallWR = totalResolved > 0 ? parseInt(overallRes.rows[0].wins) / totalResolved : 0.5;

    // Probability bucket accuracy
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
        COUNT(*) FILTER (WHERE outcome = 'win') AS wins
      FROM stock_trades_log
      WHERE outcome IN ('win','loss')
      GROUP BY bucket, bucket_mid ORDER BY bucket_mid
    `);
    stockCalibrationCache.byProbBucket = {};
    for (const r of bucketRes.rows) {
      const n = parseInt(r.n);
      if (n > 0) {
        stockCalibrationCache.byProbBucket[r.bucket] = {
          predicted: parseInt(r.bucket_mid),
          actual: parseInt(r.wins) / n,
          n,
        };
      }
    }

    // Win rate by regime + timeframe
    const regimeTFRes = await pool.query(`
      SELECT regime, timeframe,
        COUNT(*) FILTER (WHERE outcome IN ('win','loss')) AS n,
        COUNT(*) FILTER (WHERE outcome = 'win') AS wins
      FROM stock_trades_log
      WHERE outcome IN ('win','loss') AND regime IS NOT NULL
      GROUP BY regime, timeframe
    `);
    stockCalibrationCache.byRegimeTF = {};
    for (const r of regimeTFRes.rows) {
      const n = parseInt(r.n);
      if (n > 0) {
        stockCalibrationCache.byRegimeTF[`${r.regime}_${r.timeframe}`] = { winRate: parseInt(r.wins) / n, n };
      }
    }

    // Win rate by market quality
    const qualRes = await pool.query(`
      SELECT market_quality,
        COUNT(*) FILTER (WHERE outcome IN ('win','loss')) AS n,
        COUNT(*) FILTER (WHERE outcome = 'win') AS wins,
        ROUND(AVG(pnl) FILTER (WHERE outcome IN ('win','loss')), 4) AS avg_pnl
      FROM stock_trades_log
      WHERE outcome IN ('win','loss') AND market_quality IS NOT NULL
      GROUP BY market_quality
    `);
    stockCalibrationCache.byQuality = {};
    for (const r of qualRes.rows) {
      const n = parseInt(r.n);
      if (n > 0) {
        stockCalibrationCache.byQuality[r.market_quality] = {
          winRate: parseInt(r.wins) / n, n, avgPnl: parseFloat(r.avg_pnl) || 0,
        };
      }
    }

    // Win rate by confidence
    const confRes = await pool.query(`
      SELECT confidence,
        COUNT(*) FILTER (WHERE outcome IN ('win','loss')) AS n,
        COUNT(*) FILTER (WHERE outcome = 'win') AS wins
      FROM stock_trades_log
      WHERE outcome IN ('win','loss') AND confidence IS NOT NULL
      GROUP BY confidence
    `);
    stockCalibrationCache.byConfidence = {};
    for (const r of confRes.rows) {
      const n = parseInt(r.n);
      if (n > 0) {
        stockCalibrationCache.byConfidence[r.confidence] = { winRate: parseInt(r.wins) / n, n };
      }
    }

    stockCalibrationCache.overall = { winRate: overallWR, totalResolved };
    stockCalibrationCache.lastRefresh = now;

    console.log(`[StockScanner] Calibration refreshed: ${totalResolved} resolved, WR=${(overallWR*100).toFixed(1)}%`);
  } catch (err) {
    console.error('[StockScanner] Calibration refresh error:', err.message);
  }
}

function calibrateStockProb(rawProb, regime, tf, marketQuality) {
  const cc = stockCalibrationCache;
  if (cc.overall.totalResolved < cc.minSamples) return rawProb;

  let adjustedProb = rawProb;

  // Probability bucket calibration
  const bucketKey = rawProb < 55 ? '50-54' : rawProb < 60 ? '55-59' : rawProb < 65 ? '60-64'
    : rawProb < 70 ? '65-69' : rawProb < 75 ? '70-74' : rawProb < 80 ? '75-79' : '80+';
  const bucket = cc.byProbBucket[bucketKey];
  if (bucket && bucket.n >= cc.minSamples) {
    const actualWR = bucket.actual * 100;
    const diff = actualWR - bucket.predicted;
    const shrinkage = Math.min(1, bucket.n / 100);
    adjustedProb += diff * shrinkage * 0.4;
  }

  // Regime + TF adjustment
  const regimeTF = cc.byRegimeTF[`${regime}_${tf}`];
  if (regimeTF && regimeTF.n >= cc.minSamples) {
    const regimeWR = regimeTF.winRate * 100;
    const overallWR = cc.overall.winRate * 100;
    const shrinkage = Math.min(1, regimeTF.n / 100);
    adjustedProb += (regimeWR - overallWR) * shrinkage * 0.3;
  }

  // Market quality adjustment
  const qualData = cc.byQuality[marketQuality];
  if (qualData && qualData.n >= cc.minSamples) {
    const qualWR = qualData.winRate * 100;
    const overallWR = cc.overall.winRate * 100;
    const shrinkage = Math.min(1, qualData.n / 100);
    adjustedProb += (qualWR - overallWR) * shrinkage * 0.2;
  }

  return Math.max(25, Math.min(85, Math.round(adjustedProb)));
}

// ══════════════════════════════════════════════════════════════
// INDICATOR HELPERS (same math as crypto, stock-specific tuning)
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
// SIGNAL COMPUTATION (stock-specific)
// ══════════════════════════════════════════════════════════════

function computeStockSignals(d, tf) {
  const last = d.length - 1;
  const c = d.map(x => x.c);
  const price = c[last];
  const results = {};

  // EMA200 regime
  const ema200Arr = ema(c, 200);
  const macro_bull = ema200Arr[last] != null && price > ema200Arr[last];
  const macro_bear = ema200Arr[last] != null && price < ema200Arr[last];

  // Stock-specific RSI thresholds (more traditional mean-reversion levels)
  const rsiOversold = macro_bull ? 35 : macro_bear ? 25 : 30;
  const rsiOverbought = macro_bull ? 75 : macro_bear ? 65 : 70;
  const stochOversold = macro_bull ? 20 : macro_bear ? 15 : 18;
  const stochOverbought = macro_bull ? 80 : macro_bear ? 70 : 75;

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
  const bridgeTFs = ['15m', '30m'];
  const longTFs = ['1d', '3d', '1w'];
  const mp = bridgeTFs.includes(tf) ? { f: 8, s: 17, sig: 9 }
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
  const shortTFsIchi = ['15m'];
  const longTFsIchi = ['1d'];
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

  // ── ADX for regime gate ──
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
// CONFLUENCE SCORING (stock-specific: mean-reversion enabled for longs)
// ══════════════════════════════════════════════════════════════

function scoreStockConfluence(signals, direction, regime, tf, marketQuality) {
  const dir = direction === 'long' ? 'bull' : 'bear';
  const opp = direction === 'long' ? 'bear' : 'bull';
  let score = 0, maxScore = 0;
  const hits = [], misses = [];

  // Stock-specific: direction-aware weights
  const WEIGHTS = direction === 'long' ? { ...STOCK_WEIGHTS_LONG } : { ...STOCK_WEIGHTS_SHORT };

  // Family dampening (same as crypto)
  const FAMILIES = { RSI: 'meanrev', StochRSI: 'meanrev', BB: 'meanrev', EMA: 'trend', MACD: 'trend', Ichimoku: 'trend', Volume: 'flow' };
  const FAMILY_DECAY = [1.0, 0.60, 0.35];
  const familyCount = { meanrev: 0, trend: 0, flow: 0 };

  // Trend vs mean-reversion conflict detection
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

    // ── STOCK-SPECIFIC: Mean-reversion ENABLED for longs ──
    // Opposite of crypto: stocks mean-revert well. Buy oversold, sell overbought.
    // RSI oversold bull signal is VALID for stock longs (unlike crypto where it was disabled).
    // No changes needed here — aligned stays true for mean-reversion bull on longs.

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

  // Regime adjustment (±4) — uses SPY regime instead of BTC
  if (regime === 'bull' && direction === 'long') prob += 4;
  if (regime === 'bull' && direction === 'short') prob -= 4;
  if (regime === 'bear' && direction === 'short') prob += 4;
  if (regime === 'bear' && direction === 'long') prob -= 4;

  // Confidence thresholds
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
// R/R ESTIMATION (stock-specific, no leverage/Kelly for scan-only)
// ══════════════════════════════════════════════════════════════

function estimateStockRR(price, atrVal, direction, prob, candles, marketQuality) {
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

  // Target
  const baseTargetMult = prob >= 72 ? 2.0 : prob >= 62 ? 2.5 : 3.0;
  const mqBoost = marketQuality === 'A' ? 1.25 : marketQuality === 'B' ? 1.0 : 0.85;
  const target = atrVal * baseTargetMult * mqBoost;

  const stopPrice = direction === 'long' ? price - stop : price + stop;
  const targetPrice = direction === 'long' ? price + target : price - target;
  const stopPct = stop / price * 100;
  const targetPct = target / price * 100;
  const rr = stopPct > 0 ? parseFloat((targetPct / stopPct).toFixed(1)) : 0;
  const ev = (prob / 100 * targetPct) - ((1 - prob / 100) * stopPct);

  return { stopPrice, targetPrice, rr, stopPct, targetPct, ev };
}

// ══════════════════════════════════════════════════════════════
// SPY REGIME DETECTION (stock equivalent of BTC regime)
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
// STOCK SCANNER CLASS
// ══════════════════════════════════════════════════════════════

class StockScanner {
  constructor() {
    this.settings = {
      enabled: true,     // scan-only mode, always enabled
      minProb: 65,
      bannedAssets: [],
    };
    this.scanTimers = {};
    this.lastResults = [];
    this.lastResultsByTF = {};
    this.lastScanTime = null;
    this.lastScanTimeByTF = {};
    this.lastScanDebug = {};
    this.sseClients = [];
    this.signalDirectionHistory = {};
    this.lastLogAttempt = {};
    this.heartbeat = { lastScan: null, scansCompleted: 0, errors: 0 };
  }

  // ── DB Table Auto-Creation ──

  async _ensureTables() {
    if (!pool) return;
    try {
      // stock_trades_log — same columns as best_trades_log + market_type='stock'
      await pool.query(`
        CREATE TABLE IF NOT EXISTS stock_trades_log (
          id SERIAL PRIMARY KEY,
          asset VARCHAR(20) NOT NULL,
          direction VARCHAR(10) NOT NULL,
          probability INTEGER,
          raw_probability INTEGER,
          confidence VARCHAR(20),
          market_quality VARCHAR(20),
          rr_ratio DECIMAL(5,1),
          ev DECIMAL(10,4),
          entry_price DECIMAL(20,8),
          stop_price DECIMAL(20,8),
          target_price DECIMAL(20,8),
          stop_pct DECIMAL(8,4),
          target_pct DECIMAL(8,4),
          regime VARCHAR(20),
          timeframe VARCHAR(10),
          outcome VARCHAR(20),
          pnl DECIMAL(10,4),
          executed BOOLEAN DEFAULT FALSE,
          order_id VARCHAR(100),
          signal_snapshot JSONB,
          optimal_lev INTEGER,
          atr_value DECIMAL(20,8),
          hits JSONB,
          misses JSONB,
          volume_ratio DECIMAL(8,4),
          confluence_score DECIMAL(8,6),
          scan_count INTEGER DEFAULT 1,
          last_seen_at TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          resolved_at TIMESTAMP WITH TIME ZONE,
          market_type VARCHAR(20) DEFAULT 'stock',
          session_info VARCHAR(20),
          tf_bear_count INTEGER,
          tf_bull_count INTEGER,
          tf_alignment_score INTEGER,
          highest_tf_conflict VARCHAR(10)
        )
      `);
      console.log('[StockScanner] stock_trades_log table ensured');

      // stock_trades_settings
      await pool.query(`
        CREATE TABLE IF NOT EXISTS stock_trades_settings (
          id INTEGER PRIMARY KEY DEFAULT 1,
          enabled BOOLEAN DEFAULT TRUE,
          min_prob INTEGER DEFAULT 65,
          banned_assets JSONB DEFAULT '[]'::jsonb,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);
      console.log('[StockScanner] stock_trades_settings table ensured');
    } catch (e) {
      console.error('[StockScanner] Table creation error:', e.message);
    }
  }

  // ── Start / Stop ──

  async start() {
    await this._ensureTables();
    await this._loadSettings();

    if (pool) {
      try {
        const tableCheck = await pool.query('SELECT COUNT(*) AS cnt FROM stock_trades_log LIMIT 1');
        console.log(`[StockScanner] DB connected. stock_trades_log has ${tableCheck.rows[0].cnt} rows`);
      } catch (e) {
        console.error('[StockScanner] DB check error:', e.message);
      }
    } else {
      console.warn('[StockScanner] NO DB POOL - predictions will NOT be logged!');
    }

    this._startAllTimers();
    this._startResolutionTimer();
    console.log(`[StockScanner] Initialized. Scan-only mode. Timeframes: ${STOCK_TIMEFRAMES.join(', ')}`);
  }

  stop() {
    this._stopAllTimers();
    if (this.resolutionTimer) clearInterval(this.resolutionTimer);
    console.log('[StockScanner] Stopped.');
  }

  // ── Settings Management ──

  async getSettings() { return { ...this.settings }; }

  async updateSettings(newSettings) {
    Object.assign(this.settings, newSettings);
    await this._saveSettings();
    this._broadcast('settings', this.settings);
    return this.settings;
  }

  // ── Timer Management ──

  _startAllTimers() {
    this._stopAllTimers();
    console.log(`[StockScanner] Starting scan timers: ${STOCK_TIMEFRAMES.join(', ')}`);

    let delay = 20000; // start after 20s (offset from crypto scanner)
    for (const tf of STOCK_TIMEFRAMES) {
      const intervalMs = STOCK_SCAN_INTERVALS[tf] || 60 * 60_000;
      const intervalLabel = intervalMs < 60000 ? `${intervalMs / 1000}s` : `${intervalMs / 60000}m`;

      // Initial scan (staggered)
      setTimeout(() => {
        this._scanTimeframe(tf).catch(e => console.error(`[StockScanner] ${tf} initial scan error:`, e.message));
      }, delay);
      delay += 25000; // 25s stagger between TFs

      // Recurring scan
      this.scanTimers[tf] = setInterval(() => {
        this._scanTimeframe(tf).catch(e => console.error(`[StockScanner] ${tf} scan error:`, e.message));
      }, intervalMs);

      console.log(`[StockScanner]   ${tf}: every ${intervalLabel}`);
    }
  }

  _stopAllTimers() {
    for (const [, timer] of Object.entries(this.scanTimers)) {
      clearInterval(timer);
    }
    this.scanTimers = {};
  }

  // ── Ranging Market Detection ──

  _isRangingMarket(candles, atrVal) {
    if (!candles || candles.length < 20 || !atrVal) return false;
    const last20 = candles.slice(-20);
    const high = Math.max(...last20.map(c => parseFloat(c.h || 0)));
    const low = Math.min(...last20.map(c => parseFloat(c.l || 0)));
    const range = high - low;
    const rangeToATR = range / (atrVal * 20);
    return rangeToATR < 1.5;
  }

  // ── Market Structure Detection (HH/HL) — logging only ──

  _detectMarketStructure(candles) {
    if (!candles || candles.length < 50) return { structure: 'unknown', swings: [] };

    const swingHighs = [];
    const swingLows = [];

    for (let i = 5; i < candles.length - 5; i++) {
      const high = parseFloat(candles[i].h || 0);
      const low = parseFloat(candles[i].l || 0);

      let isSwingHigh = true;
      let isSwingLow = true;

      for (let j = 1; j <= 5; j++) {
        const prevH = parseFloat(candles[i-j].h || 0);
        const nextH = parseFloat(candles[i+j].h || 0);
        const prevL = parseFloat(candles[i-j].l || 0);
        const nextL = parseFloat(candles[i+j].l || 0);

        if (high <= prevH || high <= nextH) isSwingHigh = false;
        if (low >= prevL || low >= nextL) isSwingLow = false;
      }

      if (isSwingHigh) swingHighs.push({ index: i, price: high });
      if (isSwingLow) swingLows.push({ index: i, price: low });
    }

    const recentHighs = swingHighs.slice(-3);
    const recentLows = swingLows.slice(-3);

    if (recentHighs.length < 2 || recentLows.length < 2) {
      return { structure: 'insufficient_data', swings: { highs: recentHighs.length, lows: recentLows.length } };
    }

    const higherHighs = recentHighs[recentHighs.length-1].price > recentHighs[recentHighs.length-2].price;
    const higherLows = recentLows[recentLows.length-1].price > recentLows[recentLows.length-2].price;
    const lowerHighs = recentHighs[recentHighs.length-1].price < recentHighs[recentHighs.length-2].price;
    const lowerLows = recentLows[recentLows.length-1].price < recentLows[recentLows.length-2].price;

    let structure = 'ranging';
    if (higherHighs && higherLows) structure = 'uptrend';
    else if (lowerHighs && lowerLows) structure = 'downtrend';
    else if (higherHighs && lowerLows) structure = 'expanding';
    else if (lowerHighs && higherLows) structure = 'contracting';

    return {
      structure, higherHighs, higherLows, lowerHighs, lowerLows,
      lastSwingHigh: recentHighs[recentHighs.length-1]?.price || null,
      lastSwingLow: recentLows[recentLows.length-1]?.price || null,
      swingHighCount: swingHighs.length,
      swingLowCount: swingLows.length,
    };
  }

  // ── Flip Confidence Gate ──

  _checkFlipConfidence(asset, tf, direction) {
    const key = `${asset}_${tf}`;
    const prev = this.signalDirectionHistory[key];

    if (!prev || prev.direction !== direction) {
      this.signalDirectionHistory[key] = { direction, count: 1 };
      return { skip: true, reason: `Trend flip on ${asset} ${tf} (was ${prev?.direction || 'none'}, now ${direction})` };
    }

    prev.count++;
    this.signalDirectionHistory[key] = prev;
    return { skip: false, count: prev.count };
  }

  // ── Cross-Timeframe Snapshot Collection (315 data points approach) ──

  _getCrossTFSnapshot(asset, entryTF) {
    const TFS = ['15m', '1h', '4h'];
    const snapshot = {};

    for (const tf of TFS) {
      const tfResults = this.lastResultsByTF[tf] || [];
      const assetResult = tfResults.find(r => r.asset === asset);

      if (!assetResult || !assetResult.signalSnapshot) {
        snapshot[tf] = { available: false, stale: true };
        continue;
      }

      const scanTime = this.lastScanTimeByTF[tf];
      const ageMs = scanTime ? Date.now() - new Date(scanTime).getTime() : Infinity;
      const maxAgeMs = { '15m': 20*60000, '1h': 90*60000, '4h': 180*60000 };
      const isStale = ageMs > (maxAgeMs[tf] || 90*60000);

      const sig = assetResult.signalSnapshot || {};
      snapshot[tf] = {
        available: true,
        stale: isStale,
        ageMinutes: Math.round(ageMs / 60000),
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

  // ── Cross-TF Summary Calculator ──

  _calculateCrossTFSummary(crossTF, direction) {
    const TF_WEIGHTS = { '15m': 2, '1h': 4, '4h': 5 };
    let bearCount = 0, bullCount = 0, alignmentScore = 0;
    let highestConflictTF = null;

    for (const [tf, data] of Object.entries(crossTF)) {
      if (!data.available || data.stale) continue;
      const weight = TF_WEIGHTS[tf] || 1;

      const bearSignals = [data.macd_bear, data.ema_bear, data.ichimoku_bear, data.rsi_bear, data.stochrsi_bear, data.bb_bear, data.volume_bear].filter(Boolean).length;
      const bullSignals = [data.macd_bull, data.ema_bull, data.ichimoku_bull, data.rsi_bull, data.stochrsi_bull, data.bb_bull, data.volume_bull].filter(Boolean).length;

      const tfDirection = bearSignals > bullSignals ? 'bear' : bullSignals > bearSignals ? 'bull' : 'neutral';

      if (tfDirection === 'bear') bearCount++;
      if (tfDirection === 'bull') bullCount++;

      if ((direction === 'short' && tfDirection === 'bear') || (direction === 'long' && tfDirection === 'bull')) {
        alignmentScore += weight;
      } else if (tfDirection !== 'neutral') {
        if (!highestConflictTF || weight > (TF_WEIGHTS[highestConflictTF] || 0)) {
          highestConflictTF = tf;
        }
      }
    }

    return {
      bear_alignment: bearCount,
      bull_alignment: bullCount,
      alignment_score: alignmentScore,
      max_score: 11, // 2+4+5
      highest_conflict_tf: highestConflictTF,
    };
  }

  // ══════════════════════════════════════════════════════════════
  // SCAN A SINGLE TIMEFRAME
  // ══════════════════════════════════════════════════════════════

  async _scanTimeframe(tf) {
    // BULLETPROOF: Entire scan wrapped in master try/catch
    try {
      await refreshStockCalibration();

      const { multiplier: sessionMult, session: sessionName } = getUSSessionMultiplier();
      console.log(`[StockScanner] Scanning ${STOCK_ASSETS.length} stocks on ${tf} (session: ${sessionName}, mult: ${sessionMult})...`);

      const results = [];
      let spyRegime = 'neutral';

      // SPY regime detection (stock equivalent of BTC regime)
      try {
        const spyCandles = await fetchKlines('SPYUSDT', '1d', 200);
        if (spyCandles && spyCandles.length > 50) {
          spyRegime = detectRegime(spyCandles);
        }
      } catch (e) {
        console.warn('[StockScanner] SPY regime fetch error:', e.message);
      }

      let scannedCount = 0, skippedCount = 0, errorCount = 0;
      const bannedSet = new Set((this.settings.bannedAssets || []).map(a => a.toUpperCase()));

      for (const asset of STOCK_ASSETS) {
        try {
          // Skip banned assets from scanning entirely
          if (bannedSet.has(asset.label.toUpperCase())) { skippedCount++; continue; }

          const candleCount = tf === '15m' ? 500 : 200;
          const candles = await fetchKlines(asset.sym, tf, candleCount);
          if (!candles || candles.length < 50) { skippedCount++; continue; }

          const analysis = computeStockSignals(candles, tf);
          const { signals, atr: atrVal, price, marketQuality, entryEfficiency, adxVal } = analysis;
          scannedCount++;

          // 4h regime gate: skip 4h unless confirmed trending
          if (tf === '4h' && adxVal != null && adxVal < 20) {
            continue;
          }

          // Ranging market detection (soft flag)
          const isRanging = this._isRangingMarket(candles, atrVal);

          const regime = spyRegime;

          // Score both directions
          const longScore = scoreStockConfluence(signals, 'long', regime, tf, marketQuality);
          const shortScore = scoreStockConfluence(signals, 'short', regime, tf, marketQuality);

          // Pick best direction
          const best = longScore.prob >= shortScore.prob ? longScore : shortScore;
          const direction = longScore.prob >= shortScore.prob ? 'long' : 'short';

          // Debug: log raw scores for first 3 assets
          if (scannedCount <= 3) {
            console.log(`[StockScanner] ${asset.label} ${tf}: longProb=${longScore.prob} shortProb=${shortScore.prob} mq=${marketQuality} regime=${regime} session=${sessionName}`);
          }

          // Multi-TF Confluence check
          let mtfBonus = 0;
          if (tf === '15m') {
            const higherTF = this.lastResultsByTF['1h'] || [];
            const higherAsset = higherTF.find(r => r.asset === asset.label);
            if (higherAsset) {
              if (higherAsset.direction === direction && higherAsset.prob >= 55) mtfBonus = 3;
              else if (higherAsset.direction !== direction && higherAsset.prob >= 55) mtfBonus = -4;
            }
          }
          if (tf === '1h') {
            const higherTF = this.lastResultsByTF['4h'] || [];
            const higherAsset = higherTF.find(r => r.asset === asset.label);
            if (higherAsset) {
              if (higherAsset.direction === direction && higherAsset.prob >= 55) mtfBonus = 2;
              else if (higherAsset.direction !== direction && higherAsset.prob >= 55) mtfBonus = -3;
            }
          }

          // Calibration
          const rawProb = Math.max(25, Math.min(85, Math.round(best.prob)));
          let calibratedProb = calibrateStockProb(rawProb, regime, tf, marketQuality);
          calibratedProb += mtfBonus;

          // Cross-TF logging
          let crossTF = {};
          let crossTFSummary = null;
          try {
            crossTF = this._getCrossTFSnapshot(asset.label, tf);
            crossTFSummary = this._calculateCrossTFSummary(crossTF, direction);
          } catch (ctfErr) {
            console.warn(`[StockScanner] Cross-TF error for ${asset.label} ${tf}:`, ctfErr.message);
          }

          // Cross-TF alignment adjustment
          if (crossTFSummary && crossTFSummary.alignment_score !== undefined) {
            const ctfScore = crossTFSummary.alignment_score;
            let tfAdj = 0;
            if (ctfScore >= 9) tfAdj = 6;
            else if (ctfScore >= 7) tfAdj = 3;
            else if (ctfScore >= 4) tfAdj = 0;
            else tfAdj = -6;
            calibratedProb += tfAdj;
          }

          // Ranging market penalty
          if (isRanging) {
            calibratedProb -= 4;
          }

          calibratedProb = Math.max(25, Math.min(85, calibratedProb));

          // SESSION-AWARE WEIGHTING: Apply US market hours multiplier to final probability
          // This doesn't reduce below 25 (floor), but adjusts the effective probability
          // Only apply session weighting to 15m and 1h (intraday TFs)
          let sessionAdjustedProb = calibratedProb;
          if (['15m', '1h'].includes(tf) && sessionMult < 1.0) {
            // Scale the "edge above 50" by session multiplier
            // e.g., 70% in overnight (0.3x): edge = 20, scaled edge = 6, result = 56%
            const edge = Math.max(0, calibratedProb - 50);
            sessionAdjustedProb = Math.round(50 + edge * sessionMult);
            sessionAdjustedProb = Math.max(25, Math.min(85, sessionAdjustedProb));
          }

          // Market structure detection (logging only)
          let marketStructure = { structure: 'unknown' };
          try {
            marketStructure = this._detectMarketStructure(candles);
          } catch (msErr) {
            console.warn(`[StockScanner] Market structure error for ${asset.label} ${tf}:`, msErr.message);
          }

          // Estimate R/R
          const rrData = estimateStockRR(price, atrVal, direction, sessionAdjustedProb, candles, marketQuality);

          // Build signal snapshot
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

          const scanResult = {
            asset: asset.label,
            sym: asset.sym,
            timeframe: tf,
            direction,
            prob: sessionAdjustedProb,
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
            hits: best.hits,
            misses: best.misses,
            atrValue: atrVal,
            volumeRatio: signals.Volume?.ratio || null,
            signalSnapshot,
            isRanging,
            crossTF,
            crossTFSummary,
            marketStructure,
            sessionInfo: sessionName,
            sessionMultiplier: sessionMult,
            timestamp: new Date().toISOString(),
          };
          results.push(scanResult);

          // Small delay to avoid rate limits
          await new Promise(r => setTimeout(r, 250));
        } catch (e) {
          errorCount++;
          console.warn(`[StockScanner] ${asset.label} ${tf} scan error:`, e.message);
        }
      }

      // Save scan debug info
      this.lastScanDebug[tf] = { scanned: scannedCount, results: results.length, skipped: skippedCount, errors: errorCount, time: new Date().toISOString() };
      console.log(`[StockScanner] ${tf} scan complete: ${scannedCount} scanned, ${results.length} results, ${skippedCount} skipped, ${errorCount} errors`);

      // Sort by EV
      results.sort((a, b) => (b.ev || 0) - (a.ev || 0));

      // Store per-TF results
      this.lastResultsByTF[tf] = results;
      this.lastScanTimeByTF[tf] = new Date().toISOString();

      // Merge results
      this._mergeResults();

      // Log to DB
      try {
        await this._logResults(results);
      } catch (logErr) {
        console.error(`[StockScanner] _logResults crashed for ${tf}: ${logErr.message}`);
      }

      // Broadcast to SSE clients
      this._broadcast('scan', {
        timeframe: tf,
        results: results.slice(0, 10),
        combined: this.lastResults.slice(0, 10),
        timestamp: this.lastScanTimeByTF[tf],
      });

      // Heartbeat
      this.heartbeat.lastScan = new Date().toISOString();
      this.heartbeat.scansCompleted++;

      return results;
    } catch (masterError) {
      console.error(`[StockScanner] MASTER CATCH — ${tf} scan failed: ${masterError.message}`);
      this.heartbeat.errors++;
      return [];
    }
  }

  // ── Merge Results ──

  _mergeResults() {
    const bestByAsset = new Map();
    for (const [, tfResults] of Object.entries(this.lastResultsByTF)) {
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

  // ── Legacy scan (manual trigger / API) ──

  async scan() {
    const tf = '15m';
    await this._scanTimeframe(tf);
    return this.lastResults;
  }

  // ── DB Logging (dedup pattern same as crypto) ──

  async _logResults(results) {
    if (!pool) return;

    // Build flip confidence direction history for ALL results
    for (const r of results) {
      this._checkFlipConfidence(r.asset, r.timeframe || 'unknown', r.direction);
    }

    // Log top 3 results with EV > 0 or prob >= 50 for calibration
    const top = results.filter(r => (r.ev > 0) || r.prob >= 50).slice(0, 3);
    for (const r of top) {
      r.prob = Math.round(r.prob);
      if (r.rawProb != null) r.rawProb = Math.round(r.rawProb);
    }

    let inserted = 0, updated = 0;
    for (const r of top) {
      try {
        // Deduplication: check for recent pending signal
        const tfDedup = { '15m': '4 hours', '1h': '16 hours', '4h': '2 days', '1d': '5 days' };
        const dedupWindow = tfDedup[r.timeframe] || '4 hours';
        const existing = await pool.query(
          `SELECT id, scan_count FROM stock_trades_log
           WHERE asset = $1 AND direction = $2 AND timeframe = $3 AND outcome IS NULL
           AND created_at > NOW() - INTERVAL '${dedupWindow}'
           ORDER BY created_at DESC LIMIT 1`,
          [r.asset, r.direction, r.timeframe || '15m']
        );

        if (existing.rows.length > 0) {
          const row = existing.rows[0];
          try {
            await pool.query(
              `UPDATE stock_trades_log SET
                scan_count = COALESCE(scan_count, 1) + 1,
                last_seen_at = NOW(),
                probability = $2, confidence = $3, market_quality = $4,
                ev = $5, raw_probability = $6, confluence_score = $7,
                signal_snapshot = $8,
                session_info = $9,
                tf_bear_count = $10, tf_bull_count = $11,
                tf_alignment_score = $12, highest_tf_conflict = $13
               WHERE id = $1`,
              [row.id, r.prob, r.confidence, r.marketQuality,
               r.ev, r.rawProb, r.confluenceScore,
               JSON.stringify({ ...(r.signalSnapshot || {}), cross_tf: r.crossTF, cross_tf_summary: r.crossTFSummary, market_structure: r.marketStructure }),
               r.sessionInfo || null,
               r.crossTFSummary?.bear_alignment || 0, r.crossTFSummary?.bull_alignment || 0,
               r.crossTFSummary?.alignment_score || 0, r.crossTFSummary?.highest_tf_conflict || null]
            );
          } catch (updateErr) {
            await pool.query(
              `UPDATE stock_trades_log SET probability = $2, confidence = $3, market_quality = $4 WHERE id = $1`,
              [row.id, r.prob, r.confidence, r.marketQuality]
            );
          }
          updated++;
          continue;
        }

        // Insert new row
        await pool.query(
          `INSERT INTO stock_trades_log
           (asset, direction, probability, confidence, market_quality, rr_ratio,
            entry_price, stop_price, target_price, stop_pct, target_pct, regime, executed, timeframe,
            signal_snapshot, raw_probability, ev, atr_value, hits, misses, volume_ratio, confluence_score,
            session_info, market_type,
            tf_bear_count, tf_bull_count, tf_alignment_score, highest_tf_conflict)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
          [r.asset, r.direction, r.prob, r.confidence,
           r.marketQuality, r.rr, r.price, r.stopPrice, r.targetPrice,
           r.stopPct, r.targetPct, r.regime, false, r.timeframe || '15m',
           JSON.stringify({ ...(r.signalSnapshot || {}), cross_tf: r.crossTF, cross_tf_summary: r.crossTFSummary, market_structure: r.marketStructure }),
           r.rawProb, r.ev, r.atrValue,
           JSON.stringify(r.hits || []), JSON.stringify(r.misses || []),
           r.volumeRatio, r.confluenceScore,
           r.sessionInfo || null, 'stock',
           r.crossTFSummary?.bear_alignment || 0, r.crossTFSummary?.bull_alignment || 0,
           r.crossTFSummary?.alignment_score || 0, r.crossTFSummary?.highest_tf_conflict || null]
        );
        inserted++;
      } catch (e) {
        console.warn(`[StockScanner] Insert failed for ${r.asset}:`, e.message);
        // Fallback basic insert
        try {
          await pool.query(
            `INSERT INTO stock_trades_log
             (asset, direction, probability, confidence, market_quality, rr_ratio,
              entry_price, stop_price, target_price, stop_pct, target_pct, regime, executed, timeframe, market_type)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [r.asset, r.direction, r.prob, r.confidence,
             r.marketQuality, r.rr, r.price, r.stopPrice, r.targetPrice,
             r.stopPct, r.targetPct, r.regime, false, r.timeframe || '15m', 'stock']
          );
          inserted++;
        } catch (e2) {
          console.error(`[StockScanner] BOTH inserts failed for ${r.asset}:`, e2.message);
        }
      }
    }

    const topInfo = top.map(r => `${r.asset}/${r.direction}/${r.timeframe}(${r.prob}%,ev=${r.ev?.toFixed(3)})`).join(', ');
    console.log(`[StockScanner] _logResults: ${inserted} new, ${updated} updated, ${top.length} candidates [${topInfo}]`);

    if (!this.lastLogAttempt) this.lastLogAttempt = {};
    const tf = top[0]?.timeframe || results[0]?.timeframe || 'unknown';
    this.lastLogAttempt[tf] = { time: new Date().toISOString(), inserted, updated, candidates: top.length };
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

  _startResolutionTimer() {
    if (this.resolutionTimer) clearInterval(this.resolutionTimer);
    this.resolutionTimer = setInterval(() => {
      this._resolveOpenPredictions().catch(e =>
        console.error('[StockScanner] Resolution check error:', e.message));
    }, 5 * 60_000);
    setTimeout(() => this._resolveOpenPredictions().catch(() => {}), 90_000);
    console.log('[StockScanner] Resolution tracker started (every 5 min)');

    // Retention cleanup (daily)
    this._runRetentionCleanup();
    this.retentionTimer = setInterval(() => this._runRetentionCleanup(), 24 * 60 * 60_000);
  }

  async _runRetentionCleanup() {
    if (!pool) return;
    try {
      const result = await pool.query(
        `DELETE FROM stock_trades_log WHERE created_at < NOW() - INTERVAL '90 days' AND outcome IS NOT NULL`
      );
      if (result.rowCount > 0) console.log(`[StockScanner] Retention: deleted ${result.rowCount} resolved > 90 days`);

      const abandoned = await pool.query(
        `DELETE FROM stock_trades_log WHERE created_at < NOW() - INTERVAL '30 days' AND outcome IS NULL`
      );
      if (abandoned.rowCount > 0) console.log(`[StockScanner] Retention: deleted ${abandoned.rowCount} abandoned > 30 days`);
    } catch (e) {
      console.warn('[StockScanner] Retention cleanup error:', e.message);
    }
  }

  async _resolveOpenPredictions() {
    if (!pool) return;

    let pending;
    try {
      const result = await pool.query(
        `SELECT id, asset, direction, entry_price, stop_price, target_price, timeframe, created_at
         FROM stock_trades_log
         WHERE outcome IS NULL AND entry_price IS NOT NULL AND stop_price IS NOT NULL AND target_price IS NOT NULL
         ORDER BY created_at ASC LIMIT 100`
      );
      pending = result.rows;
    } catch (e) {
      console.warn('[StockScanner] Resolution query error:', e.message);
      return;
    }

    if (pending.length === 0) return;

    const byAsset = {};
    for (const row of pending) {
      if (!byAsset[row.asset]) byAsset[row.asset] = [];
      byAsset[row.asset].push(row);
    }

    let resolved = 0;
    for (const [asset, rows] of Object.entries(byAsset)) {
      try {
        // Use the actual BloFin symbol from STOCK_ASSETS (e.g., CRCL -> CRCULUSDT, not CRCLUSDT)
        const assetDef = STOCK_ASSETS.find(a => a.label === asset);
        const sym = assetDef ? assetDef.sym : (asset + 'USDT');
        for (const row of rows) {
          const entryPrice = parseFloat(row.entry_price);
          const stopPrice = parseFloat(row.stop_price);
          const targetPrice = parseFloat(row.target_price);
          const tf = row.timeframe || '15m';

          const predAgeMs = Date.now() - new Date(row.created_at).getTime();
          const tfMs = { '15m': 15*60e3, '1h': 60*60e3, '4h': 4*60*60e3, '1d': 24*60*60e3 };
          const candlesNeeded = Math.min(200, Math.ceil(predAgeMs / (tfMs[tf] || 4*60*60e3)) + 2);

          if (candlesNeeded < 2) continue;

          // Expire very old predictions
          const maxAgeMs = ['15m'].includes(tf) ? 7 * 24 * 60 * 60e3 : 30 * 24 * 60 * 60e3;
          if (predAgeMs > maxAgeMs) {
            await pool.query(`UPDATE stock_trades_log SET outcome='expired', resolved_at=NOW() WHERE id=$1`, [row.id]);
            resolved++;
            continue;
          }

          const candles = await fetchKlines(sym, tf, candlesNeeded);
          if (!candles || candles.length < 2) continue;

          const predTime = new Date(row.created_at).getTime();
          const postEntryCandles = candles.filter(c => c.t > predTime);
          if (postEntryCandles.length === 0) continue;

          let outcome = null;
          for (const c of postEntryCandles) {
            if (row.direction === 'long') {
              const hitSL = c.l <= stopPrice;
              const hitTP = c.h >= targetPrice;
              if (hitSL && hitTP) outcome = (c.o - stopPrice) < (targetPrice - c.o) ? 'loss' : 'win';
              else if (hitSL) outcome = 'loss';
              else if (hitTP) outcome = 'win';
            } else {
              const hitSL = c.h >= stopPrice;
              const hitTP = c.l <= targetPrice;
              if (hitSL && hitTP) outcome = (stopPrice - c.o) < (c.o - targetPrice) ? 'loss' : 'win';
              else if (hitSL) outcome = 'loss';
              else if (hitTP) outcome = 'win';
            }
            if (outcome) break;
          }

          if (outcome) {
            let pnl = 0;
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
              `UPDATE stock_trades_log SET outcome=$1, pnl=$2, resolved_at=NOW() WHERE id=$3`,
              [outcome, parseFloat(pnl.toFixed(4)), row.id]
            );
            resolved++;
          }

          await new Promise(r => setTimeout(r, 250));
        }
      } catch (e) {
        console.warn(`[StockScanner] Resolution error for ${asset}:`, e.message);
      }
    }

    if (resolved > 0) {
      console.log(`[StockScanner] Resolved ${resolved} predictions`);
      this._broadcast('resolution', { resolved });
    }
  }

  // ── Stats / Win Rate API ──

  async getStats(filters = {}) {
    if (!pool) return { error: 'No database' };

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
        FROM stock_trades_log ${filterWhere}
      `, filterParams);

      const byTimeframe = await pool.query(`
        SELECT
          COALESCE(timeframe, '15m') AS timeframe,
          COUNT(*) FILTER (WHERE outcome IS NOT NULL) AS total_resolved,
          COUNT(*) FILTER (WHERE outcome = 'win') AS wins,
          COUNT(*) FILTER (WHERE outcome = 'loss') AS losses,
          COUNT(*) FILTER (WHERE outcome IS NULL) AS pending,
          ROUND(
            CASE WHEN COUNT(*) FILTER (WHERE outcome IN ('win','loss')) > 0
              THEN COUNT(*) FILTER (WHERE outcome = 'win')::DECIMAL / COUNT(*) FILTER (WHERE outcome IN ('win','loss')) * 100
              ELSE 0
            END, 1
          ) AS win_rate,
          ROUND(AVG(pnl) FILTER (WHERE outcome IN ('win','loss')), 4) AS avg_pnl
        FROM stock_trades_log ${filterWhere}
        GROUP BY COALESCE(timeframe, '15m')
        ORDER BY COALESCE(timeframe, '15m')
      `, filterParams);

      const byConfidence = await pool.query(`
        SELECT confidence,
          COUNT(*) FILTER (WHERE outcome IN ('win','loss')) AS total,
          COUNT(*) FILTER (WHERE outcome = 'win') AS wins,
          ROUND(
            CASE WHEN COUNT(*) FILTER (WHERE outcome IN ('win','loss')) > 0
              THEN COUNT(*) FILTER (WHERE outcome = 'win')::DECIMAL / COUNT(*) FILTER (WHERE outcome IN ('win','loss')) * 100
              ELSE 0
            END, 1
          ) AS win_rate,
          ROUND(AVG(pnl) FILTER (WHERE outcome IN ('win','loss')), 4) AS avg_pnl
        FROM stock_trades_log
        WHERE confidence IS NOT NULL ${filterWhereAnd}
        GROUP BY confidence ORDER BY confidence
      `, filterParams);

      const byQuality = await pool.query(`
        SELECT market_quality,
          COUNT(*) FILTER (WHERE outcome IN ('win','loss')) AS total,
          COUNT(*) FILTER (WHERE outcome = 'win') AS wins,
          ROUND(
            CASE WHEN COUNT(*) FILTER (WHERE outcome IN ('win','loss')) > 0
              THEN COUNT(*) FILTER (WHERE outcome = 'win')::DECIMAL / COUNT(*) FILTER (WHERE outcome IN ('win','loss')) * 100
              ELSE 0
            END, 1
          ) AS win_rate,
          ROUND(AVG(pnl) FILTER (WHERE outcome IN ('win','loss')), 4) AS avg_pnl
        FROM stock_trades_log
        WHERE market_quality IS NOT NULL ${filterWhereAnd}
        GROUP BY market_quality ORDER BY market_quality
      `, filterParams);

      const byRegime = await pool.query(`
        SELECT regime,
          COUNT(*) FILTER (WHERE outcome IN ('win','loss')) AS total,
          COUNT(*) FILTER (WHERE outcome = 'win') AS wins,
          ROUND(
            CASE WHEN COUNT(*) FILTER (WHERE outcome IN ('win','loss')) > 0
              THEN COUNT(*) FILTER (WHERE outcome = 'win')::DECIMAL / COUNT(*) FILTER (WHERE outcome IN ('win','loss')) * 100
              ELSE 0
            END, 1
          ) AS win_rate,
          ROUND(AVG(pnl) FILTER (WHERE outcome IN ('win','loss')), 4) AS avg_pnl
        FROM stock_trades_log
        WHERE regime IS NOT NULL ${filterWhereAnd}
        GROUP BY regime ORDER BY regime
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
      };
    } catch (e) {
      console.error('[StockScanner] Stats query error:', e.message);
      return { error: e.message };
    }
  }

  // ── DB Persistence ──

  async _loadSettings() {
    if (!pool) return;
    try {
      const result = await pool.query('SELECT * FROM stock_trades_settings WHERE id = 1');
      if (result.rows.length > 0) {
        const row = result.rows[0];
        this.settings.enabled = row.enabled !== false;
        this.settings.minProb = row.min_prob || 65;
        this.settings.bannedAssets = row.banned_assets || [];
        console.log(`[StockScanner] Settings loaded: enabled=${this.settings.enabled}, minProb=${this.settings.minProb}, banned=${(this.settings.bannedAssets || []).length}`);
      }
    } catch (e) {
      console.warn('[StockScanner] Settings load error:', e.message);
    }
  }

  async _saveSettings() {
    if (!pool) return;
    try {
      await pool.query(
        `INSERT INTO stock_trades_settings (id, enabled, min_prob, banned_assets, updated_at)
         VALUES (1, $1, $2, $3, NOW())
         ON CONFLICT (id) DO UPDATE SET enabled=$1, min_prob=$2, banned_assets=$3, updated_at=NOW()`,
        [this.settings.enabled, this.settings.minProb, JSON.stringify(this.settings.bannedAssets || [])]
      );
    } catch (e) {
      console.warn('[StockScanner] Settings save error:', e.message);
    }
  }

  // ── Public API ──

  getLastResults() { return this.lastResults; }
  getLastScanTime() { return this.lastScanTime; }

  getStatus() {
    const activeTimers = Object.keys(this.scanTimers);
    const tfStatus = {};
    for (const tf of STOCK_TIMEFRAMES) {
      const intervalMs = STOCK_SCAN_INTERVALS[tf] || 60 * 60_000;
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

    const { session: currentSession, multiplier: currentMult } = getUSSessionMultiplier();

    return {
      scannerType: 'stock',
      enabled: this.settings.enabled,
      running: activeTimers.length > 0,
      mode: 'scan-only',
      timeframes: STOCK_TIMEFRAMES,
      activeTimers: activeTimers.length,
      minProb: this.settings.minProb,
      lastScanTime: this.lastScanTime,
      resultsCount: this.lastResults.length,
      qualifyingCount: this.lastResults.filter(r => r.prob >= this.settings.minProb).length,
      topSetup: this.lastResults[0] || null,
      tfStatus,
      marketSession: { session: currentSession, multiplier: currentMult },
      heartbeat: this.heartbeat,
      calibration: {
        totalResolved: stockCalibrationCache.overall.totalResolved,
        overallWR: (stockCalibrationCache.overall.winRate * 100).toFixed(1),
        lastRefresh: stockCalibrationCache.lastRefresh ? new Date(stockCalibrationCache.lastRefresh).toISOString() : null,
      },
      assets: STOCK_ASSETS.map(a => a.label),
      bannedAssets: this.settings.bannedAssets || [],
      notes: 'Scan-only mode. NO auto-trading. Uses SPY regime (not BTC). Mean-reversion enabled for longs.',
    };
  }
}

const stockScanner = new StockScanner();
module.exports = stockScanner;
