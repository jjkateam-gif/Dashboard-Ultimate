/**
 * predictionScorer.js — AI Scoring Engine for Jupiter Prediction Markets
 *
 * V1.1: Weighted Feature Ensemble (Rule-Based)
 *
 * Takes real-time features from predictionDataPipeline.js and produces
 * a calibrated probability estimate P(UP) for each asset/timeframe.
 *
 * Architecture:
 *   1. Feature Scoring: each feature → directional signal [-1, +1]
 *   2. Weighted Aggregation: empirical weights (orderbook > momentum > volume > derivatives > temporal)
 *   3. Probability Mapping: aggregate score → calibrated probability via sigmoid
 *   4. Confidence Assessment: feature agreement + data quality
 *   5. Edge Detection: our probability vs Jupiter market price
 *   6. Kelly Sizing: quarter-Kelly with graduated drawdown tiers + category adjustment
 *   7. Quality Filters: reject low-confidence / low-edge / choppy regime / stale data signals
 *
 * V1.1 Changes:
 *   - Removed fear_greed, fear_greed_change, obv_slope, atr_ratio (zero intraday signal / redundant)
 *   - Added ofi_cumulative (Order Flow Imbalance) as highest-weight single feature
 *   - Reallocated weights to orderbook/volume features
 *   - Adversarial edge cap (>15% = likely stale data)
 *   - Spread filter tightened from 50 bps to 10 bps
 *   - Session-aware edge thresholds (US/EU/ASIA + weekend adjustment)
 *   - Market regime gate (reject choppy markets)
 *   - Graduated drawdown tiers (5/10/15/20%)
 *   - Dynamic Kelly adjustment by dominant feature category
 *   - Lag volume modifier (use previous bar's volume ratio)
 *   - Trade cooldown support (skip 3 market cycles)
 */

const MODEL_VERSION = '1.1.0';
const MODEL_UPDATED = '2026-03-15';
const ESTIMATED_FEE_PCT = 0.015; // ~1.5% round-trip fees on Jupiter prediction markets

// ─── Feature Weight Configuration ────────────────────────────────────────────

const FEATURE_WEIGHTS = {
  // PRICE / MOMENTUM — total: 0.21
  returns_1m:   0.04,
  returns_5m:   0.04,
  returns_15m:  0.03,
  rsi_7:        0.03,
  rsi_14:       0.03,
  macd_hist:    0.03,
  bb_zscore:    0.01,
  // atr_ratio removed (non-directional, tiny weight)

  // VOLUME / FLOW — total: 0.20
  volume_ratio:     0.03,
  buy_sell_ratio:   0.07,   // was 0.06
  cvd_slope:        0.06,   // was 0.05
  vwap_deviation:   0.04,
  // obv_slope removed (redundant with cvd_slope)

  // ORDERBOOK — total: 0.38 (highest weight, most predictive at short timeframes)
  ofi_cumulative:      0.09,  // NEW: Order Flow Imbalance (highest single feature)
  book_imbalance_1:    0.09,  // was 0.08
  book_imbalance_5:    0.07,
  book_imbalance_10:   0.03,
  spread_bps:          0.02,
  microprice_deviation: 0.07, // was 0.06
  depth_ratio:         0.02,
  // Removed: fear_greed, fear_greed_change (daily update = no intraday signal)

  // DERIVATIVES — total: 0.11
  funding_rate:      0.04,
  oi_change_pct:     0.03,
  long_short_ratio:  0.04,
  // fear_greed removed (daily update frequency, zero intraday signal)
  // fear_greed_change removed (daily update frequency, zero intraday signal)

  // TEMPORAL — total: 0.10 (affects confidence, not direction)
  session_weight: 0.05,
  hour_weight:    0.05,
};

const FEATURE_CATEGORIES = {
  momentum:    ['returns_1m', 'returns_5m', 'returns_15m', 'rsi_7', 'rsi_14', 'macd_hist', 'bb_zscore'],
  volume:      ['volume_ratio', 'buy_sell_ratio', 'cvd_slope', 'vwap_deviation'],
  orderbook:   ['ofi_cumulative', 'book_imbalance_1', 'book_imbalance_5', 'book_imbalance_10', 'spread_bps', 'microprice_deviation', 'depth_ratio'],
  derivatives: ['funding_rate', 'oi_change_pct', 'long_short_ratio'],
  temporal:    ['session_weight', 'hour_weight'],
};

// ─── Utility Functions ───────────────────────────────────────────────────────

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeNum(val, fallback = 0) {
  if (val === null || val === undefined || isNaN(val)) return fallback;
  return Number(val);
}

// ─── Feature Signal Extraction ───────────────────────────────────────────────

/**
 * Convert a raw feature value into a directional signal between -1 and +1.
 * Positive = bullish, Negative = bearish, 0 = neutral.
 *
 * Some features are "modifiers" — they don't contribute direction but affect
 * confidence or amplify other signals.
 */
function computeFeatureSignal(featureName, features) {
  const v = safeNum(features[featureName]);

  switch (featureName) {
    // ── PRICE / MOMENTUM ──
    case 'returns_1m':
      return clamp(v / 0.002, -1, 1);  // +-0.2% saturates

    case 'returns_5m':
      return clamp(v / 0.005, -1, 1);

    case 'returns_15m':
      return clamp(v / 0.01, -1, 1);

    case 'rsi_7':
      // Mean-reversion: oversold (low RSI) = bullish, overbought = bearish
      return clamp(-(v - 50) / 50, -1, 1);

    case 'rsi_14':
      return clamp(-(v - 50) / 50, -1, 1);

    case 'macd_hist': {
      const atr = safeNum(features.atr_value, 1);
      if (atr === 0) return 0;
      return clamp(v / atr, -1, 1);  // normalize by volatility
    }

    case 'bb_zscore':
      // Mean reversion: price above upper band = bearish
      return clamp(-v / 2, -1, 1);

    // ── VOLUME / FLOW ──
    case 'volume_ratio':
      // Modifier: amplifies other signals when volume is high.
      // Returns 0 as direct signal — applied as a multiplier elsewhere.
      return 0;

    case 'buy_sell_ratio':
      // >0.5 = more buying, <0.5 = more selling
      return clamp((v - 0.5) * 2, -1, 1);

    case 'cvd_slope':
      return clamp(v, -1, 1);

    case 'vwap_deviation':
      // Mean reversion toward VWAP
      return clamp(-v / 0.002, -1, 1);

    // ── ORDERBOOK ──
    case 'ofi_cumulative':
      // Positive OFI = bid being built / ask being consumed = bullish
      // Normalize by a reasonable threshold
      return clamp(v / 50, -1, 1);

    case 'book_imbalance_1':
      return clamp(v * 2, -1, 1);

    case 'book_imbalance_5':
      return clamp(v * 2, -1, 1);

    case 'book_imbalance_10':
      return clamp(v * 2, -1, 1);

    case 'spread_bps':
      // Modifier: wide spread = lower confidence, not directional
      return 0;

    case 'microprice_deviation':
      // Positive deviation = microprice above midprice = bullish
      return clamp(v / 5, -1, 1);

    case 'depth_ratio':
      // >1 = more bid depth = bullish support
      return clamp((v - 1) * 2, -1, 1);

    // ── DERIVATIVES ──
    case 'funding_rate':
      // Contrarian: high positive funding = too many longs → bearish
      return clamp(-v / 0.0003, -1, 1);

    case 'oi_change_pct': {
      // OI change combined with price direction:
      // Rising OI + rising price = bullish continuation
      // Rising OI + falling price = bearish continuation
      const priceDir = Math.sign(safeNum(features.returns_5m));
      if (priceDir === 0) return 0;
      return clamp(v * priceDir / 0.02, -1, 1);
    }

    case 'long_short_ratio':
      // Contrarian: too many longs (ratio > 1) → bearish
      return clamp(-(v - 1) * 2, -1, 1);

    // ── TEMPORAL ──
    case 'session_weight':
    case 'hour_weight':
      // Temporal features affect confidence only, not direction
      return 0;

    default:
      return 0;
  }
}

// ─── Reason Generation ───────────────────────────────────────────────────────

function generateReason(featureName, signal, value) {
  const dir = signal > 0 ? 'bullish' : 'bearish';
  const strength = Math.abs(signal) > 0.7 ? 'Strong' : Math.abs(signal) > 0.4 ? 'Moderate' : 'Weak';

  switch (featureName) {
    case 'returns_1m':
      return `${strength} 1m momentum (${(value * 100).toFixed(3)}%) favoring ${signal > 0 ? 'UP' : 'DOWN'}`;
    case 'returns_5m':
      return `${strength} 5m price change (${(value * 100).toFixed(3)}%) is ${dir}`;
    case 'returns_15m':
      return `${strength} 15m trend (${(value * 100).toFixed(3)}%) is ${dir}`;
    case 'rsi_7':
      return value < 35 ? `RSI(7) oversold at ${value.toFixed(1)} — ${dir}` :
             value > 65 ? `RSI(7) overbought at ${value.toFixed(1)} — ${dir}` :
             `RSI(7) neutral at ${value.toFixed(1)}`;
    case 'rsi_14':
      return value < 35 ? `RSI(14) oversold at ${value.toFixed(1)} — ${dir}` :
             value > 65 ? `RSI(14) overbought at ${value.toFixed(1)} — ${dir}` :
             `RSI(14) neutral at ${value.toFixed(1)}`;
    case 'macd_hist':
      return `MACD histogram ${dir} (normalized signal: ${signal.toFixed(2)})`;
    case 'bb_zscore':
      return Math.abs(value) > 1.5 ? `Price ${value > 0 ? 'above' : 'below'} Bollinger Band — ${dir} mean-reversion` :
             `Price within Bollinger Bands`;
    case 'buy_sell_ratio':
      return `Buy/sell ratio ${value.toFixed(2)} — ${strength.toLowerCase()} ${dir} flow`;
    case 'cvd_slope':
      return `CVD trending ${signal > 0 ? 'positive' : 'negative'} — ${dir}`;
    case 'vwap_deviation':
      return `Price ${value > 0 ? 'above' : 'below'} VWAP by ${(Math.abs(value) * 100).toFixed(3)}% — ${dir} reversion`;
    case 'ofi_cumulative':
      return `${strength} order flow imbalance (OFI: ${value.toFixed(1)}) — ${dir} book pressure`;
    case 'book_imbalance_1':
      return `${strength} top-of-book imbalance (${value.toFixed(3)}) favoring ${signal > 0 ? 'buyers' : 'sellers'}`;
    case 'book_imbalance_5':
      return `${strength} 5-level book imbalance (${value.toFixed(3)}) favoring ${signal > 0 ? 'buyers' : 'sellers'}`;
    case 'book_imbalance_10':
      return `10-level book imbalance (${value.toFixed(3)}) favoring ${signal > 0 ? 'buyers' : 'sellers'}`;
    case 'microprice_deviation':
      return `Microprice ${value > 0 ? 'above' : 'below'} midprice by ${Math.abs(value).toFixed(1)} bps — ${dir}`;
    case 'depth_ratio':
      return `Bid/ask depth ratio ${value.toFixed(2)} — ${signal > 0 ? 'stronger bid support' : 'stronger ask pressure'}`;
    case 'funding_rate':
      return `Funding rate ${value > 0 ? 'positive' : 'negative'} (${(value * 100).toFixed(4)}%) — contrarian ${dir}`;
    case 'oi_change_pct':
      return `Open interest ${value > 0 ? 'rising' : 'falling'} by ${(Math.abs(value) * 100).toFixed(2)}%`;
    case 'long_short_ratio':
      return `Long/short ratio ${value.toFixed(2)} — contrarian ${dir}`;
    default:
      return `${featureName}: signal ${signal.toFixed(2)}`;
  }
}

// ─── Core Scoring Engine ─────────────────────────────────────────────────────

class PredictionScorer {
  constructor() {
    this.bankroll = 100;  // default USDC bankroll
    this.recentDrawdown = 0;
    this.featureImportanceLog = [];  // track for later validation
    this._lastScoredAt = null;
    this._lastTradeTime = {};  // cooldown tracking per asset+timeframe
  }

  /**
   * Record that a trade was taken for cooldown tracking.
   */
  recordTrade(asset, timeframe) {
    this._lastTradeTime[`${asset}_${timeframe}`] = Date.now();
  }

  /**
   * Check if we should skip trading due to cooldown (3 market cycles).
   * @param {string} asset
   * @param {string} timeframe
   * @returns {boolean} true if still in cooldown
   */
  shouldCooldown(asset, timeframe) {
    const key = `${asset}_${timeframe}`;
    const last = this._lastTradeTime[key];
    if (!last) return false;
    const cooldownMs = timeframe === '5m' ? 3 * 5 * 60000 : 3 * 15 * 60000; // skip 3 market cycles
    return (Date.now() - last) < cooldownMs;
  }

  /**
   * Main scoring method.
   * Takes features + market data, returns a trading signal or null.
   *
   * @param {string} asset - e.g. 'BTC', 'ETH', 'SOL'
   * @param {string} timeframe - '5m' or '15m'
   * @param {object} features - feature map from predictionDataPipeline.js
   * @param {number} jupiterMarketProb - Jupiter market's implied P(UP), e.g. 0.55
   * @param {number} marketLifecycleMinutes - minutes since market opened
   * @param {number} marketRegime - 0 = choppy, 1 = ranging, 2 = trending (default 1)
   * @returns {object|null} signal object or null if data insufficient
   */
  scoreMarket(asset, timeframe, features, jupiterMarketProb, marketLifecycleMinutes, marketRegime = 1) {
    if (!features || typeof features !== 'object') {
      return this._reject('No features provided');
    }

    // ── Step 1: Compute individual feature signals ──
    const featureSignals = {};
    const featureDetails = [];
    const directionalFeatures = [];
    const reasons = [];

    for (const [name, weight] of Object.entries(FEATURE_WEIGHTS)) {
      const signal = computeFeatureSignal(name, features);
      featureSignals[name] = signal;

      featureDetails.push({
        name,
        signal,
        weight,
        value: safeNum(features[name]),
        contribution: signal * weight,
      });

      // Track directional features (non-zero signal, non-modifier)
      if (signal !== 0 && weight > 0) {
        directionalFeatures.push({ name, signal, weight });
      }

      // Generate reason for significant signals
      if (Math.abs(signal) > 0.3 && weight >= 0.03) {
        reasons.push(generateReason(name, signal, safeNum(features[name])));
      }
    }

    // ── Step 2: Weighted aggregation ──
    let rawScore = 0;
    for (const detail of featureDetails) {
      rawScore += detail.contribution;
    }

    // Apply volume modifier: amplify score when volume is elevated
    // Use PREVIOUS bar's volume ratio to avoid amplifying stale moves
    const volumeRatio = safeNum(features.prev_volume_ratio || features.volume_ratio, 1);
    const volumeMultiplier = volumeRatio > 2 ? 1.15 :
                             volumeRatio > 1.5 ? 1.08 :
                             volumeRatio < 0.5 ? 0.85 : 1.0;
    rawScore *= volumeMultiplier;

    // ── Step 3: Convert to probability ──
    const ourProbUp = this._scoreToProbability(rawScore, timeframe);

    // ── Step 4: Determine direction ──
    const direction = ourProbUp >= 0.5 ? 'UP' : 'DOWN';

    // ── Step 5: Confidence assessment ──
    const confidence = this._computeConfidence(directionalFeatures, features, direction);

    // ── Step 6: Category breakdown ──
    const featureBreakdown = {};
    for (const [category, featureNames] of Object.entries(FEATURE_CATEGORIES)) {
      featureBreakdown[category] = featureNames.reduce((sum, name) => {
        return sum + (featureSignals[name] || 0) * (FEATURE_WEIGHTS[name] || 0);
      }, 0);
    }

    // ── Step 7: Top features (sorted by absolute contribution) ──
    const topFeatures = featureDetails
      .filter(f => f.signal !== 0)
      .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
      .slice(0, 5)
      .map(f => ({ name: f.name, signal: f.signal, weight: f.weight, contribution: f.contribution }));

    // ── Step 8: Edge detection ──
    const marketProbUp = safeNum(jupiterMarketProb, 0.5);
    const grossEdge = this._computeEdge(ourProbUp, marketProbUp, direction);
    const netEdge = grossEdge - ESTIMATED_FEE_PCT;

    // ── Step 9: Kelly sizing ──
    const marketPrice = direction === 'UP' ? marketProbUp : (1 - marketProbUp);
    const kellyResult = this._quarterKelly(
      direction === 'UP' ? ourProbUp : (1 - ourProbUp),
      marketPrice,
      this.bankroll,
      {
        recentDrawdown: this.recentDrawdown,
        confidence,
        maxFraction: 0.05,
      }
    );

    // ── Step 9b: Dynamic Kelly adjustment by dominant feature category ──
    const topCats = topFeatures.map(f => {
      for (const [cat, names] of Object.entries(FEATURE_CATEGORIES)) {
        if (names.includes(f.name)) return cat;
      }
      return 'other';
    });
    const dominantCat = topCats.length > 0 ?
      topCats.sort((a, b) => topCats.filter(v => v === b).length - topCats.filter(v => v === a).length)[0] : 'other';

    // Orderbook features more reliable at short timeframes
    const catMultiplier = {
      orderbook: 1.15,    // size slightly larger
      volume: 1.05,
      momentum: 0.90,     // less reliable at 5m
      derivatives: 0.85,
      temporal: 0.80,
      other: 0.90,
    };
    const kellyAdjustment = catMultiplier[dominantCat] || 0.90;
    const adjustedKellyFraction = kellyResult.fraction * kellyAdjustment;
    const adjustedBetSize = adjustedKellyFraction * this.bankroll;

    // ── Step 10: Feature quality check ──
    const featureQuality = this._assessFeatureQuality(features);

    // ── Step 11: Quality filters ──
    const rejectResult = this._applyQualityFilters({
      confidence,
      grossEdge,
      netEdge,
      spreadBps: safeNum(features.spread_bps, 0),
      marketLifecycleMinutes,
      timeframe,
      featureQuality,
      marketRegime,
    });

    // ── Step 12: Log feature importance for future validation ──
    this._logFeatureImportance(asset, timeframe, topFeatures, direction, ourProbUp);
    this._lastScoredAt = Date.now();

    // Default reasons if none were significant enough
    if (reasons.length === 0) {
      reasons.push('No strongly directional signals detected');
    }

    return {
      asset,
      timeframe,
      direction,
      ourProbUp: Number(ourProbUp.toFixed(4)),
      marketProbUp: Number(marketProbUp.toFixed(4)),
      grossEdge: Number(grossEdge.toFixed(4)),
      netEdge: Number(netEdge.toFixed(4)),
      confidence: Number(confidence.toFixed(4)),
      featureBreakdown,
      topFeatures,
      rawScore: Number(rawScore.toFixed(6)),
      kellyFraction: Number(adjustedKellyFraction.toFixed(4)),
      kellyAdjustment: Number(kellyAdjustment.toFixed(2)),
      dominantCategory: dominantCat,
      betSize: Number(adjustedBetSize.toFixed(2)),
      reasons,
      reject: rejectResult.reject,
      rejectReason: rejectResult.reason,
      featureQuality: Number(featureQuality.toFixed(4)),
      scoredAt: Date.now(),
    };
  }

  // ─── Probability Mapping ─────────────────────────────────────────────────

  /**
   * Map raw aggregate score to a calibrated probability via sigmoid.
   * For 5m markets, signal is weaker → compress probability range.
   */
  _scoreToProbability(rawScore, timeframe) {
    const scale = timeframe === '5m' ? 2.5 : 3.0;
    const prob = 1 / (1 + Math.exp(-scale * rawScore));

    // Clamp to realistic ranges — never claim extreme certainty on short timeframes
    const maxProb = timeframe === '5m' ? 0.70 : 0.75;
    const minProb = timeframe === '5m' ? 0.30 : 0.25;
    return Math.max(minProb, Math.min(maxProb, prob));
  }

  // ─── Confidence Assessment ───────────────────────────────────────────────

  /**
   * Confidence score (0-1) based on:
   *  - Feature agreement: what % of directional features agree on direction
   *  - Data freshness: penalize stale features
   *  - Volume context: higher volume = higher confidence
   *  - Spread context: tighter spread = higher confidence
   *  - Strong signal count: more strong signals = more confident
   */
  _computeConfidence(directionalFeatures, features, direction) {
    if (directionalFeatures.length === 0) return 0.3;

    // 1. Feature agreement (40% of confidence)
    const agreeCount = directionalFeatures.filter(f =>
      (direction === 'UP' && f.signal > 0) || (direction === 'DOWN' && f.signal < 0)
    ).length;
    const agreementRatio = agreeCount / directionalFeatures.length;
    const agreementScore = agreementRatio;  // 0 to 1

    // 2. Strong signal count (25% of confidence)
    const strongSignals = directionalFeatures.filter(f => Math.abs(f.signal) > 0.5);
    const strongRatio = Math.min(strongSignals.length / 5, 1);  // cap at 5 strong signals

    // 3. Volume context (15% of confidence)
    const volRatio = safeNum(features.volume_ratio, 1);
    const volumeScore = clamp(volRatio / 2, 0.3, 1);

    // 4. Spread context (10% of confidence)
    const spreadBps = safeNum(features.spread_bps, 10);
    const spreadScore = spreadBps <= 5 ? 1.0 :
                        spreadBps <= 15 ? 0.8 :
                        spreadBps <= 30 ? 0.6 :
                        spreadBps <= 50 ? 0.4 : 0.2;

    // 5. Data freshness / quality (10% of confidence)
    const featureAge = safeNum(features._featureAge, 0);  // seconds since last pipeline update
    const freshnessScore = featureAge <= 10 ? 1.0 :
                           featureAge <= 30 ? 0.8 :
                           featureAge <= 60 ? 0.5 : 0.2;

    const confidence = (agreementScore * 0.40) +
                       (strongRatio * 0.25) +
                       (volumeScore * 0.15) +
                       (spreadScore * 0.10) +
                       (freshnessScore * 0.10);

    return clamp(confidence, 0, 1);
  }

  // ─── Feature Quality ─────────────────────────────────────────────────────

  /**
   * Assess how many features have valid, fresh data.
   * Returns 0-1 where 1 = all features present and fresh.
   */
  _assessFeatureQuality(features) {
    const criticalFeatures = [
      'returns_1m', 'returns_5m', 'rsi_7',
      'buy_sell_ratio', 'cvd_slope',
      'book_imbalance_1', 'book_imbalance_5', 'microprice_deviation',
      'ofi_cumulative',
      'funding_rate', 'long_short_ratio',
    ];

    let validCount = 0;
    for (const name of criticalFeatures) {
      const val = features[name];
      if (val !== null && val !== undefined && !isNaN(val)) {
        validCount++;
      }
    }

    const baseQuality = validCount / criticalFeatures.length;

    // Penalize if feature data is stale
    const featureAge = safeNum(features._featureAge, 0);
    const freshnessPenalty = featureAge > 60 ? 0.3 :
                             featureAge > 30 ? 0.1 : 0;

    return clamp(baseQuality - freshnessPenalty, 0, 1);
  }

  // ─── Edge Detection ──────────────────────────────────────────────────────

  /**
   * Compute our perceived edge over the Jupiter market price.
   */
  _computeEdge(ourProbUp, marketProbUp, direction) {
    if (direction === 'UP') {
      return ourProbUp - marketProbUp;
    } else {
      return (1 - ourProbUp) - (1 - marketProbUp);
    }
  }

  // ─── Kelly Sizing ────────────────────────────────────────────────────────

  /**
   * Quarter-Kelly position sizing with graduated drawdown tiers.
   *
   * @param {number} prob - our probability of winning
   * @param {number} marketPrice - market's implied price for our direction
   * @param {number} bankroll - total available capital
   * @param {object} opts - adjustment options
   * @returns {{ fraction: number, betSize: number }}
   */
  _quarterKelly(prob, marketPrice, bankroll, {
    recentDrawdown = 0,
    confidence = 1,
    maxFraction = 0.05,
  } = {}) {
    if (marketPrice <= 0 || marketPrice >= 1) {
      return { fraction: 0, betSize: 0 };
    }

    const b = (1 / marketPrice) - 1;  // decimal odds
    const rawKelly = ((prob * (b + 1)) - 1) / b;

    if (rawKelly <= 0) {
      return { fraction: 0, betSize: 0 };
    }

    let f = rawKelly * 0.25;  // quarter Kelly for safety

    // Graduated drawdown tiers
    if (recentDrawdown > 0.20) f = 0;              // Hard stop
    else if (recentDrawdown > 0.15) f *= 0.25;     // Quarter size
    else if (recentDrawdown > 0.10) f *= 0.50;     // Half size
    else if (recentDrawdown > 0.05) f *= 0.75;     // Three-quarter size
    // Below 5%: full size

    // Confidence adjustments
    if (confidence < 0.6) f *= 0.5;
    if (confidence < 0.4) f = 0;

    f = Math.max(0, Math.min(f, maxFraction));

    return {
      fraction: f,
      betSize: f * bankroll,
    };
  }

  // ─── Quality Filters ─────────────────────────────────────────────────────

  /**
   * Apply all quality filters. Returns { reject: boolean, reason: string|null }.
   */
  _applyQualityFilters({ confidence, grossEdge, netEdge, spreadBps, marketLifecycleMinutes, timeframe, featureQuality, marketRegime }) {
    // Adversarial: massive edge = likely stale data, not real alpha
    if (Math.abs(grossEdge) > 0.15) {
      return { reject: true, reason: `Edge suspiciously large (${(grossEdge * 100).toFixed(1)}% > 15%) — likely stale data` };
    }

    // Market regime gate: reject choppy markets
    if (marketRegime === 0) {
      return { reject: true, reason: 'Market regime is choppy — no reliable signal type' };
    }

    if (confidence < 0.45) {
      return { reject: true, reason: `Confidence too low (${(confidence * 100).toFixed(1)}% < 45%)` };
    }

    // Session-aware edge thresholds
    const hour = new Date().getUTCHours();
    const session = hour >= 14 || hour < 0 ? 'US' : hour >= 8 ? 'EU' : 'ASIA';
    const minGrossEdge = session === 'US' ? 0.04 : session === 'EU' ? 0.05 : 0.065;
    // Weekend: require higher edge (lower liquidity, more noise)
    const dayOfWeek = new Date().getUTCDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const adjustedMinEdge = isWeekend ? minGrossEdge * 1.3 : minGrossEdge;

    if (Math.abs(grossEdge) < adjustedMinEdge) {
      return { reject: true, reason: `Gross edge too small (${(grossEdge * 100).toFixed(1)}% < ${(adjustedMinEdge * 100).toFixed(1)}% for ${session}${isWeekend ? ' weekend' : ''})` };
    }

    if (netEdge < 0.035) {
      return { reject: true, reason: `Net edge too small after fees (${(netEdge * 100).toFixed(1)}% < 3.5%)` };
    }

    if (spreadBps > 10) {
      return { reject: true, reason: `Spread too wide (${spreadBps.toFixed(1)} bps > 10 bps)` };
    }

    // Market lifecycle: don't enter stale markets
    const maxMinutes = timeframe === '5m' ? 2 : 5;
    if (marketLifecycleMinutes > maxMinutes) {
      return { reject: true, reason: `Market too far into lifecycle (${marketLifecycleMinutes.toFixed(1)}m > ${maxMinutes}m for ${timeframe})` };
    }

    if (featureQuality < 0.5) {
      return { reject: true, reason: `Feature quality too low (${(featureQuality * 100).toFixed(0)}% < 50%) — too many stale/missing features` };
    }

    return { reject: false, reason: null };
  }

  // ─── Helper to build a reject result ─────────────────────────────────────

  _reject(reason) {
    return {
      asset: null,
      timeframe: null,
      direction: null,
      ourProbUp: 0.5,
      marketProbUp: 0.5,
      grossEdge: 0,
      netEdge: 0,
      confidence: 0,
      featureBreakdown: {},
      topFeatures: [],
      rawScore: 0,
      kellyFraction: 0,
      kellyAdjustment: 1,
      dominantCategory: null,
      betSize: 0,
      reasons: [],
      reject: true,
      rejectReason: reason,
      featureQuality: 0,
      scoredAt: Date.now(),
    };
  }

  // ─── Feature Importance Logging ──────────────────────────────────────────

  /**
   * Log feature contributions for later validation against actual outcomes.
   * Keep a rolling buffer of the most recent entries.
   */
  _logFeatureImportance(asset, timeframe, topFeatures, direction, probUp) {
    this.featureImportanceLog.push({
      timestamp: Date.now(),
      asset,
      timeframe,
      direction,
      probUp,
      topFeatures: topFeatures.map(f => ({ name: f.name, signal: f.signal, weight: f.weight })),
    });

    // Keep only last 500 entries
    if (this.featureImportanceLog.length > 500) {
      this.featureImportanceLog = this.featureImportanceLog.slice(-500);
    }
  }

  // ─── Configuration ──────────────────────────────────────────────────────

  setBankroll(amount) {
    if (typeof amount !== 'number' || amount <= 0) {
      throw new Error('Bankroll must be a positive number');
    }
    this.bankroll = amount;
  }

  setDrawdown(pct) {
    if (typeof pct !== 'number' || pct < 0 || pct > 1) {
      throw new Error('Drawdown must be between 0 and 1');
    }
    this.recentDrawdown = pct;
  }

  // ─── Model Info ──────────────────────────────────────────────────────────

  /**
   * Returns model metadata for transparency and debugging.
   */
  getModelInfo() {
    const featureList = Object.keys(FEATURE_WEIGHTS);
    const totalWeight = Object.values(FEATURE_WEIGHTS).reduce((s, w) => s + w, 0);

    const categoryWeights = {};
    for (const [category, names] of Object.entries(FEATURE_CATEGORIES)) {
      categoryWeights[category] = names.reduce((s, n) => s + (FEATURE_WEIGHTS[n] || 0), 0);
    }

    return {
      modelVersion: MODEL_VERSION,
      modelType: 'Weighted Feature Ensemble (Rule-Based)',
      lastUpdated: MODEL_UPDATED,
      totalFeatures: featureList.length,
      featureList,
      weights: { ...FEATURE_WEIGHTS },
      categoryWeights,
      totalWeight: Number(totalWeight.toFixed(2)),
      probabilityMapping: 'Calibrated sigmoid with timeframe-dependent scaling',
      positionSizing: 'Quarter-Kelly with graduated drawdown tiers and category-based adjustment',
      qualityFilters: {
        minConfidence: 0.45,
        minGrossEdge: 'Session-aware (US: 4%, EU: 5%, ASIA: 6.5%, +30% on weekends)',
        minNetEdge: 0.035,
        maxSpreadBps: 10,
        maxGrossEdge: 0.15,
        maxLifecycle5m: '2 minutes',
        maxLifecycle15m: '5 minutes',
        minFeatureQuality: 0.5,
        marketRegimeGate: 'Rejects choppy (regime 0)',
      },
      kellyAdjustments: {
        drawdownTiers: '0-5%: full, 5-10%: 75%, 10-15%: 50%, 15-20%: 25%, >20%: stop',
        categoryMultipliers: { orderbook: 1.15, volume: 1.05, momentum: 0.90, derivatives: 0.85, temporal: 0.80 },
      },
      cooldown: '3 market cycles per asset+timeframe',
      estimatedFeePct: ESTIMATED_FEE_PCT,
      maxProbability: { '5m': 0.70, '15m': 0.75 },
      minProbability: { '5m': 0.30, '15m': 0.25 },
      bankroll: this.bankroll,
      recentDrawdown: this.recentDrawdown,
      featureImportanceLogSize: this.featureImportanceLog.length,
      lastScoredAt: this._lastScoredAt,
    };
  }

  /**
   * Get aggregated feature importance stats from logged predictions.
   * Useful for understanding which features are driving decisions.
   */
  getFeatureImportanceStats() {
    if (this.featureImportanceLog.length === 0) {
      return { message: 'No predictions logged yet', stats: {} };
    }

    const counts = {};
    const totalSignals = {};

    for (const entry of this.featureImportanceLog) {
      for (const f of entry.topFeatures) {
        if (!counts[f.name]) {
          counts[f.name] = 0;
          totalSignals[f.name] = 0;
        }
        counts[f.name]++;
        totalSignals[f.name] += Math.abs(f.signal);
      }
    }

    const stats = {};
    for (const name of Object.keys(counts)) {
      stats[name] = {
        appearedInTopFeatures: counts[name],
        avgAbsSignal: Number((totalSignals[name] / counts[name]).toFixed(3)),
        pctOfPredictions: Number((counts[name] / this.featureImportanceLog.length * 100).toFixed(1)),
      };
    }

    // Sort by frequency
    const sorted = Object.entries(stats)
      .sort((a, b) => b[1].appearedInTopFeatures - a[1].appearedInTopFeatures);

    return {
      totalPredictions: this.featureImportanceLog.length,
      stats: Object.fromEntries(sorted),
    };
  }
}

module.exports = new PredictionScorer();
