// predictionDataPipeline.js — Real-time data ingestion for Jupiter Prediction Market AI
// Connects to Binance futures WebSocket + REST APIs, computes 27 features per asset

const WebSocket = require('ws');
const fetch = require('node-fetch');
const { sma, ema, rsi, stdev, atr } = require('./indicators');

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
const WS_BASE = 'wss://fstream.binance.com/stream?streams=';
const MAX_CANDLES_1M = 300;
const MAX_TRADES = 500;
const API_POLL_INTERVAL = 30000; // 30 seconds
const LOG_INTERVAL = 60000; // 60 seconds
const MIN_CANDLES_READY = 60;

class PredictionDataPipeline {
  constructor() {
    this.data = {};
    this.ws = null;
    this.running = false;
    this.pollTimer = null;
    this.logTimer = null;
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 60000;

    // External data shared across assets
    this.fearGreed = { value: 50, previous: 50 };

    // Per-asset derivatives data
    this.derivativesData = {};

    for (const sym of SYMBOLS) {
      this.data[sym] = {
        candles1m: [],    // { t, o, h, l, c, v }
        candles5m: [],
        candles15m: [],
        orderbook: { bids: [], asks: [], ts: 0 },
        trades: [],       // { price, qty, isBuyerMaker, time }
        lastFeatures: {},
      };
      this.derivativesData[sym] = {
        fundingRate: 0,
        openInterest: 0,
        prevOpenInterest: 0,
        longShortRatio: 1,
      };
    }
  }

  // ──────────────────────────── Lifecycle ────────────────────────────

  start() {
    if (this.running) return;
    this.running = true;
    console.log('[PredictionPipeline] Starting data pipeline for:', SYMBOLS.join(', '));
    this._connectWebSocket();
    this._startPolling();
    this.logTimer = setInterval(() => this._logStatus(), LOG_INTERVAL);
  }

  stop() {
    this.running = false;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.logTimer) { clearInterval(this.logTimer); this.logTimer = null; }
    console.log('[PredictionPipeline] Stopped.');
  }

  // ──────────────────────────── WebSocket ────────────────────────────

  _buildStreams() {
    const streams = [];
    for (const sym of SYMBOLS) {
      const s = sym.toLowerCase();
      streams.push(`${s}@kline_1m`);
      streams.push(`${s}@depth20@100ms`);
      streams.push(`${s}@aggTrade`);
    }
    return streams.join('/');
  }

  _connectWebSocket() {
    if (!this.running) return;

    const url = WS_BASE + this._buildStreams();
    console.log('[PredictionPipeline] Connecting to Binance futures WS...');

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      console.error('[PredictionPipeline] WS creation error:', err.message);
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      console.log('[PredictionPipeline] WebSocket connected.');
      this.reconnectAttempts = 0;
    });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.stream && msg.data) {
          this._handleStreamMessage(msg.stream, msg.data);
        }
      } catch (err) {
        // ignore malformed messages
      }
    });

    this.ws.on('error', (err) => {
      console.error('[PredictionPipeline] WS error:', err.message);
    });

    this.ws.on('close', () => {
      console.warn('[PredictionPipeline] WebSocket disconnected.');
      this.ws = null;
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (!this.running) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;
    console.log(`[PredictionPipeline] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})...`);
    setTimeout(() => this._connectWebSocket(), delay);
  }

  // ──────────────────────────── Stream Handlers ────────────────────────────

  _handleStreamMessage(stream, data) {
    // stream format: "btcusdt@kline_1m", "btcusdt@depth20@100ms", "btcusdt@aggTrade"
    const parts = stream.split('@');
    const symLower = parts[0];
    const sym = symLower.toUpperCase();
    const type = parts[1];

    if (!this.data[sym]) return;

    if (type === 'kline_1m') {
      this._handleKline(sym, data);
    } else if (type === 'depth20') {
      this._handleDepth(sym, data);
    } else if (type === 'aggTrade') {
      this._handleAggTrade(sym, data);
    }
  }

  _handleKline(sym, data) {
    const k = data.k;
    if (!k) return;

    const candle = {
      t: k.t,
      o: parseFloat(k.o),
      h: parseFloat(k.h),
      l: parseFloat(k.l),
      c: parseFloat(k.c),
      v: parseFloat(k.v),
    };

    const candles = this.data[sym].candles1m;

    // Update or append
    if (candles.length > 0 && candles[candles.length - 1].t === candle.t) {
      candles[candles.length - 1] = candle;
    } else {
      candles.push(candle);
    }

    // Trim to max
    while (candles.length > MAX_CANDLES_1M) candles.shift();

    // Only resample and compute features on closed candles
    if (k.x) {
      this._resampleCandles(sym);
      this._computeFeatures(sym);
    }
  }

  _handleDepth(sym, data) {
    const bids = (data.b || []).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));
    const asks = (data.a || []).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));
    this.data[sym].orderbook = { bids, asks, ts: Date.now() };
  }

  _handleAggTrade(sym, data) {
    const trade = {
      price: parseFloat(data.p),
      qty: parseFloat(data.q),
      isBuyerMaker: data.m, // true = sell (maker is buyer), false = buy
      time: data.T,
    };

    this.data[sym].trades.push(trade);
    while (this.data[sym].trades.length > MAX_TRADES) {
      this.data[sym].trades.shift();
    }
  }

  // ──────────────────────────── Resampling ────────────────────────────

  _resampleCandles(sym) {
    this.data[sym].candles5m = this._resample(this.data[sym].candles1m, 5);
    this.data[sym].candles15m = this._resample(this.data[sym].candles1m, 15);
  }

  _resample(candles1m, minutes) {
    if (candles1m.length === 0) return [];
    const msPerBar = minutes * 60 * 1000;
    const result = [];
    let current = null;

    for (const c of candles1m) {
      const barStart = Math.floor(c.t / msPerBar) * msPerBar;

      if (!current || current.t !== barStart) {
        if (current) result.push(current);
        current = { t: barStart, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
      } else {
        current.h = Math.max(current.h, c.h);
        current.l = Math.min(current.l, c.l);
        current.c = c.c;
        current.v += c.v;
      }
    }
    if (current) result.push(current);
    return result;
  }

  // ──────────────────────────── REST Polling ────────────────────────────

  _startPolling() {
    this._pollAll(); // initial fetch
    this.pollTimer = setInterval(() => this._pollAll(), API_POLL_INTERVAL);
  }

  async _pollAll() {
    await Promise.allSettled([
      this._pollFearGreed(),
      ...SYMBOLS.map(sym => this._pollFundingRate(sym)),
      ...SYMBOLS.map(sym => this._pollOpenInterest(sym)),
      ...SYMBOLS.map(sym => this._pollLongShortRatio(sym)),
    ]);

    // Recompute features after new external data
    for (const sym of SYMBOLS) {
      this._computeFeatures(sym);
    }
  }

  async _pollFearGreed() {
    try {
      const res = await fetch('https://api.alternative.me/fng/?limit=2', { timeout: 10000 });
      const json = await res.json();
      if (json.data && json.data.length >= 2) {
        this.fearGreed = {
          value: parseInt(json.data[0].value, 10),
          previous: parseInt(json.data[1].value, 10),
        };
      }
    } catch (err) {
      // keep previous value on failure
    }
  }

  async _pollFundingRate(sym) {
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`, { timeout: 10000 });
      const json = await res.json();
      if (json.lastFundingRate !== undefined) {
        this.derivativesData[sym].fundingRate = parseFloat(json.lastFundingRate);
      }
    } catch (err) {
      // keep previous value
    }
  }

  async _pollOpenInterest(sym) {
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${sym}`, { timeout: 10000 });
      const json = await res.json();
      if (json.openInterest !== undefined) {
        const oi = parseFloat(json.openInterest);
        this.derivativesData[sym].prevOpenInterest = this.derivativesData[sym].openInterest || oi;
        this.derivativesData[sym].openInterest = oi;
      }
    } catch (err) {
      // keep previous value
    }
  }

  async _pollLongShortRatio(sym) {
    try {
      const res = await fetch(
        `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=5m&limit=2`,
        { timeout: 10000 }
      );
      const json = await res.json();
      if (Array.isArray(json) && json.length > 0) {
        this.derivativesData[sym].longShortRatio = parseFloat(json[0].longShortRatio || 1);
      }
    } catch (err) {
      // keep previous value
    }
  }

  // ──────────────────────────── Feature Computation ────────────────────────────

  _computeFeatures(sym) {
    const d = this.data[sym];
    const c1m = d.candles1m;
    const c5m = d.candles5m;
    const c15m = d.candles15m;

    if (c1m.length < 2) return;

    const features = {};

    // ── Price/Momentum (8) ──
    features.returns_1m = this._logReturn(c1m);
    features.returns_5m = this._logReturn(c5m);
    features.returns_15m = this._logReturn(c15m);
    features.rsi_7 = this._lastValid(rsi(c1m.map(c => c.c), 7));
    features.rsi_14 = this._lastValid(rsi(c5m.map(c => c.c), 14));
    features.macd_hist = this._computeMacdHist(c5m);
    features.bb_zscore = this._computeBBZScore(c5m);
    features.atr_ratio = this._computeAtrRatio(c5m);

    // ── Volume/Flow (5) ──
    features.volume_ratio = this._computeVolumeRatio(c5m);
    features.buy_sell_ratio = this._computeBuySellRatio(d.trades);
    features.cvd_slope = this._computeCvdSlope(d.trades);
    features.vwap_deviation = this._computeVwapDeviation(c1m);
    features.obv_slope = this._computeObvSlope(c5m);

    // ── Orderbook (6) ──
    const ob = d.orderbook;
    features.book_imbalance_1 = this._bookImbalance(ob, 1);
    features.book_imbalance_5 = this._bookImbalance(ob, 5);
    features.book_imbalance_10 = this._bookImbalance(ob, 10);
    features.spread_bps = this._computeSpread(ob);
    features.microprice_deviation = this._computeMicroprice(ob);
    features.depth_ratio = this._computeDepthRatio(ob);

    // ── Derivatives/Context (5) ──
    const deriv = this.derivativesData[sym];
    features.funding_rate = deriv.fundingRate || 0;
    features.oi_change_pct = deriv.prevOpenInterest > 0
      ? (deriv.openInterest - deriv.prevOpenInterest) / deriv.prevOpenInterest
      : 0;
    features.long_short_ratio = deriv.longShortRatio || 1;
    features.fear_greed = (this.fearGreed.value || 50) / 100;
    features.fear_greed_change = ((this.fearGreed.value || 50) - (this.fearGreed.previous || 50)) / 100;

    // ── Temporal (3) ──
    const now = new Date();
    const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
    features.hour_sin = Math.sin(2 * Math.PI * hour / 24);
    features.hour_cos = Math.cos(2 * Math.PI * hour / 24);
    features.session = this._getSession(now.getUTCHours());

    // Ensure no nulls/NaNs
    for (const key of Object.keys(features)) {
      if (features[key] === null || features[key] === undefined || Number.isNaN(features[key])) {
        features[key] = 0;
      }
    }

    d.lastFeatures = features;
  }

  // ── Price/Momentum helpers ──

  _logReturn(candles) {
    if (!candles || candles.length < 2) return 0;
    const prev = candles[candles.length - 2].c;
    const curr = candles[candles.length - 1].c;
    if (prev <= 0) return 0;
    return Math.log(curr / prev);
  }

  _lastValid(arr) {
    if (!arr || arr.length === 0) return 0;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] !== null && arr[i] !== undefined && !Number.isNaN(arr[i])) return arr[i];
    }
    return 0;
  }

  _computeMacdHist(candles) {
    if (!candles || candles.length < 26) return 0;
    const closes = candles.map(c => c.c);
    const fast = ema(closes, 12);
    const slow = ema(closes, 26);
    const macdLine = fast.map((v, i) => (v !== null && slow[i] !== null) ? v - slow[i] : null);
    const signalLine = ema(macdLine, 9);
    const last = macdLine.length - 1;
    if (macdLine[last] === null || signalLine[last] === null) return 0;
    return macdLine[last] - signalLine[last];
  }

  _computeBBZScore(candles) {
    if (!candles || candles.length < 20) return 0;
    const closes = candles.map(c => c.c);
    const mid = sma(closes, 20);
    const sd = stdev(closes, 20);
    const last = closes.length - 1;
    if (mid[last] === null || sd[last] === null || sd[last] === 0) return 0;
    return (closes[last] - mid[last]) / sd[last];
  }

  _computeAtrRatio(candles) {
    if (!candles || candles.length < 15) return 0;
    const highs = candles.map(c => c.h);
    const lows = candles.map(c => c.l);
    const closes = candles.map(c => c.c);
    const atrArr = atr(highs, lows, closes, 14);
    const last = atrArr.length - 1;
    if (atrArr[last] === null || closes[last] === 0) return 0;
    return atrArr[last] / closes[last];
  }

  // ── Volume/Flow helpers ──

  _computeVolumeRatio(candles) {
    if (!candles || candles.length < 21) return 1;
    const vols = candles.map(c => c.v);
    const avg20 = sma(vols, 20);
    const last = avg20.length - 1;
    if (avg20[last] === null || avg20[last] === 0) return 1;
    return vols[last] / avg20[last];
  }

  _computeBuySellRatio(trades) {
    if (!trades || trades.length === 0) return 0.5;
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const recent = trades.filter(t => t.time >= fiveMinAgo);
    if (recent.length === 0) return 0.5;

    let buyVol = 0, totalVol = 0;
    for (const t of recent) {
      const vol = t.price * t.qty;
      totalVol += vol;
      if (!t.isBuyerMaker) buyVol += vol; // taker buy
    }
    return totalVol === 0 ? 0.5 : buyVol / totalVol;
  }

  _computeCvdSlope(trades) {
    if (!trades || trades.length < 20) return 0;
    const len = trades.length;
    const recentStart = len - 10;
    const prevStart = len - 20;

    let cvdRecent = 0, cvdPrev = 0;
    for (let i = prevStart; i < recentStart; i++) {
      const t = trades[i];
      cvdPrev += t.isBuyerMaker ? -t.qty : t.qty;
    }
    for (let i = recentStart; i < len; i++) {
      const t = trades[i];
      cvdRecent += t.isBuyerMaker ? -t.qty : t.qty;
    }
    return cvdRecent - cvdPrev;
  }

  _computeVwapDeviation(candles) {
    if (!candles || candles.length < 1) return 0;
    // Compute VWAP over available candles (session-like, using all available 1m data)
    let cumPV = 0, cumV = 0;
    for (const c of candles) {
      const typical = (c.h + c.l + c.c) / 3;
      cumPV += typical * c.v;
      cumV += c.v;
    }
    if (cumV === 0) return 0;
    const vwap = cumPV / cumV;
    const price = candles[candles.length - 1].c;
    return (price - vwap) / price;
  }

  _computeObvSlope(candles) {
    if (!candles || candles.length < 6) return 0;
    // Compute OBV for last 6 candles, return slope over last 5
    const slice = candles.slice(-6);
    const obv = [0];
    for (let i = 1; i < slice.length; i++) {
      const dir = slice[i].c > slice[i - 1].c ? 1 : slice[i].c < slice[i - 1].c ? -1 : 0;
      obv.push(obv[i - 1] + dir * slice[i].v);
    }
    // Simple linear slope: (last - first) / count
    return (obv[obv.length - 1] - obv[0]) / (obv.length - 1);
  }

  // ── Orderbook helpers ──

  _bookImbalance(ob, levels) {
    if (!ob.bids.length || !ob.asks.length) return 0;
    const n = Math.min(levels, ob.bids.length, ob.asks.length);
    let bidQty = 0, askQty = 0;
    for (let i = 0; i < n; i++) {
      bidQty += ob.bids[i].qty;
      askQty += ob.asks[i].qty;
    }
    const total = bidQty + askQty;
    return total === 0 ? 0 : (bidQty - askQty) / total;
  }

  _computeSpread(ob) {
    if (!ob.bids.length || !ob.asks.length) return 0;
    const bestBid = ob.bids[0].price;
    const bestAsk = ob.asks[0].price;
    const mid = (bestBid + bestAsk) / 2;
    if (mid === 0) return 0;
    return (bestAsk - bestBid) / mid * 10000;
  }

  _computeMicroprice(ob) {
    if (!ob.bids.length || !ob.asks.length) return 0;
    const bidP = ob.bids[0].price;
    const bidQ = ob.bids[0].qty;
    const askP = ob.asks[0].price;
    const askQ = ob.asks[0].qty;
    const totalQ = bidQ + askQ;
    if (totalQ === 0) return 0;
    const microprice = (bidP * askQ + askP * bidQ) / totalQ;
    const mid = (bidP + askP) / 2;
    if (mid === 0) return 0;
    return (microprice - mid) / mid * 10000;
  }

  _computeDepthRatio(ob) {
    if (!ob.bids.length || !ob.asks.length) return 1;
    let bidDepth = 0, askDepth = 0;
    for (const b of ob.bids) bidDepth += b.qty;
    for (const a of ob.asks) askDepth += a.qty;
    return askDepth === 0 ? 1 : bidDepth / askDepth;
  }

  // ── Temporal helpers ──

  _getSession(utcHour) {
    // Asia: 00-08 UTC, Europe: 08-14 UTC, US: 14-24 UTC
    if (utcHour < 8) return 0;
    if (utcHour < 14) return 1;
    return 2;
  }

  // ──────────────────────────── Logging ────────────────────────────

  _logStatus() {
    for (const sym of SYMBOLS) {
      const d = this.data[sym];
      const featureCount = Object.keys(d.lastFeatures).length;
      const ready = this.isReady(sym);
      console.log(
        `[PredictionPipeline] ${sym}: ${d.candles1m.length} 1m candles, ` +
        `${d.candles5m.length} 5m, ${d.candles15m.length} 15m, ` +
        `${d.trades.length} trades, ${featureCount} features, ` +
        `ready=${ready}`
      );
      if (featureCount > 0) {
        const f = d.lastFeatures;
        console.log(
          `  RSI7=${(f.rsi_7 || 0).toFixed(1)} RSI14=${(f.rsi_14 || 0).toFixed(1)} ` +
          `MACD=${(f.macd_hist || 0).toFixed(4)} BB_Z=${(f.bb_zscore || 0).toFixed(2)} ` +
          `BookImb5=${(f.book_imbalance_5 || 0).toFixed(3)} BSR=${(f.buy_sell_ratio || 0).toFixed(3)} ` +
          `FNG=${(f.fear_greed || 0).toFixed(2)} FR=${(f.funding_rate || 0).toFixed(6)}`
        );
      }
    }
  }

  // ──────────────────────────── Public API ────────────────────────────

  getFeatures(asset) {
    const sym = asset.toUpperCase();
    if (!this.data[sym]) return {};
    return { ...this.data[sym].lastFeatures };
  }

  getCandles(asset, tf) {
    const sym = asset.toUpperCase();
    if (!this.data[sym]) return [];
    switch (tf) {
      case '1m': return [...this.data[sym].candles1m];
      case '5m': return [...this.data[sym].candles5m];
      case '15m': return [...this.data[sym].candles15m];
      default: return [];
    }
  }

  getOrderbook(asset) {
    const sym = asset.toUpperCase();
    if (!this.data[sym]) return { bids: [], asks: [], ts: 0 };
    const ob = this.data[sym].orderbook;
    return {
      bids: [...ob.bids],
      asks: [...ob.asks],
      ts: ob.ts,
    };
  }

  isReady(asset) {
    const sym = asset.toUpperCase();
    if (!this.data[sym]) return false;
    return this.data[sym].candles1m.length >= MIN_CANDLES_READY;
  }
}

module.exports = new PredictionDataPipeline();
