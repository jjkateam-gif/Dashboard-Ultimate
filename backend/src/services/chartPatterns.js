/**
 * chartPatterns.js
 *
 * Standalone chart pattern detection and scoring module.
 * Receives OHLCV candle data and returns detected patterns with scores.
 *
 * Usage:
 *   const { detectPatterns } = require('./chartPatterns');
 *   const result = detectPatterns(candles, '1h', 'bull');
 */

'use strict';

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const TF_WEIGHTS = {
  '5m': 0.30, '15m': 0.50, '30m': 0.60,
  '1h': 0.70, '4h': 0.90, '1D': 1.00
};

const STAGE_MOD = {
  forming: 0.20, developing: 0.50, confirmed: 0.75,
  breakout: 1.0, retest: 1.15
};

const SIGNAL_DECAY = {
  '5m': 6, '15m': 8, '30m': 10,
  '1h': 12, '4h': 10, '1D': 8
};

const CRYPTO_MOD = 0.90;

// ─── HELPER FUNCTIONS ────────────────────────────────────────────────────────

/**
 * Simple Moving Average over `period` values from an array of numbers.
 */
function sma(values, period) {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) {
    sum += values[i];
  }
  return sum / period;
}

/**
 * Average True Range over the last `period` candles.
 */
function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trValues = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prevClose = candles[i - 1].c;
    const tr = Math.max(
      cur.h - cur.l,
      Math.abs(cur.h - prevClose),
      Math.abs(cur.l - prevClose)
    );
    trValues.push(tr);
  }
  // Use simple average of last `period` TR values
  if (trValues.length < period) return null;
  let sum = 0;
  for (let i = trValues.length - period; i < trValues.length; i++) {
    sum += trValues[i];
  }
  return sum / period;
}

/**
 * Least-squares linear regression on an array of numbers.
 * Returns { slope, intercept, r2 }.
 */
function linearRegression(values) {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] || 0, r2: 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
    sumY2 += values[i] * values[i];
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n, r2: 0 };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  // R-squared
  const ssRes = values.reduce((acc, y, i) => {
    const pred = intercept + slope * i;
    return acc + (y - pred) ** 2;
  }, 0);
  const mean = sumY / n;
  const ssTot = values.reduce((acc, y) => acc + (y - mean) ** 2, 0);
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { slope, intercept, r2 };
}

/**
 * RSI(14) calculation. Returns array of RSI values aligned with candles (first `period` are null).
 */
function computeRSI(candles, period = 14) {
  if (candles.length < period + 1) return [];
  const rsi = new Array(candles.length).fill(null);
  let avgGain = 0;
  let avgLoss = 0;

  // Initial average gain/loss
  for (let i = 1; i <= period; i++) {
    const change = candles[i].c - candles[i - 1].c;
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // Subsequent values using smoothed averages
  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i].c - candles[i - 1].c;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

/**
 * MACD(12,26,9) calculation.
 * Returns { macd[], signal[], histogram[] } arrays aligned with candles.
 */
function computeMACD(candles, fast = 12, slow = 26, sig = 9) {
  if (candles.length < slow + sig) return { macd: [], signal: [], histogram: [] };

  const closes = candles.map(c => c.c);
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);

  const macdLine = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    if (emaFast[i] !== null && emaSlow[i] !== null) {
      macdLine[i] = emaFast[i] - emaSlow[i];
    }
  }

  // Signal line: EMA of MACD values
  const macdValues = macdLine.filter(v => v !== null);
  const signalEma = ema(macdValues, sig);

  const signalLine = new Array(candles.length).fill(null);
  const histogram = new Array(candles.length).fill(null);
  let idx = 0;
  for (let i = 0; i < candles.length; i++) {
    if (macdLine[i] !== null) {
      if (signalEma[idx] !== null) {
        signalLine[i] = signalEma[idx];
        histogram[i] = macdLine[i] - signalEma[idx];
      }
      idx++;
    }
  }

  return { macd: macdLine, signal: signalLine, histogram };
}

/**
 * EMA calculation. Returns array aligned with input (nulls before period is met).
 */
function ema(values, period) {
  const result = new Array(values.length).fill(null);
  if (values.length < period) return result;

  // Seed with SMA
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  result[period - 1] = sum / period;

  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

/**
 * Detect swing pivots using a `lookback` bar lookback/lookahead window.
 * Returns { highs: [{ index, value }], lows: [{ index, value }] }
 */
function swingPivots(candles, lookback = 5) {
  const highs = [];
  const lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].h >= candles[i].h) isHigh = false;
      if (candles[j].l <= candles[i].l) isLow = false;
    }
    if (isHigh) highs.push({ index: i, value: candles[i].h });
    if (isLow) lows.push({ index: i, value: candles[i].l });
  }
  return { highs, lows };
}

/**
 * Average volume over last N candles.
 */
function avgVolume(candles, period = 20) {
  const start = Math.max(0, candles.length - period);
  let sum = 0;
  let count = 0;
  for (let i = start; i < candles.length; i++) {
    sum += (candles[i].v || 0);
    count++;
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Volume modifier based on ratio to average.
 */
function volumeModifier(ratio) {
  if (ratio < 0.8) return 0.5;
  if (ratio <= 1.2) return 0.8;
  if (ratio <= 2.0) return 1.2;
  if (ratio <= 3.0) return 1.0;
  return 0.7;
}

/**
 * Regime modifier for a given pattern type and market regime.
 */
function regimeModifier(patternDirection, patternType, regime) {
  const isContinuation = patternType === 'continuation';
  const isReversal = patternType === 'reversal';
  const isTrending = regime === 'bull' || regime === 'bear';
  const isRanging = regime === 'ranging';
  const isVolatile = regime === 'volatile';

  if (isVolatile) return 0.7;

  if (isContinuation && isTrending) {
    // Aligned continuation in trend
    if ((patternDirection === 'bullish' && regime === 'bull') ||
        (patternDirection === 'bearish' && regime === 'bear')) {
      return 1.2;
    }
    // Counter-trend continuation
    return 0.8;
  }
  if (isContinuation && isRanging) return 0.6;
  if (isReversal && isTrending) return 0.5;
  if (isReversal && isRanging) return 1.1;

  return 1.0;
}

/**
 * Score a single pattern detection.
 */
function scorePattern(baseWinRate, tf, volRatio, stage, direction, type, regime) {
  const tfW = TF_WEIGHTS[tf] || 0.50;
  const volMod = volumeModifier(volRatio);
  const stgMod = STAGE_MOD[stage] || 0.50;
  const regMod = regimeModifier(direction, type, regime);
  return baseWinRate * CRYPTO_MOD * tfW * volMod * stgMod * regMod;
}


// ─── PATTERN DETECTORS ──────────────────────────────────────────────────────

/**
 * 1. Bull Flag / Bear Flag
 */
function detectFlags(candles, tf, regime) {
  const results = [];
  const atrVal = atr(candles, 14);
  if (!atrVal || candles.length < 20) return results;

  const avgVol = avgVolume(candles, 20);

  // Try both bull and bear flags
  for (const dir of ['bull', 'bear']) {
    // Scan for impulse legs ending at various points
    for (let end = 10; end < candles.length - 3; end++) {
      // Impulse: 3-8 candles
      for (let len = 3; len <= Math.min(8, end); len++) {
        const start = end - len;
        const impulseCandles = candles.slice(start, end + 1);
        const move = dir === 'bull'
          ? candles[end].c - candles[start].o
          : candles[start].o - candles[end].c;

        if (move < 1.5 * atrVal) continue;

        // Check 60%+ candles in direction
        const dirCount = impulseCandles.filter(c =>
          dir === 'bull' ? c.c > c.o : c.c < c.o
        ).length;
        if (dirCount / impulseCandles.length < 0.6) continue;

        // Check for consolidation after impulse
        const consStart = end + 1;
        const consEnd = Math.min(candles.length - 1, consStart + 15);
        if (consEnd - consStart < 2) continue;

        const consCandles = candles.slice(consStart, consEnd + 1);
        const consHighs = consCandles.map(c => c.h);
        const consLows = consCandles.map(c => c.l);
        const consRange = Math.max(...consHighs) - Math.min(...consLows);
        const impulseRange = Math.abs(move);

        // Range < 50% of impulse
        if (consRange >= 0.5 * impulseRange) continue;

        // Slight counter-slope check
        const consCloses = consCandles.map(c => c.c);
        const reg = linearRegression(consCloses);
        const slopeDir = reg.slope > 0 ? 'up' : 'down';
        const isCounterSlope = (dir === 'bull' && slopeDir === 'down') ||
                               (dir === 'bear' && slopeDir === 'up');
        if (!isCounterSlope && Math.abs(reg.slope) > 0.001 * candles[end].c) continue;

        // Determine stage
        let stage = 'forming';
        const consBoundary = dir === 'bull'
          ? Math.max(...consHighs)
          : Math.min(...consLows);

        // Check if consolidation is tight enough for confirmed
        if (consCandles.length >= 5 && consRange < 0.3 * impulseRange) {
          stage = 'confirmed';
        }

        // Check for breakout
        const lastCandle = candles[candles.length - 1];
        const lastVol = lastCandle.v || 0;
        const volRatio = avgVol > 0 ? lastVol / avgVol : 1;

        if (dir === 'bull' && lastCandle.c > consBoundary && volRatio > 1.3) {
          stage = 'breakout';
        } else if (dir === 'bear' && lastCandle.c < consBoundary && volRatio > 1.3) {
          stage = 'breakout';
        }

        // High-tight flag: impulse > 3× ATR, consolidation < 20% of impulse
        const isHighTight = move > 3 * atrVal && consRange < 0.2 * impulseRange;
        const baseWinRate = dir === 'bull'
          ? (isHighTight ? 0.77 : 0.41)
          : 0.41;

        const direction = dir === 'bull' ? 'bullish' : 'bearish';
        const score = scorePattern(baseWinRate, tf, volRatio, stage, direction, 'continuation', regime);

        results.push({
          name: `${dir === 'bull' ? 'Bull' : 'Bear'} Flag${isHighTight ? ' (High-Tight)' : ''}`,
          type: 'continuation',
          direction,
          baseWinRate,
          stage,
          score,
          volumeRatio: Math.round(volRatio * 100) / 100,
          expiresInBars: SIGNAL_DECAY[tf] || 10,
          description: `${dir === 'bull' ? 'Bull' : 'Bear'} flag ${stage} — impulse ${len} bars, consolidation ${consCandles.length} bars`
        });

        // Only report the best flag per direction; break after first valid detection
        break;
      }
      if (results.some(r => r.name.startsWith(dir === 'bull' ? 'Bull' : 'Bear'))) break;
    }
  }
  return results;
}

/**
 * 2. Falling Wedge / Rising Wedge
 */
function detectWedges(candles, tf, regime) {
  const results = [];
  if (candles.length < 20) return results;

  const avgVol = avgVolume(candles, 20);
  const lastCandle = candles[candles.length - 1];
  const volRatio = avgVol > 0 ? (lastCandle.v || 0) / avgVol : 1;

  // Test windows from 20 to 50 candles
  for (let window = Math.min(50, candles.length); window >= 20; window -= 5) {
    const slice = candles.slice(candles.length - window);
    const highs = slice.map(c => c.h);
    const lows = slice.map(c => c.l);

    const highReg = linearRegression(highs);
    const lowReg = linearRegression(lows);

    const avgPrice = (highs[highs.length - 1] + lows[lows.length - 1]) / 2;
    const highSlopePct = (highReg.slope / avgPrice) * 100;
    const lowSlopePct = (lowReg.slope / avgPrice) * 100;

    // Converging check: the gap between lines is shrinking
    const startGap = (highReg.intercept) - (lowReg.intercept);
    const endGap = (highReg.intercept + highReg.slope * (window - 1)) -
                   (lowReg.intercept + lowReg.slope * (window - 1));
    const isConverging = Math.abs(endGap) < Math.abs(startGap);
    if (!isConverging) continue;

    let patternName = null;
    let baseWinRate = 0;
    let direction = '';

    // Falling wedge: both slopes negative, lows steeper
    if (highReg.slope < 0 && lowReg.slope < 0 && lowReg.slope < highReg.slope) {
      patternName = 'Falling Wedge';
      baseWinRate = 0.67;
      direction = 'bullish';
    }
    // Rising wedge: both slopes positive, highs less steep than lows
    else if (highReg.slope > 0 && lowReg.slope > 0 && highReg.slope < lowReg.slope) {
      patternName = 'Rising Wedge';
      baseWinRate = 0.73;
      direction = 'bearish';
    }

    if (!patternName) continue;

    // Touch count validation: at least 5 touches (3 on one line, 2 on the other)
    const tolerance = avgPrice * 0.005; // 0.5%
    let highTouches = 0;
    let lowTouches = 0;
    for (let i = 0; i < slice.length; i++) {
      const expectedHigh = highReg.intercept + highReg.slope * i;
      const expectedLow = lowReg.intercept + lowReg.slope * i;
      if (Math.abs(slice[i].h - expectedHigh) <= tolerance) highTouches++;
      if (Math.abs(slice[i].l - expectedLow) <= tolerance) lowTouches++;
    }

    const totalTouches = highTouches + lowTouches;
    if (totalTouches < 5 || Math.min(highTouches, lowTouches) < 2) continue;

    // Determine stage
    let stage = 'developing';
    const lastExpHigh = highReg.intercept + highReg.slope * (window - 1);
    const lastExpLow = lowReg.intercept + lowReg.slope * (window - 1);
    if (direction === 'bullish' && lastCandle.c > lastExpHigh) {
      stage = volRatio > 1.3 ? 'breakout' : 'confirmed';
    } else if (direction === 'bearish' && lastCandle.c < lastExpLow) {
      stage = volRatio > 1.3 ? 'breakout' : 'confirmed';
    }

    const score = scorePattern(baseWinRate, tf, volRatio, stage, direction, 'reversal', regime);

    results.push({
      name: patternName,
      type: 'reversal',
      direction,
      baseWinRate,
      stage,
      score,
      volumeRatio: Math.round(volRatio * 100) / 100,
      expiresInBars: SIGNAL_DECAY[tf] || 10,
      description: `${patternName} over ${window} bars — ${totalTouches} touches, R²(highs)=${highReg.r2.toFixed(2)}`
    });
    break; // Take the first valid wedge found
  }
  return results;
}

/**
 * 3. Ascending / Descending / Symmetrical Triangle
 */
function detectTriangles(candles, tf, regime) {
  const results = [];
  if (candles.length < 10) return results;

  const avgVol = avgVolume(candles, 20);
  const lastCandle = candles[candles.length - 1];
  const volRatio = avgVol > 0 ? (lastCandle.v || 0) / avgVol : 1;

  // Test from 10 to min(50, length) candles
  for (let window = Math.min(50, candles.length); window >= 10; window -= 5) {
    const slice = candles.slice(candles.length - window);
    const highs = slice.map(c => c.h);
    const lows = slice.map(c => c.l);

    const highReg = linearRegression(highs);
    const lowReg = linearRegression(lows);

    const avgPrice = (highs[0] + lows[0]) / 2;
    const highSlopePct = avgPrice > 0 ? (highReg.slope / avgPrice) * 100 : 0;
    const lowSlopePct = avgPrice > 0 ? (lowReg.slope / avgPrice) * 100 : 0;

    // Converging: gap between trend lines shrinks
    const startGap = (highReg.intercept) - (lowReg.intercept);
    const endGap = (highReg.intercept + highReg.slope * (window - 1)) -
                   (lowReg.intercept + lowReg.slope * (window - 1));
    if (endGap <= 0) continue; // Lines crossed — invalid

    let patternName = null;
    let baseWinRate = 0;
    let direction = '';

    // Ascending: flat highs, rising lows
    if (Math.abs(highSlopePct) < 0.1 && lowSlopePct > 0.05) {
      patternName = 'Ascending Triangle';
      baseWinRate = 0.75;
      direction = 'bullish';
    }
    // Descending: flat lows, falling highs
    else if (Math.abs(lowSlopePct) < 0.1 && highSlopePct < -0.05) {
      patternName = 'Descending Triangle';
      baseWinRate = 0.64;
      direction = 'bearish';
    }
    // Symmetrical: highs falling, lows rising, converging
    else if (highSlopePct < -0.03 && lowSlopePct > 0.03 && Math.abs(endGap) < Math.abs(startGap)) {
      patternName = 'Symmetrical Triangle';
      baseWinRate = 0.49;
      direction = 'neutral';
    }

    if (!patternName) continue;

    // Determine stage
    let stage = 'developing';
    const lastExpHigh = highReg.intercept + highReg.slope * (window - 1);
    const lastExpLow = lowReg.intercept + lowReg.slope * (window - 1);

    if (lastCandle.c > lastExpHigh && volRatio > 1.3) {
      stage = 'breakout';
      if (direction === 'neutral') direction = 'bullish';
    } else if (lastCandle.c < lastExpLow && volRatio > 1.3) {
      stage = 'breakout';
      if (direction === 'neutral') direction = 'bearish';
    } else if (Math.abs(endGap) < 0.3 * Math.abs(startGap)) {
      stage = 'confirmed'; // Apex approaching
    }

    const type = patternName === 'Symmetrical Triangle' ? 'continuation' : 'continuation';
    const score = scorePattern(baseWinRate, tf, volRatio, stage, direction, type, regime);

    results.push({
      name: patternName,
      type,
      direction,
      baseWinRate,
      stage,
      score,
      volumeRatio: Math.round(volRatio * 100) / 100,
      expiresInBars: SIGNAL_DECAY[tf] || 10,
      description: `${patternName} over ${window} bars — highSlope=${highSlopePct.toFixed(3)}%/bar, lowSlope=${lowSlopePct.toFixed(3)}%/bar`
    });
    break; // Take first valid triangle
  }
  return results;
}

/**
 * 4. Double Top / Double Bottom
 */
function detectDoubles(candles, tf, regime) {
  const results = [];
  if (candles.length < 20) return results;

  const pivots = swingPivots(candles, 5);
  const avgVol = avgVolume(candles, 20);
  const lastCandle = candles[candles.length - 1];
  const volRatio = avgVol > 0 ? (lastCandle.v || 0) / avgVol : 1;

  // Double Bottom: two swing lows within 2% tolerance
  for (let i = 0; i < pivots.lows.length - 1; i++) {
    for (let j = i + 1; j < pivots.lows.length; j++) {
      const p1 = pivots.lows[i];
      const p2 = pivots.lows[j];
      const separation = p2.index - p1.index;

      if (separation < 10 || separation > 50) continue;

      const priceTol = Math.abs(p1.value + p2.value) / 2 * 0.02;
      if (Math.abs(p1.value - p2.value) > priceTol) continue;

      // Find swing high between the two lows (neckline)
      const necklineHigh = pivots.highs.find(
        h => h.index > p1.index && h.index < p2.index
      );
      if (!necklineHigh) continue;

      const neckline = necklineHigh.value;

      // Determine stage
      let stage = 'forming';
      if (p2.index >= candles.length - 10) {
        stage = 'forming'; // 2nd pivot recently detected
      }
      if (lastCandle.c > neckline * 0.99 && lastCandle.c < neckline * 1.01) {
        stage = 'confirmed'; // Near neckline
      }
      if (lastCandle.c > neckline) {
        stage = volRatio > 1.3 ? 'breakout' : 'confirmed';
      }

      const baseWinRate = 0.79;
      const score = scorePattern(baseWinRate, tf, volRatio, stage, 'bullish', 'reversal', regime);

      results.push({
        name: 'Double Bottom',
        type: 'reversal',
        direction: 'bullish',
        baseWinRate,
        stage,
        score,
        volumeRatio: Math.round(volRatio * 100) / 100,
        expiresInBars: SIGNAL_DECAY[tf] || 10,
        description: `Double Bottom — lows at bars ${p1.index} & ${p2.index}, neckline at ${neckline.toFixed(2)}`
      });
      break; // Take first valid double bottom
    }
    if (results.some(r => r.name === 'Double Bottom')) break;
  }

  // Double Top: two swing highs within 2% tolerance
  for (let i = 0; i < pivots.highs.length - 1; i++) {
    for (let j = i + 1; j < pivots.highs.length; j++) {
      const p1 = pivots.highs[i];
      const p2 = pivots.highs[j];
      const separation = p2.index - p1.index;

      if (separation < 10 || separation > 50) continue;

      const priceTol = Math.abs(p1.value + p2.value) / 2 * 0.02;
      if (Math.abs(p1.value - p2.value) > priceTol) continue;

      // Find swing low between the two highs (neckline)
      const necklineLow = pivots.lows.find(
        l => l.index > p1.index && l.index < p2.index
      );
      if (!necklineLow) continue;

      const neckline = necklineLow.value;

      // Determine stage
      let stage = 'forming';
      if (p2.index >= candles.length - 10) {
        stage = 'forming';
      }
      if (lastCandle.c < neckline * 1.01 && lastCandle.c > neckline * 0.99) {
        stage = 'confirmed';
      }
      if (lastCandle.c < neckline) {
        stage = volRatio > 1.3 ? 'breakout' : 'confirmed';
      }

      const baseWinRate = 0.73;
      const score = scorePattern(baseWinRate, tf, volRatio, stage, 'bearish', 'reversal', regime);

      results.push({
        name: 'Double Top',
        type: 'reversal',
        direction: 'bearish',
        baseWinRate,
        stage,
        score,
        volumeRatio: Math.round(volRatio * 100) / 100,
        expiresInBars: SIGNAL_DECAY[tf] || 10,
        description: `Double Top — highs at bars ${p1.index} & ${p2.index}, neckline at ${neckline.toFixed(2)}`
      });
      break;
    }
    if (results.some(r => r.name === 'Double Top')) break;
  }

  return results;
}

/**
 * 5. MACD State Machine
 */
function detectMACDPatterns(candles, tf, regime) {
  const results = [];
  if (candles.length < 35) return results; // Need enough data for MACD(12,26,9)

  const { macd, signal, histogram } = computeMACD(candles);
  const avgVol = avgVolume(candles, 20);
  const lastCandle = candles[candles.length - 1];
  const volRatio = avgVol > 0 ? (lastCandle.v || 0) / avgVol : 1;
  const len = candles.length;

  // Signal line crossover detection (last 3 candles)
  if (macd[len - 1] !== null && signal[len - 1] !== null &&
      macd[len - 2] !== null && signal[len - 2] !== null) {

    const prevDiff = macd[len - 2] - signal[len - 2];
    const currDiff = macd[len - 1] - signal[len - 1];

    // Bullish cross: MACD crosses above signal
    if (prevDiff <= 0 && currDiff > 0) {
      const baseWinRate = 0.35;
      const score = scorePattern(baseWinRate, tf, volRatio, 'confirmed', 'bullish', 'continuation', regime);
      results.push({
        name: 'MACD Bullish Cross',
        type: 'continuation',
        direction: 'bullish',
        baseWinRate,
        stage: 'confirmed',
        score,
        volumeRatio: Math.round(volRatio * 100) / 100,
        expiresInBars: SIGNAL_DECAY[tf] || 10,
        description: 'MACD crossed above signal line'
      });
    }

    // Bearish cross: MACD crosses below signal
    if (prevDiff >= 0 && currDiff < 0) {
      const baseWinRate = 0.35;
      const score = scorePattern(baseWinRate, tf, volRatio, 'confirmed', 'bearish', 'continuation', regime);
      results.push({
        name: 'MACD Bearish Cross',
        type: 'continuation',
        direction: 'bearish',
        baseWinRate,
        stage: 'confirmed',
        score,
        volumeRatio: Math.round(volRatio * 100) / 100,
        expiresInBars: SIGNAL_DECAY[tf] || 10,
        description: 'MACD crossed below signal line'
      });
    }
  }

  // Histogram divergence: price makes lower low but histogram makes higher low (bullish)
  // or price makes higher high but histogram makes lower high (bearish)
  const pivots = swingPivots(candles, 5);
  const histValues = histogram;

  // Bullish histogram divergence
  if (pivots.lows.length >= 2) {
    const recentLows = pivots.lows.slice(-2);
    const [low1, low2] = recentLows;
    if (low2.index - low1.index >= 10 && low2.index - low1.index <= 30) {
      // Price lower low, histogram higher low
      if (low2.value < low1.value &&
          histValues[low2.index] !== null && histValues[low1.index] !== null &&
          histValues[low2.index] > histValues[low1.index]) {
        const baseWinRate = 0.60;
        const score = scorePattern(baseWinRate, tf, volRatio, 'confirmed', 'bullish', 'reversal', regime);
        results.push({
          name: 'MACD Bullish Divergence',
          type: 'reversal',
          direction: 'bullish',
          baseWinRate,
          stage: 'confirmed',
          score,
          volumeRatio: Math.round(volRatio * 100) / 100,
          expiresInBars: SIGNAL_DECAY[tf] || 10,
          description: `Price lower low but MACD histogram higher low — bars ${low1.index} to ${low2.index}`
        });
      }
    }
  }

  // Bearish histogram divergence
  if (pivots.highs.length >= 2) {
    const recentHighs = pivots.highs.slice(-2);
    const [high1, high2] = recentHighs;
    if (high2.index - high1.index >= 10 && high2.index - high1.index <= 30) {
      if (high2.value > high1.value &&
          histValues[high2.index] !== null && histValues[high1.index] !== null &&
          histValues[high2.index] < histValues[high1.index]) {
        const baseWinRate = 0.60;
        const score = scorePattern(baseWinRate, tf, volRatio, 'confirmed', 'bearish', 'reversal', regime);
        results.push({
          name: 'MACD Bearish Divergence',
          type: 'reversal',
          direction: 'bearish',
          baseWinRate,
          stage: 'confirmed',
          score,
          volumeRatio: Math.round(volRatio * 100) / 100,
          expiresInBars: SIGNAL_DECAY[tf] || 10,
          description: `Price higher high but MACD histogram lower high — bars ${high1.index} to ${high2.index}`
        });
      }
    }
  }

  return results;
}

/**
 * 6. RSI Divergence
 */
function detectRSIDivergence(candles, tf, regime) {
  const results = [];
  if (candles.length < 30) return results;

  const rsi = computeRSI(candles, 14);
  const pivots = swingPivots(candles, 5);
  const avgVol = avgVolume(candles, 20);
  const lastCandle = candles[candles.length - 1];
  const volRatio = avgVol > 0 ? (lastCandle.v || 0) / avgVol : 1;

  // Bullish divergence: price lower low, RSI higher low
  if (pivots.lows.length >= 2) {
    for (let i = pivots.lows.length - 2; i >= 0; i--) {
      const low1 = pivots.lows[i];
      const low2 = pivots.lows[pivots.lows.length - 1];
      const gap = low2.index - low1.index;

      if (gap < 10 || gap > 30) continue;
      if (rsi[low1.index] === null || rsi[low2.index] === null) continue;

      // Price lower low, RSI higher low
      if (low2.value < low1.value && rsi[low2.index] > rsi[low1.index]) {
        const baseWinRate = 0.65;
        const stage = low2.index >= candles.length - 7 ? 'confirmed' : 'developing';
        const score = scorePattern(baseWinRate, tf, volRatio, stage, 'bullish', 'reversal', regime);

        results.push({
          name: 'RSI Bullish Divergence',
          type: 'reversal',
          direction: 'bullish',
          baseWinRate,
          stage,
          score,
          volumeRatio: Math.round(volRatio * 100) / 100,
          expiresInBars: SIGNAL_DECAY[tf] || 10,
          description: `Price lower low, RSI higher low — RSI ${rsi[low1.index].toFixed(1)} -> ${rsi[low2.index].toFixed(1)}`
        });
        break;
      }
    }
  }

  // Bearish divergence: price higher high, RSI lower high
  if (pivots.highs.length >= 2) {
    for (let i = pivots.highs.length - 2; i >= 0; i--) {
      const high1 = pivots.highs[i];
      const high2 = pivots.highs[pivots.highs.length - 1];
      const gap = high2.index - high1.index;

      if (gap < 10 || gap > 30) continue;
      if (rsi[high1.index] === null || rsi[high2.index] === null) continue;

      // Price higher high, RSI lower high
      if (high2.value > high1.value && rsi[high2.index] < rsi[high1.index]) {
        const baseWinRate = 0.65;
        const stage = high2.index >= candles.length - 7 ? 'confirmed' : 'developing';
        const score = scorePattern(baseWinRate, tf, volRatio, stage, 'bearish', 'reversal', regime);

        results.push({
          name: 'RSI Bearish Divergence',
          type: 'reversal',
          direction: 'bearish',
          baseWinRate,
          stage,
          score,
          volumeRatio: Math.round(volRatio * 100) / 100,
          expiresInBars: SIGNAL_DECAY[tf] || 10,
          description: `Price higher high, RSI lower high — RSI ${rsi[high1.index].toFixed(1)} -> ${rsi[high2.index].toFixed(1)}`
        });
        break;
      }
    }
  }

  return results;
}

/**
 * 7. Support/Resistance Breakout
 */
function detectSRBreakout(candles, tf, regime) {
  const results = [];
  if (candles.length < 30) return results;

  const pivots = swingPivots(candles, 5);
  const allPivotValues = [
    ...pivots.highs.map(p => ({ value: p.value, index: p.index })),
    ...pivots.lows.map(p => ({ value: p.value, index: p.index }))
  ];

  if (allPivotValues.length < 3) return results;

  const avgVol = avgVolume(candles, 20);
  const lastCandle = candles[candles.length - 1];
  const volRatio = avgVol > 0 ? (lastCandle.v || 0) / avgVol : 1;
  const avgPrice = lastCandle.c;

  // Cluster pivots within 0.5% to find SR levels
  const tolerance = avgPrice * 0.005;
  const levels = [];
  const used = new Set();

  // Sort pivots by value
  const sorted = allPivotValues.slice().sort((a, b) => a.value - b.value);

  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    const cluster = [sorted[i]];
    used.add(i);

    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      if (Math.abs(sorted[j].value - sorted[i].value) <= tolerance) {
        cluster.push(sorted[j]);
        used.add(j);
      }
    }

    if (cluster.length >= 3) {
      const levelPrice = cluster.reduce((s, p) => s + p.value, 0) / cluster.length;
      const lastTouch = Math.max(...cluster.map(p => p.index));
      levels.push({ price: levelPrice, touches: cluster.length, lastTouch });
    }
  }

  if (levels.length === 0) return results;

  // Check for breakouts of strong levels
  for (const level of levels) {
    const isAbove = lastCandle.c > level.price;
    const isBelow = lastCandle.c < level.price;
    const distance = Math.abs(lastCandle.c - level.price) / level.price;

    // Breakout: close beyond level with volume
    if (distance > 0.002 && distance < 0.03) {
      // Check if price was on the other side recently
      const recentCandles = candles.slice(-10);
      const wasOnOtherSide = isAbove
        ? recentCandles.some(c => c.c < level.price)
        : recentCandles.some(c => c.c > level.price);

      if (!wasOnOtherSide) continue;

      const isBreakoutVol = volRatio > 1.3;
      const direction = isAbove ? 'bullish' : 'bearish';

      // Check for retest: price broke level, pulled back, and is now holding
      let stage = 'breakout';
      let baseWinRate = 0.52;

      // Retest detection: did price come back to level and bounce?
      const prevCandles = candles.slice(-5, -1);
      const retested = prevCandles.some(c =>
        Math.abs(c.l - level.price) / level.price < 0.005 ||
        Math.abs(c.h - level.price) / level.price < 0.005
      );
      if (retested && isBreakoutVol) {
        stage = 'retest';
        baseWinRate = 0.66;
      } else if (!isBreakoutVol) {
        stage = 'confirmed';
      }

      const score = scorePattern(baseWinRate, tf, volRatio, stage, direction, 'continuation', regime);

      results.push({
        name: `S/R ${stage === 'retest' ? 'Retest' : 'Breakout'} (${level.touches} touches)`,
        type: 'continuation',
        direction,
        baseWinRate,
        stage,
        score,
        volumeRatio: Math.round(volRatio * 100) / 100,
        expiresInBars: SIGNAL_DECAY[tf] || 10,
        description: `${direction === 'bullish' ? 'Resistance' : 'Support'} ${stage} at ${level.price.toFixed(2)} — ${level.touches} touches`
      });
    }
  }

  return results;
}


// ─── MAIN ENTRY POINT ────────────────────────────────────────────────────────

/**
 * Detect chart patterns from OHLCV candle data and return scored results.
 *
 * @param {Array<{o:number, h:number, l:number, c:number, v:number}>} candles - Oldest first
 * @param {string} tf - Timeframe ('5m', '15m', '30m', '1h', '4h', '1D')
 * @param {string} regime - Market regime ('bull', 'bear', 'ranging', 'volatile')
 * @returns {{ patterns, compositeScore, probabilityAdj, patternSummary }}
 */
function detectPatterns(candles, tf, regime) {
  const empty = {
    patterns: [],
    compositeScore: 0,
    probabilityAdj: 0,
    patternSummary: 'Insufficient data'
  };

  // Graceful early exit
  if (!candles || candles.length < 30) return empty;

  // Run all 7 detectors
  const allPatterns = [
    ...detectFlags(candles, tf, regime),
    ...detectWedges(candles, tf, regime),
    ...detectTriangles(candles, tf, regime),
    ...detectDoubles(candles, tf, regime),
    ...detectMACDPatterns(candles, tf, regime),
    ...detectRSIDivergence(candles, tf, regime),
    ...detectSRBreakout(candles, tf, regime)
  ];

  if (allPatterns.length === 0) {
    return {
      patterns: [],
      compositeScore: 0,
      probabilityAdj: 0,
      patternSummary: 'No patterns detected'
    };
  }

  // Sort by score descending
  allPatterns.sort((a, b) => b.score - a.score);

  // Multi-pattern confluence with diminishing returns
  const diminishingFactors = [1.0, 0.67, 0.50, 0.40, 0.33, 0.28, 0.25];
  let compositeScore = 0;
  for (let i = 0; i < allPatterns.length; i++) {
    const factor = i < diminishingFactors.length ? diminishingFactors[i] : 0.20;
    compositeScore += allPatterns[i].score * factor;
  }
  compositeScore = Math.round(compositeScore * 10000) / 10000;

  // Probability adjustment: normalized → tanh compressed → capped ±15%
  const normalized = (compositeScore - 0.50) / 0.50;
  const compressed = Math.tanh(normalized * 1.5);
  let probabilityAdj = Math.round(compressed * 15 * 100) / 100;
  probabilityAdj = Math.max(-15, Math.min(15, probabilityAdj));

  // Build summary string
  const topPatterns = allPatterns.slice(0, 3).map(p =>
    `${p.name} (${p.stage}, ${p.score.toFixed(3)})`
  );
  const patternSummary = `${allPatterns.length} pattern(s): ${topPatterns.join(', ')}`;

  return {
    patterns: allPatterns,
    compositeScore,
    probabilityAdj,
    patternSummary
  };
}


module.exports = { detectPatterns };
