/**
 * Server-side Best Trades Scanner
 * Mirrors the frontend probability engine so trades execute 24/7 on Railway
 * even when the user's browser is closed.
 */
const { fetchKlines } = require('./binance');
const { sma, ema, rsi, stdev, atr } = require('./indicators');
const blofinClient = require('./blofinClient');
const liveEngine = require('./liveEngine');
let pool = null;
try { pool = require('../db').pool; } catch {}

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

// Scan intervals matching frontend AUTO_SCAN_INTERVALS
const SCAN_INTERVALS = {
  '1m': 60_000, '3m': 2 * 60_000, '5m': 3 * 60_000,
  '15m': 10 * 60_000, '30m': 15 * 60_000, '1h': 30 * 60_000,
  '4h': 60 * 60_000, '1d': 4 * 60 * 60_000,
};

const TRADING_FEE_PCT = 0.06; // BloFin taker fee per side

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
  const marketQuality = mqScore >= 7 ? 'A' : mqScore >= 4 ? 'B' : mqScore >= 1 ? 'C' : 'No-Trade';

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

  return { signals: results, atr: currentATR, price, macro_bull, marketQuality, mqScore, entryEfficiency };
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

  // Kelly-based optimal leverage
  const conf = confidence || 'Low';
  let kellyMult = 0.4;
  if (marketQuality === 'A' && conf === 'High') kellyMult = 0.6;
  else if (marketQuality === 'A' && conf === 'Medium') kellyMult = 0.5;
  else if (marketQuality === 'B') kellyMult = 0.4;
  else if (marketQuality === 'C') kellyMult = 0.25;
  else if (marketQuality === 'No-Trade') kellyMult = 0.15;

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
      timeframe: '4h',
      minProb: 70,
      tradeSizeUsd: 100,
      maxOpen: 3,
      leverage: 1,
    };
    this.scanTimer = null;
    this.lastResults = [];
    this.lastScanTime = null;
    this.openTradeCount = 0;
    this.sseClients = [];
  }

  async start() {
    await this._loadSettings();
    if (this.settings.enabled) {
      this._startTimer();
    }
    console.log(`[BestTrades] Scanner initialized. Enabled: ${this.settings.enabled}, TF: ${this.settings.timeframe}, Mode: ${this.settings.mode}`);
  }

  stop() {
    this._stopTimer();
    console.log('[BestTrades] Scanner stopped.');
  }

  // ── Settings Management ──

  async getSettings() {
    return { ...this.settings };
  }

  async updateSettings(newSettings) {
    Object.assign(this.settings, newSettings);
    await this._saveSettings();

    // Restart timer with new interval
    this._stopTimer();
    if (this.settings.enabled) {
      this._startTimer();
      console.log(`[BestTrades] Scanner enabled — scanning every ${this._getIntervalLabel()}`);
    } else {
      console.log('[BestTrades] Scanner disabled.');
    }
    // Notify SSE clients
    this._broadcast('settings', this.settings);
    return this.settings;
  }

  // ── Timer Management ──

  _startTimer() {
    this._stopTimer();
    const intervalMs = SCAN_INTERVALS[this.settings.timeframe] || 60 * 60_000;
    console.log(`[BestTrades] Starting scan timer: every ${this._getIntervalLabel()} for ${this.settings.timeframe}`);

    // Run first scan after 30s (let server warm up)
    setTimeout(() => this.scan().catch(e => console.error('[BestTrades] Initial scan error:', e.message)), 30000);

    this.scanTimer = setInterval(() => {
      this.scan().catch(e => console.error('[BestTrades] Scan error:', e.message));
    }, intervalMs);
  }

  _stopTimer() {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  _getIntervalLabel() {
    const ms = SCAN_INTERVALS[this.settings.timeframe] || 60 * 60_000;
    return ms < 60000 ? `${ms / 1000}s` : `${ms / 60000}m`;
  }

  // ── Main Scan ──

  async scan() {
    if (!this.settings.enabled) return [];
    console.log(`[BestTrades] Scanning ${ASSETS.length} assets on ${this.settings.timeframe}...`);

    const results = [];
    let btcRegime = 'neutral';

    // Scan BTC first for macro regime
    try {
      const btcCandles = await fetchKlines('BTCUSDT', this.settings.timeframe, 200);
      if (btcCandles && btcCandles.length > 50) {
        btcRegime = detectRegime(btcCandles);
      }
    } catch (e) {
      console.warn('[BestTrades] BTC regime fetch error:', e.message);
    }

    // Scan all assets
    for (const asset of ASSETS) {
      try {
        const candles = await fetchKlines(asset.sym, this.settings.timeframe, 200);
        if (!candles || candles.length < 50) continue;

        const analysis = computeSignals(candles, this.settings.timeframe);
        const { signals, atr: atrVal, price, marketQuality, entryEfficiency } = analysis;

        // Detect local regime, blend with BTC
        const localRegime = detectRegime(candles);
        // 60% BTC-heavy for alts, 50/50 for majors
        const isMajor = ['BTC', 'ETH', 'SOL', 'BNB'].includes(asset.label);
        const regime = asset.label === 'BTC' ? btcRegime
          : (isMajor ? localRegime : btcRegime); // simplified blend

        // Score both directions
        const longScore = scoreConfluence(signals, 'long', regime, this.settings.timeframe, marketQuality);
        const shortScore = scoreConfluence(signals, 'short', regime, this.settings.timeframe, marketQuality);

        // Pick best direction
        const best = longScore.prob >= shortScore.prob ? longScore : shortScore;
        const direction = longScore.prob >= shortScore.prob ? 'long' : 'short';

        // Estimate R/R
        const rrData = estimateRR(price, atrVal, direction, best.prob, this.settings.leverage,
          best.confidence, candles, marketQuality);

        results.push({
          asset: asset.label,
          sym: asset.sym,
          direction,
          prob: best.prob,
          longProb: longScore.prob,
          shortProb: shortScore.prob,
          confidence: best.confidence,
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
          timestamp: new Date().toISOString(),
        });

        // Small delay to avoid Binance rate limits
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        console.warn(`[BestTrades] ${asset.label} scan error:`, e.message);
      }
    }

    // Sort by probability (highest first)
    results.sort((a, b) => b.prob - a.prob);
    this.lastResults = results;
    this.lastScanTime = new Date().toISOString();

    // Log results to DB
    await this._logResults(results);

    // Process auto-trades
    await this._processAutoTrades(results);

    // Broadcast to SSE clients
    this._broadcast('scan', { results: results.slice(0, 10), timestamp: this.lastScanTime });

    const qualifying = results.filter(r => r.prob >= this.settings.minProb);
    console.log(`[BestTrades] Scan complete: ${results.length} assets, ${qualifying.length} qualifying (>=${this.settings.minProb}%), top: ${results[0]?.asset} ${results[0]?.direction} ${results[0]?.prob}%`);

    return results;
  }

  // ── Auto-Trade Execution ──

  async _processAutoTrades(results) {
    if (this.settings.mode !== 'auto') return;

    // Filter qualifying setups
    const qualifying = results.filter(r =>
      r.prob >= this.settings.minProb &&
      r.marketQuality !== 'No-Trade' &&
      r.confidence !== 'Low' &&
      r.entryEfficiency !== 'Chasing' &&
      r.ev > 0
    );

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

    const slotsAvailable = this.settings.maxOpen - openCount;
    const toTrade = qualifying.slice(0, slotsAvailable);

    for (const setup of toTrade) {
      const posSize = Math.round(this.settings.tradeSizeUsd * (setup.mqSizeMult || 1));
      if (availableBalance < posSize) {
        console.log(`[BestTrades] Insufficient balance ($${availableBalance.toFixed(2)} < $${posSize})`);
        break;
      }

      try {
        await this._executeTradeOnBloFin(setup, posSize, userId, creds, demo);
        availableBalance -= posSize;
        openCount++;
      } catch (e) {
        console.error(`[BestTrades] Trade execution failed for ${setup.asset}:`, e.message);
      }
    }
  }

  async _executeTradeOnBloFin(setup, posSize, userId, creds, demo) {
    const instId = setup.asset + '-USDT';
    const side = setup.direction === 'long' ? 'buy' : 'sell';
    const lev = Math.max(setup.optimalLev || 1, this.settings.leverage || 1);

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
            entry_price, stop_price, target_price, stop_pct, target_pct, regime, executed, order_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [setup.asset, setup.direction, setup.prob, setup.confidence,
           setup.marketQuality, setup.rr, setup.price, setup.stopPrice, setup.targetPrice,
           setup.stopPct, setup.targetPct, setup.regime, true, result.orderId || null]
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
        this.settings.timeframe = row.timeframe || '4h';
        this.settings.minProb = row.min_prob || 70;
        this.settings.tradeSizeUsd = parseFloat(row.trade_size_usd) || 100;
        this.settings.maxOpen = row.max_open || 3;
        this.settings.leverage = row.leverage || 1;
        console.log(`[BestTrades] Settings loaded from DB: enabled=${this.settings.enabled}, tf=${this.settings.timeframe}`);
      }
    } catch (e) {
      console.warn('[BestTrades] Settings load error:', e.message);
    }
  }

  async _saveSettings() {
    if (!pool) return;
    try {
      await pool.query(
        `INSERT INTO best_trades_settings (id, enabled, mode, timeframe, min_prob, trade_size_usd, max_open, leverage, updated_at)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (id) DO UPDATE SET
           enabled=$1, mode=$2, timeframe=$3, min_prob=$4,
           trade_size_usd=$5, max_open=$6, leverage=$7, updated_at=NOW()`,
        [this.settings.enabled, this.settings.mode, this.settings.timeframe,
         this.settings.minProb, this.settings.tradeSizeUsd, this.settings.maxOpen, this.settings.leverage]
      );
    } catch (e) {
      console.warn('[BestTrades] Settings save error:', e.message);
    }
  }

  async _logResults(results) {
    if (!pool) return;
    // Log top 5 qualifying results
    const top = results.filter(r => r.prob >= this.settings.minProb).slice(0, 5);
    for (const r of top) {
      try {
        await pool.query(
          `INSERT INTO best_trades_log
           (asset, direction, probability, confidence, market_quality, rr_ratio,
            entry_price, stop_price, target_price, stop_pct, target_pct, regime, executed)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [r.asset, r.direction, r.prob, r.confidence,
           r.marketQuality, r.rr, r.price, r.stopPrice, r.targetPrice,
           r.stopPct, r.targetPct, r.regime, false]
        );
      } catch {}
    }
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

  // ── Public API ──

  getLastResults() { return this.lastResults; }
  getLastScanTime() { return this.lastScanTime; }
  isRunning() { return this.settings.enabled && this.scanTimer !== null; }

  getStatus() {
    return {
      enabled: this.settings.enabled,
      running: this.scanTimer !== null,
      mode: this.settings.mode,
      timeframe: this.settings.timeframe,
      minProb: this.settings.minProb,
      tradeSizeUsd: this.settings.tradeSizeUsd,
      maxOpen: this.settings.maxOpen,
      leverage: this.settings.leverage,
      lastScanTime: this.lastScanTime,
      resultsCount: this.lastResults.length,
      qualifyingCount: this.lastResults.filter(r => r.prob >= this.settings.minProb).length,
      topSetup: this.lastResults[0] || null,
      scanInterval: this._getIntervalLabel(),
    };
  }
}

const scanner = new BestTradesScanner();
module.exports = scanner;
