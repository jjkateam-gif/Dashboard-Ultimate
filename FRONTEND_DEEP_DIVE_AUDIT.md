# Ultimate Crypto Dashboard Pro -- Frontend Deep-Dive Audit
### File: `index.html` (~24,552 lines, ~1.3 MB single-file SPA)
### Audit Date: 2026-03-16

---

## TABLE OF CONTENTS
1. Dashboard Layout & UI
2. Market Cycle Dashboard (12 Indicators)
3. Live Signal Computation
4. Frontend Chart Pattern Detection
5. Auto-Trade System
6. Scan Card Rendering
7. BloFin Integration
8. Learning/Logging Integration (Calibration)
9. Prediction Display
10. Settings & Configuration
11. Market Cycle Bar & Labels
12. Key Frontend Constants
13. Recent Upgrades
14. Known Frontend Limitations & Improvement Ideas

---

## 1. DASHBOARD LAYOUT & UI

### CSS Design System (lines 1-500)
- **Primary color**: `--primary: #00d68f`
- **Background**: `--bg: #0a0e17`
- **Panel**: `--panel: rgba(17,24,39,0.92)`
- **Font stack**: Inter, Syne, JetBrains Mono, Space Mono
- **Design tokens**: spacing 4-32px, radius 4-20px, shadows, transitions
- **Responsive breakpoints**: 1400px, 1200px, 900px, 800px, 768px, 600px, 480px

### Page Structure (lines 694-2500)
- **Login overlay**: JWT-based auth system (login/register/forgot/reset password)
- **Backend**: `window.CBP_BACKEND = 'https://dashboard-ultimate-production.up.railway.app'`
- **Global BloFin status bar**: connection dot, balance display, positions count
- **Ticker bar**: 8 crypto prices (BTC, ETH, SOL, SUI, BNB, DOGE, ADA, XRP) refreshed periodically from Binance
- **Market Cycle Dashboard panel** (`#cycle-panel`): sits above all page tabs, shows BTC cycle position

### 8 Main Page Tabs
1. **Backtester** -- Single/multi-indicator backtesting with TradingView Lightweight Charts
2. **Degen Scanner** -- Meme coin scanner with buy/sell signals, liquidity checks
3. **Market Intel** -- Risk/Reward Analysis Engine with fundamental data, sector analysis, correlation maps
4. **Best Trades** -- The probability engine scan results, history, portfolio tracker
5. **Alerts** -- Multi-type alert engine (price, RSI, funding, strategy, probability, regime)
6. **Paper Trade** -- Simulated trading with PnL tracking
7. **Live Trading** -- Real BloFin API integration, open positions, auto-trade settings
8. **Predictions** -- Prediction market signals (Jupiter/Polymarket), AI engine status

---

## 2. MARKET CYCLE DASHBOARD (12 Indicators)

### Function: `calcCycleDashboard(d)` (lines 3454-3954)
Requires 50+ candles minimum. Returns `{ score: overallScore, indicators: results[] }`.

Each indicator returns: `{ name, score (0-100), signal ('bull'/'bear'/'neutral'), weight, val, desc }`

### Indicator 1: 200-Day MA (weight: 20)
Maps percentage above/below 200-period SMA to a 2-98 score.
- Below -30%: score 2 (deep bear)
- -30% to 0%: score 2-35 (bear territory)
- 0% to 50% above: score 35-50 (healthy bull)
- 50% to 150%: score 50-70 (extended bull)
- 150% to 300%: score 70-90 (late cycle)
- 300%+: score 90-98 (euphoria)
- Signal: bull if score < 35, bear if score > 70, else neutral

### Indicator 2: RSI Momentum (weight: 10)
Direct RSI(14) mapping to 0-100.
- RSI < 35: bull signal
- RSI > 65: bear signal
- Between: neutral

### Indicator 3: Pi Cycle Top (weight: 15)
Compares 111-period MA vs 2x the 350-period MA.
- `gap = (ma111 - 2*ma350) / (2*ma350) * 100`
- gap > 0: lines crossed = score 75-95 (TOP signal active)
- gap < -20%: score 5-35 (safe from top)
- Signal: bear if gap > 0, bull if gap < -15%

### Indicator 4: 2Y MA Multiplier (weight: 5)
Price divided by 2-year SMA (730 periods).
- Formula: `score = Math.round(Math.min(95, Math.max(5, (mult-1)/(5-1)*100)))`
- < 1x: extreme bottom, 2-3x: mid bull, > 5x: top
- Signal: bull if mult < 0.8, bear if mult > 4.0

### Indicator 5: ATH Drawdown (weight: 15)
Distance from all-time high.
- 0-15% drawdown: score 90-95 (near top)
- 15-40% drawdown: score 55-90
- 40-75% drawdown: score 15-55
- 75%+ drawdown: score 3-15 (capitulation)
- Signal: bear if drawdown < 15%, bull if drawdown > 60%

### Indicator 6: Volume Trend (weight: 5)
Ratio of up-volume to down-volume over recent candles.
- Formula: `score = Math.round(Math.min(85, Math.max(15, 50 - (ratio-1)*35)))`
- High ratio (more up volume) = lower score (bullish = less toppy)
- Signal: bull if ratio > 1.5, bear if ratio < 0.6

### Indicator 7: Trend Direction (weight: 15)
Blended 30/60/90-day momentum.
- Weights: 30d = 50%, 60d = 30%, 90d = 20%
- Penalties applied for: price below 50MA, lower-lows structure
- Signal derived from blended momentum score

### Indicator 8: Halving Cycle (weight: 15)
Based on days since the 2024-04-20 halving. Phase detection:
- **Post-halving consolidation** (0-90d): score 15-25
- **Recovery** (90-270d): score 25-40
- **Bull acceleration** (270-450d): score 40-55
- **Peak zone** (450-560d): score 55-75
- **Post-peak distribution** (560-650d): score 70-85
- **Bear correction** (650-780d): score 60-75
- **Capitulation zone** (780-950d): score 15-35
- **Late bear / Recovery** (950-1050d): score 10-25
- **Pre-halving base** (1050+d): score 20-30
- Includes Wall Street Cheat Sheet emotion mapping per phase
- Also stores `halvingPhase`, `daysSinceHalving`, `wscsEmotion`, `daysToBottom`

### Indicator 9: Mayer Multiple (weight: 10)
Price / 200-period SMA.
- < 0.5: score 3
- 0.5-0.8: score 5-20
- 0.8-1.0: score 20-35
- 1.0-1.4: score 35-55
- 1.4-2.4: score 55-85
- 2.4+: score 85-97 (capped)
- Signal: bull if < 0.8, bear if > 2.4

### Indicator 10: Rainbow Chart (weight: 10)
Logarithmic regression of price mapped to 9 bands.
- Computes log-linear regression: `log10(price) = a * dayIndex + b`
- `ratio = currentPrice / regressionCenterPrice`
- 9 bands from "Fire Sale" (< 0.4x) to "Maximum Bubble" (> 3.0x)
- Band thresholds: 0.4, 0.6, 0.8, 1.0, 1.3, 1.7, 2.2, 3.0
- Score formula: `Math.round(Math.max(3, Math.min(97, (Math.log(ratio) - Math.log(0.3)) / (Math.log(3.5) - Math.log(0.3)) * 100)))`
- Signal: bull if ratio < 0.7, bear if ratio > 2.0

### Indicator 11: Diminishing Returns Model (weight: 5)
Confirmed cycle 4 data: trough $15,500 (Nov 2022) to ATH $126,000 (Oct 6, 2025) = 8.1x.
- Historical trough-to-peak multipliers: 93x -> 29x -> 17x -> 8.1x
- Score: position between trough and ATH as percentage (pctOfATH)
- Signal: bull if pctOfATH < 40, bear if pctOfATH > 85

### Indicator 12: Liquidation Risk (weight: 0 -- standalone)
Fetched asynchronously from backend (BloFin leverage data).
- NOT included in overall cycle score (weight = 0)
- Stored in `window._liqRiskScore`, `window._liqRiskLabel`, `window._liqRiskDesc`
- Serves as a standalone risk warning display

### Overall Score Calculation
```
totalWeight = sum of all indicator weights where weight > 0
weightedSum = sum of (score * weight) for each indicator
overallScore = Math.round(weightedSum / totalWeight)
```
Total effective weight = 20+10+15+5+15+5+15+15+10+10+5 = **125**

---

## 3. LIVE SIGNAL COMPUTATION

### Function: `computeLiveSignals(d, tf)` (lines 13838-14175)

**Stale candle guard**: Excludes last candle if < 85% complete (based on time elapsed vs candle period).

**Regime detection** used for adaptive thresholds:
- Fetches BTC macro regime separately via `detectCurrentRegime()`
- `macro_bull`, `macro_bear`, `macro_sideways` flags drive threshold shifting

### Regime-Adaptive Thresholds

| Indicator | Bull | Bear | Neutral |
|-----------|------|------|---------|
| RSI oversold | 40 | 25 | 35 |
| RSI overbought | 75 | 55 | 65 |
| StochRSI oversold | 25 | 15 | 20 |
| StochRSI overbought | 85 | 75 | 80 |

### 7 Core Indicators Computed

**RSI** (14-period): Regime-adaptive buy/sell thresholds as above.

**EMA**: Regime-adaptive period selection:
- Volatile regime: 34/89
- Bull regime: 13/34
- Bear regime: 21/55
- Default: 21/55
- Neutral zone: when EMA spread < 0.5% of price

**MACD**: 4-tier timeframe-adaptive parameters:
- Scalp (1m-5m): 5/13/8
- Bridge (15m-30m): 8/17/9
- Medium (1h-4h): 5/35/5
- Long (1d+): 12/26/9
- Neutral zone: histogram near zero (< 0.1% of price)

**Bollinger Bands**: 2.5 standard deviations (not default 2.0). BBWP squeeze detection at bottom 20th percentile of BB width over 50 periods.

**StochRSI**: Regime-adaptive thresholds as above. K/D crossover signals.

**Ichimoku**: Timeframe-adaptive parameters:
- Short TFs (5m-30m): 9/26/52
- Medium TFs (1h-4h): 10/30/60
- Long TFs (1d+): 20/60/120
- Signals: price vs cloud, TK cross, cloud color

**Volume**: 3-layer analysis:
1. Doji filter (skip indecisive candles)
2. OBV slope (10-bar linear regression)
3. Body-weighted direction (candle body size * direction)

### Entry Efficiency
Determines how "late" an entry would be:
- **Chasing**: 3+ consecutive candles in same direction AND price extended > 2.5x ATR from mean
- **Excellent**: Price near the EMA mean (within 0.5 ATR)
- **Late**: 2+ candles extended, > 1.5 ATR from mean
- **OK**: Everything else

### Market Quality Grade
Based on `mqScore` computed from multiple factors:
- ATR expansion (recent ATR > 1.2x historical)
- Volume above 20-period average
- EMA spread > 1% (clear trend)
- BB not in squeeze
- Indicator alignment count (3+ aligned = bonus)
- **Grades**: A (mqScore >= 7), B (>= 4), C (>= 1), No-Trade (< 1)

---

## 4. FRONTEND CHART PATTERN DETECTION

### Function: `detectChartPatterns(d, tf, regime)` (lines 13682-13835)

**Timeframe weighting**:
```
TFW = { '5m':0.30, '15m':0.50, '30m':0.60, '1h':0.70, '4h':0.90, '1d':1.0 }
```

**Pattern stage weighting**:
```
STAGE_W = { forming:0.20, developing:0.50, confirmed:0.75, breakout:1.0, retest:1.15 }
```

**Lookback decay** (candles to look back per TF):
```
DECAY = { '5m':6, '15m':8, '30m':10, '1h':12, '4h':10, '1d':8 }
```

### Patterns Detected with Base Win Rates (bwr)
| Pattern | Base WR | Direction |
|---------|---------|-----------|
| Bull Flag | 0.41-0.77 | Long |
| Bear Flag | 0.41-0.77 | Short |
| Falling Wedge | 0.67 | Long |
| Rising Wedge | 0.73 | Short |
| Ascending Triangle | 0.75 | Long |
| Descending Triangle | 0.64 | Short |
| Double Bottom | 0.79 | Long |
| Double Top | 0.73 | Short |
| RSI Bull Divergence | 0.65 | Long |
| RSI Bear Divergence | 0.65 | Short |

### Pattern Scoring Formula
```
scoreP(bwr, stage, pType) = bwr * 0.90 * tfW * volMod(volRatio) * STAGE_W[stage] * regMod(pType)
```
Where:
- `volMod(volRatio)`: Volume modification based on volume ratio vs average
- `regMod(pType)`: Regime modifier -- penalizes counter-trend patterns

### Composite Score with Diminishing Returns
When multiple patterns are detected, each successive pattern contributes less:
```
factors = [1.0, 0.67, 0.50, 0.40, 0.33]
```
Patterns sorted by score descending, each multiplied by its factor.

### Probability Adjustment
- tanh-compressed, capped at +/-15%
- Applied as additive adjustment to the base probability

---

## 5. AUTO-TRADE SYSTEM

### Settings (configurable via UI, stored in localStorage + synced to backend)
- **Enabled**: on/off toggle
- **Mode**: `'auto'` (direct execution) or `'confirm'` (notification popup, 30s auto-dismiss)
- **Min Probability**: default 70%
- **Trade Size**: USD amount per trade
- **Size Mode**: `'fixed'` or `'kelly'`
- **Max Open Positions**: default 3
- **Per-TF Rules**: Custom min probability and size per timeframe

### Background Auto-Scan Timer
```
AUTO_SCAN_INTERVALS = {
  '1m': 60s, '3m': 2min, '5m': 3min, '15m': 10min,
  '30m': 15min, '1h': 30min, '4h': 1hr, '1d': 4hr
}
```
Runs `runProbEngine()` at the interval matching the selected timeframe. Double-checks auto-trade is still enabled each iteration.

### Processing: `processAutoTrades(results, tf)` (lines 17799-17876)

**Qualifying Filters (ALL must pass)**:
1. `prob >= minProb` (default 70)
2. `marketQuality !== 'No-Trade'`
3. `entryEfficiency !== 'Chasing'` -- **HARD BLOCK**, no override
4. `EV > 0` -- **HARD BLOCK**, negative expected value is rejected
5. Balance sufficient for trade size
6. Open positions < maxOpen limit
7. `mqSizeMult` applied to final size (A=120%, B=80%, C=50%, No-Trade=0%)

### EV Calculation
```
EV = (prob/100 * targetPct) - ((1 - prob/100) * stopPct) - (2 * TRADING_FEE_PCT)
```
Where `TRADING_FEE_PCT = 0.06%` (BloFin taker fee per side, so 2x for round trip).

### Server-Side Sync
Settings are POSTed to `BACKEND_URL + '/best-trades/settings'` so the backend server-side scanner can run 24/7 even when the browser is closed.

---

## 6. SCAN CARD RENDERING

### Function: `renderProbeResults(results)` (lines 15769-15951)

**Regime Banner**: Shows BTC macro regime (bull/bear/sideways with squeeze/volatile suffix) at the top of results.

**Card Contents per Asset**:
- Asset circle with color and label
- Direction arrow (long/short) with color
- Current price
- Funding rate with color coding
- **Probability arc**: SVG circular arc, color-coded by probability level
- R/R ratio display
- Confidence badge (High/Medium/Low)
- Signal hit/miss bars (green for aligned indicators, red for opposing)
- Chart pattern badges (if any detected)
- Optimal leverage display
- Mode indicator (manual/auto)
- EV (Expected Value) display
- Fee impact display
- **Auto-trade blocked reasons box**: Visible rejection reasons when a trade fails qualifying filters
- Both long AND short probabilities displayed side by side
- ETF flow bias indicator (if available, 1h+ only)
- Full signal breakdown table at bottom of each card

### Cross-Asset Correlation Discount
When 3+ assets show same-direction signals above 60% probability:
- Probability discount applied
- Position size reduced by `sqrt(n)` factor
- Prevents overconcentration in correlated moves

---

## 7. BLOFIN INTEGRATION

### Trade Execution: `autoExecDirect()` (lines 17878-17931)

**SL/TP Precision Fix** for small-price assets:
```javascript
const pricePrecision = lastPrice < 0.0001 ? 10
                     : lastPrice < 0.01   ? 8
                     : lastPrice < 1      ? 6
                     : lastPrice < 100    ? 4
                     : 2;
```

**Quality Gate (Phase 1)**:
- Only A-grade market quality can use leverage > 1x
- All grades capped at 3x maximum leverage
```javascript
if (r.marketQuality !== 'A') lev = Math.min(lev, 1);
lev = Math.min(lev, 3);
```

**Order Body**:
```
{
  instId,          // e.g., 'BTC-USDT'
  side,            // 'buy' or 'sell'
  orderType: 'market',
  sizeUsd,         // position size in USD
  leverage,        // applied leverage
  marginMode: 'cross',
  slPrice,         // stop-loss price (precision-rounded)
  tpPrice          // take-profit price (precision-rounded)
}
```

**Safety Checks**:
- Balance verification before execution
- Open position count check
- API credential validation
- Connection status verification via BloFin status bar dot

### BloFin API Connection
- Credentials stored in localStorage (encrypted)
- Status bar shows: connection dot (green/red), balance, open positions count
- API calls routed through backend proxy to avoid CORS issues

---

## 8. LEARNING/LOGGING INTEGRATION (CALIBRATION)

### Calibration Tracking System (lines 14196-14324)

**Recording** (`recordCalibrationPrediction`):
- Stores every probability prediction in localStorage under key `probCalPending_v1`
- Fields: id, asset, tf, probability, direction, entryPrice, stopPrice, targetPrice, regime, timestamp
- Capped at 500 pending predictions to prevent localStorage bloat
- Maximum age: 30 days (expired predictions are discarded)

**Resolution** (`resolveCalibrationPredictions`):
- Called when new price data arrives for an asset
- Checks if current price hit the stop (loss) or target (win)
- Long: win if price >= targetPrice, loss if price <= stopPrice
- Short: win if price <= targetPrice, loss if price >= stopPrice

**Bucket System**:
- Predictions grouped into 5% probability buckets (e.g., "65-70", "70-75")
- Each resolved prediction weighted by exponential decay:
  - `decayWeight = Math.pow(0.95, daysSince)` -- lambda=0.95/day, ~14-day half-life
- **Global buckets**: `cal.buckets[key] = { predictions, wins }` (both decay-weighted sums)
- **Regime-specific buckets**: `cal.regimeBuckets[regimeKey]` with same structure but tagged by regime (bull/bear/sideways)

**Calibrated Probability** (`getCalibratedProb`):
- Blends regime-specific and global calibration data
- Global: minimum 15 predictions in bucket required. Weight = `predictions / (predictions + 50)`
- Regime-specific: minimum 10 predictions required. Weight = `min(0.8, predictions / (predictions + 30))`
- Blend formula when both available:
  - `regimePref = regimeWeight / (regimeWeight + 0.3)`
  - `calibratedWR = regimeWR * regimePref + globalWR * (1 - regimePref)`
- Final: `rawProb * (1 - weight) + calibratedWR * weight`
- If no data: returns rawProb unchanged

**Usage**: Calibrated probability is used for Kelly sizing (not displayed -- display shows raw probability).

### Kelly Criterion Integration
Calibrated probability feeds into Kelly fraction for position sizing:
- Graduation by quality + confidence:
  - A + High confidence: 0.6x Kelly
  - A + Medium: 0.5x Kelly
  - B grade: 0.4x Kelly
  - C grade: 0.25x Kelly
  - No-Trade: 0.15x Kelly
- **Calibration bonus**: If 200+ trades with <=3% calibration error: +0.2 to fraction. If 100+ trades with <=5% error: +0.1

---

## 9. PREDICTION DISPLAY

### System Architecture (lines 24146-24480)
State managed via `PRED_STATE` object:
```javascript
const PRED_STATE = {
  marketsLoaded: false, loading: false,
  sseConnected: false, mode: 'paper',
  allMarkets: [], tradeLogView: 'paper'
};
```

### Data Loading (`loadPredictionMarkets`)
Fetches 4 endpoints in parallel:
1. `BACKEND_URL + '/predictions/markets'` -- Active prediction markets
2. `BACKEND_URL + '/predictions/signals'` -- Current trading signals
3. `BACKEND_URL + '/predictions/performance'` -- Win/loss stats, PnL
4. `BACKEND_URL + '/predictions/ai/status'` -- AI engine pipeline status

### AI Engine Status Display
- Shows pipeline readiness per asset (e.g., "Active (4/4 assets)")
- Progress bar for warming up assets
- Model info: total features, model version, scored/passed counts
- States: Active (green), Warming Up (yellow), Collecting Data (purple)

### SSE Real-Time Stream (`connectPredictionStream`)
Connects to `BACKEND_URL + '/predictions/stream'` via EventSource.
Events handled:
- `connected`: Updates SSE dot to green
- `signals`: Re-renders signal list in real time
- `markets`: Updates market list and count
- `status`: Updates bot running/stopped status and mode
- `trade`: Shows toast notification for new trades (paper or real)
- `resolved`: Shows toast for resolved trades with PnL
- Error: Exponential backoff reconnection (base 5s, max 120s, cap 20 retries)

### Signal Types Displayed
1. **Momentum** (yellow): Edge %, direction, current vs forecast price
2. **Trend** (blue): Edge %, direction, order book imbalance
3. **Arbitrage** (green): Guaranteed profit %, UP/DOWN prices, total cost
4. **AI Scored** (purple): Direction, edge %, confidence %, AI probability vs market probability, top AI reasons

### Performance Display
Shows for current mode (paper/real):
- Win count, loss count, total trades
- Win rate percentage
- Total PnL in USD
- ROI percentage (totalPnl / invested)

### Mode Toggle
- Paper mode: simulated trades, no real money
- Real mode: warning toast "trades will execute!", actual BloFin execution

---

## 10. SETTINGS & CONFIGURATION

### Auto-Trade Settings (stored in localStorage key `dash_autoTrade`)
```javascript
{
  on: boolean,           // enabled/disabled
  mode: 'auto'|'confirm',
  minProb: number,       // default 70
  size: number,          // USD per trade
  sizeMode: 'fixed'|'kelly',
  maxOpen: number,       // default 3
  tfRules: {             // per-timeframe overrides
    '15m': { minProb: 72, size: 50 },
    '4h':  { minProb: 68, size: 200 },
    // etc.
  }
}
```
Synced to backend via POST to `/best-trades/settings` so server-side scanner can use them 24/7.

### Portfolio Settings (localStorage key `dash_portfolio`)
```javascript
{ balance: number, pctPerTrade: number }
```
- Default balance: $1000
- Default pctPerTrade: 10%
- maxPositions = Math.floor(100 / pctPerTrade)
- Portfolio tracker walks resolved trades chronologically to compute running balance

### Degen Scanner Auto-Trade Settings (separate from main)
Stored via `saveDegenAutoTradeSettings()` / `loadDegenAutoTradeSettings()`.

### Prediction Bot Config
- Bet size
- Edge threshold (minimum edge % to take a trade)
- Momentum strategy: enabled/disabled
- Trend strategy: enabled/disabled

### Alert Configuration
Each alert stores:
- `id`, `name`, `type` (price/rsi/funding/strategy/probability/regime)
- `symbol`, `enabled`, `cooldown` (ms between firings)
- `lastFired`, `fireCount`
- `browser` (notification), `telegram`, `discord` (notification channels)
- Type-specific fields (targetPrice, rsiLevel, strategyParts, probThreshold, etc.)

### BloFin Credentials
Stored in localStorage (API key, secret, passphrase). Validated on connection attempt.

---

## 11. MARKET CYCLE BAR & LABELS

### Rendering: `renderCycleDashboard(d)` (lines 3956-4052+)

**Score Dial**: SVG arc with circumference 282.74, offset calculated as:
```javascript
offset = circumference - (score / 100) * circumference
```
Color by score: < 25 green, < 45 blue, < 60 yellow, < 75 orange, 75+ red-pink.

**Verdict System** (adjusted score with overrides):

1. **Trend Direction Override**: If trend score < 30, add +8 penalty (pushes toward caution). If < 40, add +4.
2. **Halving Phase Override**: If halving says "HISTORICAL PEAK ZONE" and adjustedScore < 62, force to at least 62 (CAUTION).
3. **ATH Drawdown Override**: If ATH drawdown score >= 85 (near ATH) and adjustedScore < 62, force to 62.
4. **Bear Accumulation Override**: If deep drawdown (> 40%) AND in bear phase AND adjustedScore > 35, compress by 0.7x.

**Cycle Direction Detection**:
- Bear signals: below 200MA + deep drawdown + bearish trend + post-peak/bear halving phase (count >= 2 = bear market)
- Bull signals: above 200MA + near ATH + bullish trend + pre-rally halving phase (count >= 2 = bull market)
- Stored globally as `window._cycleDirection` ('bear'/'bull'/'neutral')

**Zone Labels**: Bar reads left (safe/low risk) to right (danger/high risk). Zone marker positioned at `adjustedScore%`.

**Verdict Badges** (based on adjustedScore):
The bar maps the overall cycle position from accumulation (left/green) through mid-cycle to euphoria/distribution (right/red).

---

## 12. KEY FRONTEND CONSTANTS

### PROBE_ASSETS (20 assets scanned)
```
BTC, ETH, SOL, SUI, BNB, DOGE, XRP, ADA,
AVAX, LINK, DOT, NEAR, ARB, OP, APT, INJ,
PEPE, BONK, WIF, RENDER
```

### BASE_WIN_RATES (fallback before user optimization)
```
RSI:      { bull: 0.58, bear: 0.54 }
EMA:      { bull: 0.62, bear: 0.59 }
MACD:     { bull: 0.56, bear: 0.53 }
BB:       { bull: 0.55, bear: 0.52 }
StochRSI: { bull: 0.57, bear: 0.55 }
TD:       { bull: 0.54, bear: 0.51 }
Ichimoku: { bull: 0.60, bear: 0.57 }
```

### CROSS_TF_MAP (Elder's Triple Screen layering)
```
'5m':  ['15m', '1h']    -- 3x + 12x
'15m': ['1h', '4h']     -- 4x + 16x
'30m': ['4h', '1d']     -- 8x + 48x
'1h':  ['4h', '1d']     -- 4x + 24x
'4h':  ['1d', '1w']     -- 6x + 42x
'1d':  ['1w']            -- 7x
```

### Probability Engine Constants
- `sigK = 7` (sigmoid steepness)
- Base prob range: 28% to 78% via sigmoid
- `ADJ_CAP = 20` (global contextual adjustment cap)
- Probability floor: 25%, ceiling varies by confidence/quality (max 85%)
- `TRADING_FEE_PCT = 0.06` (BloFin taker fee per side)

### R/R Estimation Constants
- Default stop multiplier: 2.0x ATR
- Min stop: 1.2x ATR, Max stop: 3.0x ATR
- Swing point snapping: within +/-0.5 ATR of structural level
- Target: INVERTED relationship -- high prob = tighter target (2.0x), low prob = wider (3.0x)
- Quality target boost: A-grade = 1.25x, B = 1.0x, C = 0.85x

### Leverage Hard Caps
- High confidence: 10x max
- Medium confidence: 5x max
- Low confidence: 2x max
- Multiplied by mqMult: A=1.0, B=0.8, C=0.5, No-Trade=0

### Market Quality Sizing
- A-grade: 120% of base size
- B-grade: 80%
- C-grade: 50%
- No-Trade: 0% (trade blocked)

### Regime Detection (`detectCurrentRegime`)
```
Bull:     price above EMA200 AND EMA50 above EMA200
Bear:     price below EMA200 AND EMA50 below EMA200
Sideways: everything else
Volatile suffix: recent ATR > 1.3x old ATR
Squeeze suffix:  recent ATR < 0.7x old ATR
```

### Blended Asset Regime
- BTC regime fetched separately as macro proxy
- For most alts: 60% BTC macro + 40% local regime
- For major L1s (ETH, SOL, BNB): 50% BTC + 50% local

### Alert Fatigue Constants
```
globalCooldownMs: 5000     // 5s between any two alerts
burstLimit: 5              // Max 5 alerts per 60s window
burstWindowMs: 60000       // 60s burst window
correlated symbol suppression: 30s window
exact duplicate suppression: 10s window
```

### SSE Backoff
- Initial delay: 5000ms
- Growth factor: 1.5x per retry
- Max delay: 120000ms (2 min)
- Max retries: 20 (then gives up)

---

## 13. RECENT UPGRADES

Based on code comments and version references found throughout:

1. **v2.6 Accuracy Overhaul** (Market Cycle Dashboard): Complete rework of all 12 indicators with research-backed thresholds and the addition of regime-specific calibration.

2. **Cycle 4 Confirmed Data**: Diminishing Returns model updated with confirmed cycle 4 data: $15,500 trough to $126,000 ATH (Oct 6, 2025) = 8.1x.

3. **Family Dampening (Correlation Dampening #1)**: Prevents correlated indicators from inflating confluence. FAMILY_DECAY = [1.0, 0.60, 0.35] for successive aligned signals in same family (meanrev: RSI/StochRSI/BB, trend: EMA/MACD/Ichimoku).

4. **Trend vs Mean-Reversion Conflict Detection**: Mean-reversion signals opposing strong trend get halved before family dampening.

5. **Percentile-Adaptive Funding Rate (#9)**: Funding rate adjustments now use per-asset percentile thresholds (p10/p20/p80/p90/p95) instead of hardcoded values.

6. **Sample Size Guardrails (#6)**: Historical performance adjustment requires minimum 30 trades (was 5). Graduated strength: 30-99 trades = 40% strength, 100+ = full.

7. **Structural Stop Snapping (#4)**: Stop-loss snaps to nearby swing points (within 0.5 ATR) using leftBars=5, rightBars=3 swing detection.

8. **Alert Fatigue Management (#12)**: Global rate limiting, correlated symbol suppression, burst limits, exact duplicate suppression.

9. **WebSocket Price Feed (#5)**: Real-time Binance WebSocket for sub-15m price alerts, with polling fallback.

10. **Cross-TF Strategy Alerts**: Strategy alerts now support multiple timeframes per leg, with higher-TF signal alignment onto base TF timeline.

11. **ETF Flow Integration (#2)**: Institutional flow data from SoSoValue/CoinGlass integrated as Priority 6 contextual adjustment (sub-cap +/-4).

12. **AI Prediction Engine**: Full pipeline with momentum/trend/arbitrage/AI-scored signal types, paper/real mode toggle, SSE streaming.

13. **SL/TP Precision Fix**: Dynamic decimal precision based on asset price for BloFin orders (prevents rounding errors on micro-cap assets).

14. **Per-TF Auto-Trade Rules**: Custom minimum probability and size per timeframe, synced between frontend and server-side scanner.

---

## 14. KNOWN FRONTEND LIMITATIONS & IMPROVEMENT IDEAS

### Architecture Limitations
1. **Single-file monolith**: 24,552 lines in one HTML file. Extremely difficult to maintain, impossible to tree-shake, and the 1.3MB file size creates load time issues.
2. **No build system**: No bundler, minifier, or module system. All code is global scope.
3. **No TypeScript**: Large codebase with no type safety, making refactors risky.
4. **localStorage dependency**: Calibration data, settings, alert state all in localStorage. Risk of data loss on browser reset, no cross-device sync for calibration.

### Data & Computation
5. **200-candle limit**: `probeKlines` fetches only 200 candles. Some indicators (200-day MA on shorter TFs) may not have enough warmup data.
6. **No WebSocket for scan data**: Price data during scans uses REST polling. Could be WebSocket for lower latency.
7. **CORS proxy fallback**: Uses `allorigins.win` as CORS proxy for Binance. This is a third-party service with no SLA -- could fail at any time.
8. **No caching layer**: Each scan fetches fresh klines for all 20 assets. No client-side cache for recently-fetched candle data.
9. **Chart pattern detection is basic**: Pattern detection uses simple heuristics (consecutive candle checks, ratio comparisons). Not competitive with ML-based or more sophisticated geometric pattern recognition.

### Trading Logic
10. **Leverage cap at 3x Phase 1**: Comment says "Phase 1" suggesting higher caps planned. The 3x cap may be too conservative for experienced traders.
11. **Kelly fraction is fractional Kelly only**: Using 0.15-0.6x Kelly. While safer, the graduation steps are somewhat arbitrary.
12. **No trailing stop**: SL is fixed at entry. No mechanism for moving stop to breakeven or trailing.
13. **No partial take-profit**: Single TP target. No ability to take partial profits at intermediate levels.
14. **Cross-asset correlation is simple**: Uses a fixed threshold (3+ same-direction above 60%). Could use actual correlation coefficients.

### UI/UX
15. **No dark/light theme toggle**: Single dark theme only.
16. **No keyboard shortcuts**: All interaction is mouse/touch.
17. **Tab state not persisted**: Switching tabs loses scroll position and form state.
18. **Mobile responsiveness**: While breakpoints exist, the dense data display may be difficult on small screens.

### Reliability
19. **SSE reconnection cap at 20**: After 20 failed reconnections, SSE gives up permanently. User must refresh.
20. **No offline mode**: Application is completely non-functional without network connectivity.
21. **No error boundary**: JavaScript errors in one section can cascade and break the entire page.
22. **Alert WebSocket single connection**: One WebSocket for all alert symbols. If it disconnects during a critical price move, alerts are delayed until 60s poll catches up.

### Suggested Improvements
- Split into modules (at minimum: CSS, HTML structure, each major system as its own JS file)
- Add service worker for offline caching of static assets
- Implement WebSocket for real-time scan updates instead of REST polling
- Add trailing stop / partial TP capability to auto-trade
- Use actual correlation matrices instead of fixed thresholds
- Add candle data caching with TTL based on timeframe
- Consider server-side rendering for initial load performance
- Add comprehensive error boundaries and fallback UI states

---

## APPENDIX: COMPLETE DATA FLOW -- Scan Initiation to Trade Execution

```
1. USER CLICKS "RUN SCAN" (or auto-scan timer fires)
      |
2. runProbEngine() starts
      |-- Reads selected timeframe from UI
      |-- Checks if auto-trade enabled, reads settings
      |-- Fetches BTC klines separately (macro regime proxy)
      |-- detectCurrentRegime(btcData) -> btcRegime
      |
3. FOR EACH of 20 PROBE_ASSETS:
      |-- probeKlines(sym, tf) -> 200 candles (Binance REST, allorigins fallback)
      |-- detectCurrentRegime(assetData) -> localRegime
      |-- Blend: btcWeight * btcRegime + (1-btcWeight) * localRegime
      |     (60/40 for alts, 50/50 for major L1s)
      |
4.    computeLiveSignals(candles, tf)
      |-- Stale candle guard (skip if <85% complete)
      |-- Compute 7 indicators: RSI, EMA, MACD, BB, StochRSI, Ichimoku, Volume
      |-- Each indicator uses regime-adaptive thresholds
      |-- Determine entryEfficiency (Chasing/Late/OK/Excellent)
      |-- Compute marketQuality grade (A/B/C/No-Trade)
      |-- Returns: { signals, atr, price, entryEfficiency, marketQuality }
      |
5.    detectChartPatterns(candles, tf, regime) [optional]
      |-- Scans for 10 pattern types
      |-- Scores with TF weight * stage weight * volume mod * regime mod
      |-- Composite with diminishing returns
      |-- Returns: patternAdjustment (capped +/-15%)
      |
6.    fetchCrossTFBias(sym, baseTf) [if CROSS_TF_MAP has entries]
      |-- Fetches klines for higher TFs (e.g., 4h + 1d for a 1h scan)
      |-- quickTrendBias(higherTFData) per TF
      |-- Returns: [{ tf, bull, bear, strength, rsi, emaBull, priceAboveEMA200, macdBull }]
      |
7.    scoreConfluence(signals, direction, regime, fundingRate, tf, crossTFData, mq, etf)
      |-- TF-aware indicator weights (short/med/long TF profiles)
      |-- Family dampening (FAMILY_DECAY [1.0, 0.60, 0.35])
      |-- Trend vs mean-reversion conflict detection
      |-- Score each indicator with dampening applied
      |-- BB squeeze bonus (+8), volume drying penalty (-5)
      |-- Raw confluence = score / maxScore (0-1)
      |-- Base prob: sigmoid mapping -> 28% to 78%
      |--   prob = 28 + 50 / (1 + exp(-7 * (confluence - 0.5)))
      |-- Priority Waterfall (global cap +/-20):
      |     P1: Cross-TF alignment (sub-cap +/-14)
      |     P2: Regime adjustment (sub-cap +/-4)
      |     P3: Funding rate - percentile adaptive (sub-cap +/-4)
      |     P4: Historical performance (sub-cap +/-6, min 30 trades)
      |     P5: Personal optimizer (sub-cap +/-4)
      |     P6: ETF flow bias (sub-cap +/-4, 1h+ only)
      |-- Confidence: High >= 0.38, Medium >= 0.22, Low < 0.22
      |-- Probability caps by confidence + quality (max 85, floor 25)
      |-- Returns: { prob, confluence, confidence, hits, misses }
      |
8.    estimateRR(price, atr, direction, prob, leverage, confidence, candles, mq, regime)
      |-- Stop: 2.0x ATR, snap to swing points (+/-0.5 ATR)
      |-- Clamp: min 1.2x ATR, max 3.0x ATR
      |-- Target: INVERTED (high prob = 2.0x, low prob = 3.0x)
      |-- Quality boost: A=1.25x, B=1.0x, C=0.85x
      |-- Deduct fees: 2 * 0.06% from target
      |-- Kelly fraction: graduated by quality + confidence (0.15-0.6x)
      |-- Leverage caps: High=10x, Med=5x, Low=2x (* mqMult)
      |-- Returns: { rr, stop, target, kelly, suggestedLeverage, ev }
      |
9.    Apply post-processing:
      |-- Entry efficiency penalty: Chasing = -10%, Late = -5%
      |-- Leverage penalty: 3.3 * pow(leverage, 0.75) - 3.3
      |-- Cross-asset correlation discount (3+ same direction > 60%)
      |-- Record calibration prediction
      |
10. renderProbeResults(allResults)
      |-- Sort by probability descending
      |-- Render regime banner
      |-- Render each asset as a scan card
      |
11. IF AUTO-TRADE ENABLED: processAutoTrades(results, tf)
      |-- Filter: prob >= minProb, not No-Trade, not Chasing, EV > 0
      |-- Check balance, open positions < max
      |-- Apply mqSizeMult to trade size
      |
12.   IF mode === 'auto': autoExecDirect(trade)
      |-- Precision-fix SL/TP prices
      |-- Quality gate: non-A capped at 1x leverage, all capped at 3x
      |-- POST to BACKEND_URL + '/blofin/place-order'
      |-- { instId, side, orderType:'market', sizeUsd, leverage, marginMode:'cross', slPrice, tpPrice }
      |
      IF mode === 'confirm': show notification popup (30s auto-dismiss)
```
