// Pure math indicator functions — ported from frontend index.html lines 3019-3098

function sma(arr, len) {
  const r = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < len - 1) { r.push(null); continue; }
    let s = 0;
    for (let j = i - len + 1; j <= i; j++) s += arr[j];
    r.push(s / len);
  }
  return r;
}

function ema(arr, len) {
  const r = [];
  const k = 2 / (len + 1);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === null || arr[i] === undefined) { r.push(null); continue; }
    if (prev === null) { prev = arr[i]; r.push(prev); continue; }
    prev = arr[i] * k + prev * (1 - k);
    r.push(prev);
  }
  return r;
}

function rsi(closes, len) {
  const r = new Array(closes.length).fill(null);
  if (closes.length < len + 1) return r;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= len; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= len; avgLoss /= len;
  r[len] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (len - 1) + (d > 0 ? d : 0)) / len;
    avgLoss = (avgLoss * (len - 1) + (d < 0 ? -d : 0)) / len;
    r[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return r;
}

function stdev(arr, len) {
  const r = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < len - 1 || arr[i] === null) { r.push(null); continue; }
    let s = 0, s2 = 0, c = 0;
    for (let j = i - len + 1; j <= i; j++) {
      if (arr[j] !== null) { s += arr[j]; s2 += arr[j] * arr[j]; c++; }
    }
    if (c < 2) { r.push(null); continue; }
    const mean = s / c;
    r.push(Math.sqrt(s2 / c - mean * mean));
  }
  return r;
}

function atr(highs, lows, closes, len) {
  const tr = [0];
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  return ema(tr, len);
}

// Signal builders — return arrays of 1 (long), -1 (short), 0 (neutral)
function rsiSignal(closes, params) {
  const { len = 14, buyLevel = 30, sellLevel = 70 } = params;
  const r = rsi(closes, len);
  return r.map(v => v === null ? 0 : v < buyLevel ? 1 : v > sellLevel ? -1 : 0);
}

function emaSignal(closes, params) {
  const { fast = 12, slow = 26 } = params;
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  return f.map((v, i) => v === null || s[i] === null ? 0 : v > s[i] ? 1 : v < s[i] ? -1 : 0);
}

function macdSignal(closes, params) {
  const { fast = 12, slow = 26, signal = 9 } = params;
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const macdLine = f.map((v, i) => v === null || s[i] === null ? null : v - s[i]);
  const sigLine = ema(macdLine, signal);
  return macdLine.map((v, i) => v === null || sigLine[i] === null ? 0 : v > sigLine[i] ? 1 : v < sigLine[i] ? -1 : 0);
}

function bbSignal(closes, params) {
  const { len = 20, mult = 2 } = params;
  const mid = sma(closes, len);
  const sd = stdev(closes, len);
  return closes.map((c, i) => {
    if (mid[i] === null || sd[i] === null) return 0;
    const upper = mid[i] + mult * sd[i];
    const lower = mid[i] - mult * sd[i];
    return c < lower ? 1 : c > upper ? -1 : 0;
  });
}

function supertrendSignal(highs, lows, closes, params) {
  const { len = 10, mult = 3 } = params;
  const atrArr = atr(highs, lows, closes, len);
  const signals = new Array(closes.length).fill(0);
  let dir = 1, upperBand = 0, lowerBand = 0;
  for (let i = 1; i < closes.length; i++) {
    if (atrArr[i] === null) continue;
    const mid = (highs[i] + lows[i]) / 2;
    const newUpper = mid + mult * atrArr[i];
    const newLower = mid - mult * atrArr[i];
    upperBand = newUpper < upperBand || closes[i - 1] > upperBand ? newUpper : upperBand;
    lowerBand = newLower > lowerBand || closes[i - 1] < lowerBand ? newLower : lowerBand;
    if (dir === 1 && closes[i] < lowerBand) dir = -1;
    else if (dir === -1 && closes[i] > upperBand) dir = 1;
    signals[i] = dir;
  }
  return signals;
}

function adxSignal(highs, lows, closes, params) {
  const { len = 14, threshold = 25 } = params;
  const signals = new Array(closes.length).fill(0);
  if (closes.length < len * 2) return signals;
  const plusDM = [], minusDM = [], trArr = [];
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { plusDM.push(0); minusDM.push(0); trArr.push(0); continue; }
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    trArr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  const smoothPDM = ema(plusDM, len);
  const smoothNDM = ema(minusDM, len);
  const smoothTR = ema(trArr, len);
  for (let i = 0; i < closes.length; i++) {
    if (smoothTR[i] === null || smoothTR[i] === 0) continue;
    const pdi = 100 * smoothPDM[i] / smoothTR[i];
    const ndi = 100 * smoothNDM[i] / smoothTR[i];
    const dx = pdi + ndi === 0 ? 0 : 100 * Math.abs(pdi - ndi) / (pdi + ndi);
    if (dx > threshold) {
      signals[i] = pdi > ndi ? 1 : -1;
    }
  }
  return signals;
}

// Map indicator ID to signal function
function computeSignal(indicatorId, candles, params) {
  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const volumes = candles.map(c => c.v);

  switch (indicatorId) {
    case 'RSI': return rsiSignal(closes, params);
    case 'EMA': return emaSignal(closes, params);
    case 'MACD': return macdSignal(closes, params);
    case 'BB': return bbSignal(closes, params);
    case 'Supertrend': return supertrendSignal(highs, lows, closes, params);
    case 'ADX': return adxSignal(highs, lows, closes, params);
    default: return new Array(closes.length).fill(0);
  }
}

module.exports = { sma, ema, rsi, stdev, atr, computeSignal };
