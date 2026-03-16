# ULTIMATE CRYPTO BACKTESTER PRO — COMPLETE ENGINE AUDIT
### Version: v2.6-market-cycle-accuracy | Date: 2026-03-16
### Purpose: Comprehensive system documentation for AI review (ChatGPT, Grok, Claude)

---

## REQUEST FOR REVIEWERS

This document is a complete technical audit of a live crypto trading system. After reading, please provide:
1. **Feedback on the architecture and algorithms** — what's strong, what's weak
2. **Specific improvement ideas** — algorithms, risk management, new features
3. **Potential bugs or edge cases** we may have missed
4. **Suggestions for the self-learning system** — how to make calibration smarter
5. **Ideas for new indicators, patterns, or risk controls**
6. **Opinion on the leverage/sizing framework** — too conservative? Too aggressive?

---

## TABLE OF CONTENTS

### PART 1: SYSTEM OVERVIEW
1. Architecture & Data Flow
2. Technology Stack
3. Asset Universe

### PART 2: SIGNAL GENERATION ENGINE
4. Core Indicators (7 indicators, regime-adaptive)
5. Confluence Scoring (family dampening, probability mapping)
6. Chart Pattern Detection (7 pattern types, multi-pattern scoring)
7. Multi-Timeframe Confluence
8. Probability Calibration (Bayesian self-learning)

### PART 3: RISK MANAGEMENT
9. Market Quality Grading
10. Entry Efficiency (Chasing Detection)
11. Leverage Risk Framework (6 safety gates)
12. Position Sizing (Eighth-Kelly with graduation)
13. Stop Loss / Take Profit (structural snapping, dynamic precision)
14. Expected Value Sorting

### PART 4: TRADE EXECUTION
15. Auto-Trade Pipeline (qualifying filters, hard blocks)
16. BloFin Exchange Integration (auth, orders, safety)
17. Live Engine (strategy polling, kill switch, encryption)

### PART 5: SELF-LEARNING SYSTEM
18. Prediction Logging & Resolution
19. Calibration Cache (5 dimensions)
20. Kelly Graduation
21. Frontend Calibration (bucket system, decay weighting)

### PART 6: MARKET INTELLIGENCE
22. Market Cycle Dashboard (12 indicators, bear/bull detection)
23. News & Sentiment Engine
24. Prediction Markets (Jupiter integration)

### PART 7: FRONTEND DASHBOARD
25. UI Architecture & Pages
26. Scan Card Rendering
27. Settings & Configuration

### PART 8: IMPROVEMENT ROADMAP
28. Known Limitations
29. Planned Upgrades
30. Open Questions for Reviewers

---

# PART 1: SYSTEM OVERVIEW

## 1. Architecture & Data Flow

The system runs two parallel trading engines sharing infrastructure:

**Engine A: BestTradesScanner (Perpetual Futures on BloFin)**
- Scans 20 crypto assets across 6 timeframes (5m, 15m, 30m, 1h, 4h, 1d)
- Uses Binance public REST API for candle/indicator data
- Uses BloFin for funding rates, trade execution, and account management
- Stores predictions and outcomes in PostgreSQL (`best_trades_log`)
- Self-calibrating: learns from historical outcomes to adjust probability and Kelly sizing
- Executes trades via `blofinClient.js` → BloFin REST API

**Engine B: PredictionEngine (Jupiter Prediction Markets on Solana)**
- Trades 5m/15m up/down prediction markets on Jupiter (BTC, ETH, SOL, XRP)
- Uses Binance Futures WebSocket for real-time orderbook, trades, and kline data
- AI scorer computes calibrated probability from 22 weighted features
- Paper and real trading modes

**Complete Data Flow:**
```
USER CLICKS "RUN SCAN" (or auto-scan timer fires)
    │
    ├── Fetch BTC klines → detectCurrentRegime() → btcRegime (macro proxy)
    │
    ├── FOR EACH of 20 assets:
    │   ├── Fetch 200 candles from Binance REST
    │   ├── detectCurrentRegime(assetData) → localRegime
    │   ├── Blend: 60% btcRegime + 40% localRegime (50/50 for major L1s)
    │   │
    │   ├── computeSignals() → 7 indicators with regime-adaptive thresholds
    │   ├── detectChartPatterns() → up to 7 pattern types, scored
    │   ├── fetchCrossTFBias() → higher-TF trend alignment
    │   │
    │   ├── scoreConfluence() → family-dampened, sigmoid probability
    │   ├── calibrateProb() → Bayesian correction from historical outcomes
    │   ├── estimateRR() → structural SL/TP, Kelly sizing, leverage
    │   │
    │   └── Result: { prob, direction, rr, ev, leverage, confidence, quality, patterns }
    │
    ├── Sort by Expected Value (not raw probability)
    ├── Render scan cards with full detail
    │
    └── IF AUTO-TRADE ENABLED:
        ├── Filter: prob ≥ min, quality ≠ No-Trade, NOT Chasing, EV > 0
        ├── Check balance, positions < max, portfolio heat < 6%
        ├── Apply leverage gates (drawdown, consecutive loss, win rate, funding)
        ├── Dynamic SL/TP precision (up to 10 decimals for micro-cap)
        └── Execute via BloFin API → TP/SL set → if TP/SL fails, close position
```

## 2. Technology Stack

| Component | Technology |
|-----------|-----------|
| Frontend | Single-file HTML/CSS/JS SPA (~24,500 lines, ~1.3MB) |
| Backend | Node.js + Express |
| Database | PostgreSQL (Railway) |
| Exchange | BloFin (perpetual futures) |
| Market Data | Binance REST + WebSocket |
| Hosting | Railway (backend), GitHub Pages (frontend) |
| Auth | JWT tokens, AES-256-GCM credential encryption |
| Real-time | Server-Sent Events (SSE) for predictions |

## 3. Asset Universe (20 pairs)

```
BTC, ETH, SOL, SUI, BNB, DOGE, XRP, ADA,
AVAX, LINK, DOT, NEAR, ARB, OP, APT, INJ,
PEPE, BONK, WIF, RENDER
```

All traded as USDT perpetual futures on BloFin. Timeframes: 5m, 15m, 30m, 1h, 4h, 1d.

---

# PART 2: SIGNAL GENERATION ENGINE

## 4. Core Indicators (7 Indicators, Regime-Adaptive)

All indicators use **regime-adaptive thresholds** that shift based on BTC macro regime (bull/bear/sideways). This prevents false signals — e.g., RSI 40 is oversold in a bull market but neutral in a bear market.

### 4.1 RSI (14-period)

| Regime | Oversold | Overbought |
|--------|----------|------------|
| Bull | 40 | 75 |
| Bear | 25 | 55 |
| Neutral | 35 | 65 |

- Bull signal when RSI ≤ oversold threshold
- Bear signal when RSI ≥ overbought threshold

### 4.2 EMA Cross (Regime-Adaptive Periods)

| Regime | Fast | Slow |
|--------|------|------|
| Volatile | 34 | 89 |
| Bull | 13 | 34 |
| Default | 21 | 55 |

- **Flat filter**: If EMA spread < 0.5% of price → no signal (avoids whipsaws)
- Cross detection on previous bar
- Volatility detection: recent ATR(20) > old ATR(50) × 1.3

### 4.3 MACD (Timeframe-Adaptive Parameters)

| Timeframe | Fast | Slow | Signal |
|-----------|------|------|--------|
| Scalp (1m-5m) | 5 | 13 | 8 |
| Bridge (15m-30m) | 8 | 17 | 9 |
| Medium (1h-4h) | 5 | 35 | 5 |
| Long (1d+) | 12 | 26 | 9 |

- Neutral filter: |MACD| < price × 0.001
- Cross strength requirement: |MACD| > price × 0.002

### 4.4 Bollinger Bands

- SMA(20) ± **2.5** standard deviations (wider than standard 2.0 for crypto volatility)
- Bull when %B ≤ 0.15 (near lower band)
- Bear when %B ≥ 0.85 (near upper band)
- **BBWP squeeze detection**: Bandwidth percentile < 20% over last 100 bars = potential breakout

### 4.5 Stochastic RSI

| Regime | Oversold | Overbought |
|--------|----------|------------|
| Bull | 25 | 85 |
| Bear | 15 | 75 |
| Neutral | 20 | 80 |

- RSI(14) → Stochastic(14) applied
- K/D crossover signals

### 4.6 Ichimoku (Timeframe-Adaptive)

| Timeframe | Tenkan | Kijun | Span B |
|-----------|--------|-------|--------|
| Short (≤15m) | 9 | 26 | 52 |
| Medium (1h-4h) | 10 | 30 | 60 |
| Long (≥1d) | 20 | 60 | 120 |

- Bull: price above cloud AND tenkan > kijun
- Bear: price below cloud AND tenkan < kijun

### 4.7 Volume (3-Layer Analysis)

1. **Doji filter**: Skip candles where body < 15% of range (indecisive)
2. **OBV slope**: Linear regression of 10-bar OBV, normalized by average volume
3. **Body-weighted direction**: `0.6 × bodyDirection + 0.4 × wickBuyRatio`
- Bull: volRatio > 1.5 AND directional AND OBV confirms
- Bear: inverse
- Volume drying detection: volRatio < 0.5

---

## 5. Confluence Scoring

### 5.1 Timeframe-Aware Indicator Weights

| Indicator | Short TF (1m-15m) | Medium TF (30m-1h) | Long TF (1d+) |
|-----------|-------------------|--------------------|--------------  |
| RSI | 22% | 18% | 8% |
| StochRSI | 22% | 15% | 5% |
| BB | 18% | 14% | 8% |
| Volume | 15% | 12% | 12% |
| MACD | 10% | 14% | 18% |
| EMA | 8% | 14% | 25% |
| Ichimoku | 5% | 13% | 22% |

### 5.2 Family Dampening (Anti-Correlation Inflation)

Indicators grouped into families to prevent triple-counting the same signal:
- **Mean Reversion**: RSI, StochRSI, BB
- **Trend**: EMA, MACD, Ichimoku
- **Flow**: Volume

When multiple indicators in the same family agree, diminishing returns apply:
```
FAMILY_DECAY = [1.0, 0.60, 0.35]
```
Example: If RSI=bull, StochRSI=bull, BB=bull → RSI gets 1.0× weight, StochRSI gets 0.60×, BB gets 0.35×

### 5.3 Trend vs Mean-Reversion Conflict

If 2+ trend indicators oppose a mean-reversion signal, that signal's weight is halved (0.50×). This prevents fighting the trend.

### 5.4 Cross Bonus & Opposing Penalty

- Fresh indicator cross (just happened): **1.3×** weight bonus
- Indicator opposing trade direction: **-0.4×** weight (counts against)

### 5.5 Probability Mapping (Sigmoid)

```
baseProbability = 28 + (78 - 28) / (1 + exp(-7 × (confluence - 0.5)))
```
- Maps confluence 0→1 to probability 28%→78% via sigmoid (K=7)
- Prevents extreme probabilities from small confluence changes

### 5.6 Priority Waterfall Adjustments (global cap ±20 points)

| Priority | Adjustment | Sub-Cap |
|----------|-----------|---------|
| P1: Cross-TF alignment | Higher-TF trend confirms/opposes | ±14 |
| P2: Regime adjustment | Bull/bear alignment | ±4 |
| P3: Funding rate | Percentile-adaptive per asset | ±4 |
| P4: Historical performance | Min 30 trades, graduated strength | ±6 |
| P5: Personal optimizer | User's win rate per indicator | ±4 |
| P6: ETF flow bias | Institutional flow (1h+ only) | ±4 |
| P7: Chart patterns | Scored pattern composite | ±15 |

### 5.7 Confidence Classification

| Level | Confluence Threshold | Max Probability |
|-------|---------------------|-----------------|
| High | ≥ 0.38 | 85% (A-grade), 80% (B+), 76% (B) |
| Medium | ≥ 0.22 | 72% |
| Low | < 0.22 | 62% |

Additional caps: C quality = max 65%, No-Trade = max 55%
Absolute range: [25%, 85%]

---

## 6. Chart Pattern Detection Engine

### 6.1 Architecture

Standalone module (`chartPatterns.js`, 1,055 lines) with 7 pattern detectors. Includes inline helpers: ATR, SMA, EMA, linear regression, RSI, MACD, swing pivots.

### 6.2 The 7 Pattern Types

#### Pattern 1: Bull/Bear Flags
- **Impulse**: 3-8 candles, move > 1.5× ATR, 60%+ directional candles
- **Consolidation**: 2-15 candles after impulse, range < 50% of impulse
- **Counter-slope** required (flag retraces against impulse)
- **High-Tight Flag**: impulse > 3× ATR AND consolidation < 20% → base WR **0.77**
- Normal base WR: **0.41**
- Breakout: price beyond consolidation boundary with volume > 1.3×

#### Pattern 2: Falling/Rising Wedge
- Window: 20-50 candles, both trendlines converging
- Linear regression on highs and lows
- **Falling wedge**: both slopes negative, lows steeper → bullish (base WR **0.67**)
- **Rising wedge**: both slopes positive, highs less steep → bearish (base WR **0.73**)
- Minimum 5 total touches (2 per trendline), 0.5% tolerance

#### Pattern 3: Triangles
- **Ascending**: flat highs, rising lows → bullish (base WR **0.75**)
- **Descending**: flat lows, falling highs → bearish (base WR **0.64**)
- **Symmetrical**: falling highs + rising lows → neutral (base WR **0.49**), direction at breakout

#### Pattern 4: Double Top/Bottom
- Swing pivots with 5-bar lookback
- Two swing lows/highs within **2% tolerance**, 10-50 bars apart
- **Double Bottom**: base WR **0.79** (highest win rate pattern)
- **Double Top**: base WR **0.73**

#### Pattern 5: MACD State Machine
- Bullish/Bearish Cross: MACD crosses signal line (base WR **0.35**)
- Bullish Divergence: price lower low + histogram higher low (base WR **0.60**)
- Bearish Divergence: price higher high + histogram lower high (base WR **0.60**)

#### Pattern 6: RSI Divergence
- RSI(14) divergence against price
- **Bullish**: price lower low, RSI higher low (base WR **0.65**)
- **Bearish**: price higher high, RSI lower high (base WR **0.65**)
- Range: 10-30 bars between pivots

#### Pattern 7: Support/Resistance Breakout
- Cluster pivots within 0.5% to identify S/R levels (need ≥ 3 touches)
- **Retest**: pulled back to level and bounced with volume > 1.3× (base WR **0.66**)
- Simple breakout: base WR **0.52**

### 6.3 Pattern Scoring Formula

```
score = baseWinRate × CRYPTO_MOD × TF_WEIGHT × volumeMod × stageMod × regimeMod
```

| Factor | Values |
|--------|--------|
| CRYPTO_MOD | 0.90 (all patterns reduced 10% for crypto noise) |
| TF_WEIGHT | 5m=0.30, 15m=0.50, 30m=0.60, 1h=0.70, 4h=0.90, 1D=1.00 |
| stageMod | forming=0.20, developing=0.50, confirmed=0.75, breakout=1.00, retest=1.15 |
| volumeMod | <0.8=0.50, 0.8-1.2=0.80, 1.2-2.0=1.20, 2.0-3.0=1.00, >3.0=0.70 |
| regimeMod | Aligned continuation=1.20, Counter-trend=0.80, Range continuation=0.60, Reversal in trend=0.50, Reversal in range=1.10, Volatile=0.70 |

### 6.4 Multi-Pattern Confluence

Patterns sorted by score descending. Diminishing returns:
```
factors = [1.0, 0.67, 0.50, 0.40, 0.33, 0.28, 0.25]
```

**Probability adjustment**: `normalized = (composite - 0.50) / 0.50`, then `tanh(normalized × 1.5) × 15`, capped at **±15%**.

### 6.5 Signal Decay (Pattern Expiry)

| Timeframe | Bars Until Expiry |
|-----------|------------------|
| 5m | 6 bars |
| 15m | 8 bars |
| 30m | 10 bars |
| 1h | 12 bars |
| 4h | 10 bars |
| 1d | 8 bars |

---

## 7. Multi-Timeframe Confluence

**Elder's Triple Screen** approach:

| Base TF | Cross-Reference TFs |
|---------|-------------------|
| 5m | 15m, 1h |
| 15m | 1h, 4h |
| 30m | 4h, 1d |
| 1h | 4h, 1d |
| 4h | 1d, 1w |
| 1d | 1w |

- **Aligned** (higher TF confirms): +2 to +3 probability points
- **Opposing** (higher TF contradicts): -3 to -4 probability points
- 4h timeframe requires **ADX > 20** (confirmed trending) for any signal

---

## 8. Probability Calibration (Bayesian Self-Learning)

### Backend Three-Layer Calibration

Requires **≥ 30 resolved trades** before applying. Refreshed every 30 minutes.

**Layer 1: Probability Bucket Correction**
- Groups historical trades by predicted probability bucket (5% bands)
- Compares predicted vs actual win rate
- Applies 60% of the difference, with shrinkage factor (n/100)
- **Recency-weighted**: 70% recent (30-day) + 30% overall

**Layer 2: Regime + Timeframe Correction**
- Win rate specific to current regime/TF combo
- 30% weight, shrinkage n/100

**Layer 3: Market Quality Correction**
- Win rate specific to market quality grade
- 20% weight, shrinkage n/100

### Frontend Calibration (Supplementary)

- Stores predictions in localStorage (`probCalPending_v1`, cap 500)
- Resolves when price hits SL or TP
- **Exponential decay weighting**: `weight = 0.95^daysSince` (~14-day half-life)
- Bucket system (5% bands) with regime-specific sub-buckets
- Blends regime-specific and global calibration:
  - Global: min 15 predictions, weight = `predictions / (predictions + 50)`
  - Regime: min 10 predictions, weight = `min(0.8, predictions / (predictions + 30))`

---

# PART 3: RISK MANAGEMENT

## 9. Market Quality Grading

Composite score (0-10+) from:

| Factor | Points |
|--------|--------|
| ATR expansion (recent/old > 1.2) | +2 |
| Volume ratio > 1.2 | +2 |
| EMA spread > 1% | +2 |
| BB squeeze or BBWP > 50% | +1 |
| Indicator alignment ≥ 5 | +2 |
| Indicator alignment ≥ 3 | +1 |
| Low ATR ratio (< 0.8) | -1 |
| Low volume | -1 |
| Tight EMA spread | -1 |

| Grade | Score | Effect |
|-------|-------|--------|
| A | ≥ 7 | Full leverage, 120% size multiplier |
| B+ | ≥ 5 | Moderate leverage, normal size |
| B | ≥ 4 | Reduced leverage, 80% size |
| C | ≥ 1 | Minimal leverage, 50% size, cap 65% prob |
| No-Trade | < 1 | No trade, cap 55% prob |

## 10. Entry Efficiency (Chasing Detection)

**Chasing = HARD BLOCK (no trade)**

Detection criteria:
- `recentImpulse = |price_change_3_bars| / ATR > 2.5`
- OR: 3 consecutive directional candles with EMA21 distance > 2%

| Rating | Criteria | Effect |
|--------|----------|--------|
| **Chasing** | impulse > 2.5 ATR | Trade BLOCKED |
| Excellent | EMA21 distance < 0.3% | Ideal entry |
| Late | impulse > 1.5 ATR | -5% prob penalty |
| OK | Everything else | Normal |

The dashboard shows **why** a trade was blocked (visible rejection reasons on each scan card).

## 11. Leverage Risk Framework (6 Safety Gates)

All gates checked before every trade. Most restrictive gate wins.

### Gate 1: Phased Rollout

| Phase | Max Leverage | Requirements |
|-------|-------------|-------------|
| Phase 1 (conservative) | 3× | Win rate ≥ 55%, 200+ trades, A-grade only for >1× |
| Phase 2 (moderate) | 5× | Win rate ≥ 57%, 500+ trades, B+ gate |
| Phase 3 (full) | 10× | Win rate ≥ 60%, 1000+ trades, C gate |

### Gate 2: Drawdown Protection

| Drawdown | Action |
|----------|--------|
| ≥ 20% | **KILL SWITCH** — all trading halted, leverage = 0 |
| ≥ 15% | Max 1× leverage |
| ≥ 10% | Max 2× |
| ≥ 5% | Reduce 1 tier |

### Gate 3: Consecutive Loss Protection

| Consecutive Losses | Action |
|-------------------|--------|
| ≥ 5 | All trading disabled (24h) |
| ≥ 3 | Max 2× leverage |
| ≥ 2 | Reduce 1 tier |

### Gate 4: Win Rate Gate

| Win Rate | Action |
|----------|--------|
| < 50% | Forced 1× |
| 50-54% | Max 2×, A-grade only |
| 55-56% | Max 3× |

### Gate 5: Funding Rate Gate

If funding rate > 0.1%/8h AND opposes trade direction → cap at 2×

### Gate 6: Portfolio Heat

Maximum **6% total portfolio exposure** across all open positions. Trade rejected if would exceed.

## 12. Position Sizing (Eighth-Kelly with Graduation)

### Base Kelly Multipliers

| Quality + Confidence | Kelly Fraction |
|---------------------|----------------|
| A + High | 0.30 |
| A + Medium | 0.25 |
| B (any) | 0.20 |
| C (any) | 0.125 |
| No-Trade | 0.075 |

### Kelly Calculation

```
kellyFrac = (prob/100 × RR - (1 - prob/100)) / RR
safeKelly = max(0, kellyFrac × kellyMultiplier)
optimalLev = floor(safeKelly / (stopPct / 100))
```

### Kelly Graduation Bonus (from calibration performance)

| Criteria | Kelly Bonus |
|----------|------------|
| 200+ trades, calibration error ≤ 3% | +20% |
| 100+ trades, calibration error ≤ 5% | +10% |
| 50+ trades, calibration error ≤ 8% | +5% |

### Leverage Caps by Confidence

| Confidence | Max Leverage | × Quality Multiplier |
|-----------|-------------|---------------------|
| High | 10× | A=1.0, B=0.8, C=0.5 |
| Medium | 5× | same |
| Low | 2× | same |

### Market Quality Size Multiplier

| Grade | Size Multiplier |
|-------|----------------|
| A | 120% |
| B | 80% |
| C | 50% |
| No-Trade | 0% (blocked) |

## 13. Stop Loss / Take Profit

### Stop Loss

1. **Default**: 2.0× ATR from entry
2. **Structural snapping**: Scans for swing lows/highs within 0.5 ATR of default stop → snaps with 0.1 ATR buffer
3. **Clamped**: Min 1.2× ATR, Max 3.0× ATR

### Take Profit (Inverted — higher probability = tighter target)

| Probability | TP Distance |
|------------|-------------|
| ≥ 72% | 2.0× ATR |
| ≥ 62% | 2.5× ATR |
| < 62% | 3.0× ATR |

**Quality boost**: A-grade = 1.25× target, B = 1.0×, C = 0.85×

### Dynamic Price Precision (v2.5 fix)

| Price Range | Decimal Places |
|------------|----------------|
| < $0.0001 (PEPE, etc.) | 10 |
| < $0.01 | 8 |
| < $1 | 6 |
| < $100 | 4 |
| ≥ $100 (BTC, etc.) | 2 |

**Safety check**: If SL == TP or either == entry after rounding → trade ABORTED.

### TP/SL Failure Safety (v2.5 fix)

If the BloFin TP/SL API call fails after opening a position:
1. Position is **immediately closed** (no naked exposure)
2. Error logged: `❌❌ CRITICAL: Could not close unprotected position` if close also fails
3. Trade throws error rather than continuing

## 14. Expected Value Sorting

Trades sorted by **EV (not raw probability)** since v2.1:

```
EV = (prob/100 × leveraged_target%) - ((1 - prob/100) × leveraged_stop%) - (2 × 0.06% fee)
```

This ensures high-RR setups with moderate probability rank above high-probability low-RR setups.

---

# PART 4: TRADE EXECUTION

## 15. Auto-Trade Pipeline

### Qualifying Filters (ALL must pass — these are HARD BLOCKS)

| Filter | Threshold | Block Type |
|--------|-----------|-----------|
| Probability | ≥ minProb (default 70%) | Hard block |
| Market Quality | ≠ No-Trade | Hard block |
| Entry Efficiency | ≠ Chasing | **Hard block** |
| Expected Value | > 0 | **Hard block** |
| Balance | Sufficient for trade | Hard block |
| Open Positions | < maxOpen (default 3) | Hard block |
| Portfolio Heat | < 6% total exposure | Hard block |

### Blocked Trade Visibility

When a trade is blocked, the **reason is displayed on the scan card** so the user knows exactly why. Examples:
- "Chasing entry — extended move, poor entry location"
- "Negative EV (−0.023) — risk exceeds reward"
- "Market quality No-Trade — insufficient conditions"

### Background Auto-Scan Intervals

| Timeframe | Scan Interval |
|-----------|--------------|
| 1m | 60 seconds |
| 5m | 3 minutes |
| 15m | 10 minutes |
| 30m | 15 minutes |
| 1h | 30 minutes |
| 4h | 1 hour |
| 1d | 4 hours |

### Auto-Trade Modes

- **Auto**: Direct execution (no confirmation needed)
- **Confirm**: Notification popup with 30-second auto-dismiss

## 16. BloFin Exchange Integration

### Authentication
- HMAC-SHA256 signature: `sign(requestPath + METHOD + timestamp + nonce + body, secretKey)` → base64
- All API calls include: `ACCESS-KEY`, `ACCESS-SIGN`, `ACCESS-TIMESTAMP`, `ACCESS-NONCE`, `ACCESS-PASSPHRASE`

### Rate Limiting (Token Bucket)
- General API: 500 tokens / 60 seconds
- Trading endpoints: 30 tokens / 10 seconds

### Order Flow
1. Set hedge mode (`long_short_mode`)
2. Set leverage for specific position side
3. Place market order with `brokerId`
4. Set TP/SL via separate `/trade/order-tpsl` endpoint
5. **If TP/SL fails → close position immediately**

### Position Close
- Fetches actual position size from BloFin
- Places market close order with exact size

## 17. Live Engine (liveEngine.js)

### Features
- **Credential encryption**: AES-256-GCM, PBKDF2 key derivation (100,000 rounds)
- **Auto-unlock**: From environment variable on Railway deploy
- **Strategy polling**: Every 60 seconds
- **Signal combination**: AND (all indicators agree) or OR (any matches)
- **Kill switch**: Closes all positions, deactivates all strategies, sends Telegram notification
- **Telegram notifications**: For entries and exits

---

# PART 5: SELF-LEARNING SYSTEM

## 18. Prediction Logging & Resolution

### What Gets Logged

Every scan logs the top 3 results (by EV or prob ≥ 50%) to PostgreSQL with:

| Field | Description |
|-------|------------|
| Asset, direction, timeframe | What was predicted |
| Probability, confidence, market quality | Signal strength |
| R:R ratio, EV | Risk/reward metrics |
| Entry, stop, target prices | Price levels |
| Signal snapshot | All 7 indicator states at time of prediction |
| Chart pattern data | Pattern names, types, scores, stages |
| Raw vs calibrated probability | Before/after learning adjustment |
| Confluence score | Raw confluence value |
| Optimal leverage | Computed leverage |

### Resolution Tracker (runs every 5 minutes)

For each unresolved prediction:
1. Fetch candles since prediction was created
2. Check if any candle's high hit TP (win) or low hit SL (loss)
3. If both hit in same candle: use open price proximity heuristic
4. Record outcome, PnL percentage, resolution timestamp
5. Expire predictions older than 7 days (short TFs) or 30 days (long TFs)

### Deduplication

If identical pending signal exists (same asset/direction/timeframe):
- Increments `scan_count`
- Updates probability to latest
- Does NOT create duplicate prediction

## 19. Calibration Cache (5 Dimensions)

Refreshed every 30 minutes from PostgreSQL. Requires ≥ 30 resolved trades.

| Dimension | Weight | Purpose |
|-----------|--------|---------|
| Probability bucket | 60% of difference | If we predict 65% but actual is 83%, correct toward 83% |
| Regime + timeframe | 30% | Win rate for specific regime/TF combo |
| Market quality | 20% | Win rate for specific grade |
| Confidence level | Tracked | Win rate per confidence tier |
| Overall calibration error | Tracked | Drives Kelly graduation |

**Shrinkage**: All corrections scaled by `n/100` (conservative with few samples).

**Recency weighting**: 70% recent (30-day) + 30% overall for probability buckets.

## 20. Kelly Graduation

Based on **mean absolute calibration error** across all probability buckets:

| Trades | Max Error | Kelly Bonus |
|--------|-----------|-------------|
| 200+ | ≤ 3% | +20% |
| 100+ | ≤ 5% | +10% |
| 50+ | ≤ 8% | +5% |
| < 50 | Any | No bonus |

This rewards the system for being well-calibrated — the better the predictions match reality, the more aggressively it's allowed to size.

## 21. Frontend Calibration (Supplementary)

Independent local calibration system running alongside backend:

- **Storage**: localStorage key `probCalPending_v1` (max 500 pending)
- **Decay**: `weight = 0.95^daysSince` (~14-day half-life, newer data counts more)
- **Bucket system**: 5% probability bands (e.g., "65-70%", "70-75%")
- **Regime sub-buckets**: Separate calibration for bull/bear/sideways per bucket
- **Minimum samples**: 15 (global) or 10 (regime-specific)
- **Blend formula**: `calibratedProb = rawProb × (1 - weight) + historicalWinRate × weight`

**This calibration is used for Kelly sizing only** — the displayed probability is the raw (uncalibrated) value.

---

# PART 6: MARKET INTELLIGENCE

## 22. Market Cycle Dashboard (12 Indicators)

### Overview
A comprehensive market cycle position tool that calculates where BTC is in its 4-year halving cycle. Uses 12 weighted indicators to produce a single 0-100 score.

### The 12 Indicators

| # | Indicator | Weight | What It Measures |
|---|-----------|--------|-----------------|
| 1 | 200-Day MA Position | 20 | Price vs long-term average (2-98 score) |
| 2 | RSI Momentum | 10 | Overbought/oversold (direct RSI mapping) |
| 3 | Pi Cycle Top | 15 | 111MA vs 2×350MA (classic top detector) |
| 4 | 2-Year MA Multiplier | 5 | Price vs 730-day SMA (buy/sell bands) |
| 5 | ATH Drawdown | 15 | Distance from all-time high |
| 6 | Volume Trend | 5 | Accumulation vs distribution |
| 7 | Trend Direction | 15 | Blended 30/60/90-day momentum |
| 8 | Halving Cycle Position | 15 | Days since halving, phase detection |
| 9 | Mayer Multiple | 10 | Price / 200-day SMA ratio |
| 10 | Rainbow Chart | 10 | Log regression band position |
| 11 | Diminishing Returns | 5 | Cycle return decay model |
| 12 | Liquidation Risk | 0 | Standalone warning (not in score) |

**Total effective weight: 125** (Liquidation Risk excluded)

### Halving Cycle Phase Detection (v2.6 Updated)

Based on historical cycle data:
```
Cycle 2012: Halving → ATH 367d → Bottom 777d (−86.9%)
Cycle 2016: Halving → ATH 526d → Bottom 889d (−84.3%)
Cycle 2020: Halving → ATH 548d → Bottom 924d (−77.6%)
Average:    Halving → ATH 480d → Bottom 863d (−82.9%)
Cycle 2024: Halving Apr 20 → ATH Oct 6 2025 ($126,296) = 534d → Bottom proj ~Aug 2026
```

| Days Post-Halving | Phase | Score Range | Wall Street Emotion |
|-------------------|-------|-------------|-------------------|
| 0-90 | Post-Halving Consolidation | 20-30 | Disbelief / Hope |
| 90-270 | Recovery & Accumulation | 25-40 | Hope / Optimism |
| 270-450 | Bull Market Acceleration | 40-65 | Belief / Thrill |
| 450-560 | Historical Peak Zone | 65-90 | Euphoria / Complacency |
| 560-650 | Post-Peak Distribution | 35-50 | Anxiety / Denial |
| **650-780** | **Bear Correction** | **20-30** | **Fear / Denial** |
| **780-950** | **Capitulation Zone** | **12-20** | **Panic / Capitulation** |
| **950-1050** | **Late Bear / Recovery** | **10-15** | **Depression / Hope** |
| 1050+ | Pre-Halving Base | 15-30 | Anger / Depression |

**Bold = v2.6 changes** (split old single bear phase into 3 sub-phases, lowered POST-PEAK → BEAR transition from day 730 to day 650)

### Bear/Bull Market Detection

| Signal | Bearish | Bullish |
|--------|---------|---------|
| 200MA | Price below (score < 40) | Price above (score > 60) |
| ATH Drawdown | Deep drawdown (score < 35) | Near ATH (score > 70) |
| Trend | Score < 40 | Score > 60 |
| Halving Phase | Post-peak or bear phase | Pre-rally phase |

- **Bear market**: 2+ bear signals OR (1 bear + 0 bull)
- **Bull market**: 2+ bull signals OR (1 bull + 0 bear)
- Stored globally as `window._cycleDirection`

### Verdict Overrides (v2.6)

1. **Trend penalty**: Bearish trend (score < 30) adds +8 to score → pushes toward caution
2. **Peak zone floor**: Historical Peak Zone forces score ≥ 62 (CAUTION minimum)
3. **ATH proximity floor**: Near ATH (score ≥ 85) forces score ≥ 62
4. **Bear accumulation compression (NEW v2.6)**: If deep drawdown (>40%) AND bear phase AND score > 35 → compress by 0.7× → pushes toward ACCUMULATE

### Zone Bar Labels

**Bear market labels** (left=opportunity → right=danger):
```
🟢 ACCUMULATE → 🔵 OVERSOLD → 🟡 BEAR RALLY → 🟠 DISTRIBUTION → 🔴 BREAKDOWN
```

**Bull market labels**:
```
🟢 DEEP VALUE → 🔵 EARLY BULL → 🟡 MID BULL → 🟠 LATE BULL → 🔴 EUPHORIA
```

## 23. News & Sentiment Engine

### Sources
- CoinDesk, Cointelegraph, Decrypt (RSS feeds)
- Polled every 2 minutes, max 100 articles retained

### Sentiment Scoring

Three-tier weighted keywords:
- **Strong** (±0.8): surge, soars, crash, hack, exploit, scam
- **Moderate** (±0.5): gains, rally, institutional, selloff, plunge
- **Mild** (±0.3): partnership, milestone, crackdown, vulnerability

**Negation handling**: Checks 30 characters before keyword for negation words (not, no, never, etc.). Negated positive → −0.3, negated negative → +0.3.

Score clamped to [−1, 1]. **Not currently used in trade signal generation** — informational only.

## 24. Prediction Markets (Jupiter)

### AI Scorer (22 Weighted Features)

| Category | Weight | Features |
|----------|--------|----------|
| Orderbook | 38% | Bid/ask imbalance, depth ratio, spread, wall detection |
| Volume/Flow | 20% | Volume ratio, OBV slope, trade flow imbalance |
| Momentum | 21% | RSI, MACD, Stoch, price velocity |
| Derivatives | 11% | Funding rate, OI change, long/short ratio |
| Temporal | 10% | Session (US/EU/Asia), hour-of-day, weekend factor |

### Session-Aware Edge Requirements

| Session | Min Gross Edge |
|---------|---------------|
| US | 4% |
| EU | 5% |
| Asia | 6.5% |
| Weekend | ×1.3 multiplier |

### Risk Controls
- Min net edge (after 1.5% fees): 3.5%
- Max gross edge: 15% (adversarial filter — probably stale data)
- Max spread: 10 bps
- Probability clamp: 5m [30%, 70%], 15m [25%, 75%]
- Max Kelly fraction: 5%
- Cross-asset correlation: 3+ same direction → 40% size reduction; 4+ → only trade BTC

---

# PART 7: FRONTEND DASHBOARD

## 25. UI Architecture

### 8 Main Pages

| Tab | Function |
|-----|----------|
| Backtester | Single/multi-indicator backtesting with TradingView charts |
| Degen Scanner | Meme coin scanner with liquidity checks |
| Market Intel | Risk/Reward Analysis, sector analysis, correlation maps |
| Best Trades | Probability engine results, history, portfolio tracker |
| Alerts | Multi-type alert engine (price, RSI, funding, strategy, probability, regime) |
| Paper Trade | Simulated trading with PnL tracking |
| Live Trading | Real BloFin integration, open positions, auto-trade settings |
| Predictions | Jupiter/Polymarket signals, AI engine status |

### Design System
- Dark theme (bg: #0a0e17)
- Primary color: #00d68f
- Fonts: Inter, Syne, JetBrains Mono, Space Mono
- Responsive: 7 breakpoints from 480px to 1400px

## 26. Scan Card Rendering

Each scan card displays:

| Element | Detail |
|---------|--------|
| Asset circle | Color-coded with label |
| Direction | Long (green arrow) / Short (red arrow) |
| Probability arc | SVG circular arc, color-coded |
| Confidence badge | High/Medium/Low with color |
| R:R ratio | Risk-to-reward display |
| Entry efficiency | Excellent/OK/Late/Chasing label |
| Market quality | A/B+/B/C/No-Trade grade |
| Signal bars | Green (aligned) / Red (opposing) per indicator |
| Chart patterns | Pattern badges with stage icons (🔥 breakout, ✓ confirmed, ◌ forming) |
| Optimal leverage | Computed leverage display |
| EV | Expected Value |
| Fee impact | Trading fees deducted |
| **Auto-trade blocked box** | Visible rejection reasons when trade fails |
| Both directions | Long AND short probabilities shown side by side |
| ETF flow | Institutional flow bias (1h+ only) |
| Signal breakdown | Full table of all indicator states |

## 27. Settings & Configuration

### Auto-Trade Settings
```javascript
{
  on: boolean,              // enabled/disabled
  mode: 'auto' | 'confirm', // direct execution or popup
  minProb: number,           // default 70%
  size: number,              // USD per trade
  sizeMode: 'fixed' | 'kelly',
  maxOpen: number,           // default 3
  tfRules: {                 // per-timeframe overrides
    '15m': { minProb: 72, size: 50 },
    '4h':  { minProb: 68, size: 200 },
  }
}
```

Settings synced to backend via POST so server-side scanner runs 24/7 even when browser is closed.

### Alert Configuration
6 alert types: price, RSI, funding, strategy, probability, regime
- Browser notifications, Telegram, Discord channels
- **Fatigue management**: Global 5s cooldown, burst limit 5/60s, correlated symbol suppression 30s, duplicate suppression 10s

---

# PART 8: IMPROVEMENT ROADMAP

## 28. Known Limitations

### Critical / High Priority

| # | Issue | Impact |
|---|-------|--------|
| 1 | **Single-file frontend** (24,500 lines) | Maintenance nightmare, slow load |
| 2 | **News sentiment not integrated into signals** | Decorative only — wasted potential |
| 3 | **No trailing stop / partial TP** | Misses gains in trending markets |
| 4 | **Same-candle SL/TP ambiguity** | Uses proximity heuristic — imprecise |
| 5 | **No slippage modeling** | PnL calculations don't account for market impact |
| 6 | **Calibration cold start** | Need 30+ trades before learning kicks in |
| 7 | **Jupiter real trading not implemented** | Only paper trades on prediction engine |
| 8 | **Cross-TF dedup is time-based only** | No priority for higher-confidence TF |

### Medium Priority

| # | Issue | Impact |
|---|-------|--------|
| 9 | **No correlation between Engine A and Engine B** | Could take opposing positions |
| 10 | **200-candle limit** | Some indicators need more warmup data |
| 11 | **BloFin TP/SL failure → full close** | Safe but misses trades on transient errors |
| 12 | **ADX filter only on 4h** | Other TFs don't benefit from trend filter |
| 13 | **PredictionDataPipeline uses Binance fapi (geo-restricted)** | HTTP 451 in US |
| 14 | **Paper trade fallback uses random** | Non-deterministic when Jupiter API fails |
| 15 | **No candle data caching** | Each scan re-fetches all 20 assets fresh |

### Lower Priority

| # | Issue | Impact |
|---|-------|--------|
| 16 | **No TypeScript** | Large codebase, no type safety |
| 17 | **localStorage dependency** | Risk of data loss, no cross-device sync |
| 18 | **CORS proxy dependency (allorigins.win)** | Third-party with no SLA |
| 19 | **SSE reconnection caps at 20** | Must refresh page after |
| 20 | **Single dark theme** | No light mode option |
| 21 | **Cross-asset correlation is simple** | Fixed threshold vs real correlation coefficients |
| 22 | **Symmetrical triangle hardcoded as continuation** | Should be neutral/breakdown |

## 29. Planned Upgrades

| Feature | Status | Description |
|---------|--------|-------------|
| Trailing Stop | Planned | Move SL to breakeven at 1R profit, then trail |
| Partial Take Profit | Planned | Take 50% at TP1, let rest run with trailing |
| Phase 2 Leverage | Pending 500 trades | Unlock 5× max leverage |
| News Sentiment Integration | Planned | Use sentiment as signal modifier |
| ML Pattern Recognition | Research | Replace heuristic patterns with trained models |
| Split Frontend | Planned | Break monolith into modules |
| Candle Caching | Planned | TTL-based cache per TF |
| WebSocket Scan Data | Planned | Replace REST polling for live scans |
| Correlation Matrix | Planned | Real-time asset correlation for position sizing |

## 30. Open Questions for Reviewers

1. **Is Eighth-Kelly too conservative or appropriate?** We halved from Quarter-Kelly based on 3-AI consensus at 243 trades. With 600+ trades now, should we graduate?

2. **Should news sentiment be integrated as a filter or probability modifier?** Currently it's informational only. What's the best way to incorporate it without overfitting to headlines?

3. **The family dampening factors [1.0, 0.60, 0.35] — are these optimal?** Should the second and third indicator in the same family count more or less?

4. **Is the +/−15% chart pattern probability cap too restrictive?** Patterns like double bottom (79% WR) are significantly dampened by the crypto modifier and cap.

5. **The priority waterfall has a global ±20 cap. Is this too tight?** In strong trend environments, cross-TF alignment + regime + patterns could all push the same direction.

6. **Should the system dynamically adjust the probability floor (25%) based on market regime?** In extreme bear markets, even 25% might be too high for longs.

7. **Is there value in adding order flow / Level 2 data from BloFin** to the signal generation? Currently only candle data drives decisions.

8. **The 4h ADX > 20 requirement — should this extend to other timeframes?** Currently only 4h requires confirmed trending.

9. **Should pattern detection consider higher-timeframe candles for confirmation?** Currently it only uses the same TF as the scan.

10. **What ML approaches would you recommend for pattern detection?** Current heuristic-based detection works but is rigid.

11. **The 6% portfolio heat cap — should this be dynamic** based on market cycle position? E.g., 8% in accumulation zones, 4% in distribution?

12. **Should the system implement a time-based stop?** E.g., if a trade hasn't hit TP or SL in X bars, close at market to free up capital?

13. **Any ideas for improving the same-candle SL/TP ambiguity** beyond the proximity heuristic?

14. **Should we implement a "conviction score" separate from probability** that considers the quality of the setup holistically?

---

*This audit covers approximately 30,000 lines of production code across 10 files. The system is live-trading on BloFin with real capital under Phase 1 conservative risk controls.*

*Generated 2026-03-16 for external AI review.*
