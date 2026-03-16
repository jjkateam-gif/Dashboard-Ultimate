# Degen Scanner — Complete Logic Documentation
## Solana Meme Coin Scanner & Auto-Trade Engine

---

## Architecture Overview

The Degen Scanner runs entirely client-side (no backend required). It sources data from two public APIs:
- **DexScreener** — token profiles, pair data, volume, price changes, liquidity, socials
- **RugCheck** — contract safety analysis, holder concentration, LP status, insider detection

The scanner evaluates Solana meme coins on a 0-100 "Degen Score" combining market metrics, safety checks, narrative matching, and pattern recognition. It includes:
- Tier-based classification (1000x / 100x / 20x / 10x potential)
- Probability estimation for 2x, 5x, and 10x returns
- Adaptive learning engine that adjusts weights based on historical outcomes
- Smart money wallet tracking
- Auto-trade system with configurable filters
- DNA pattern matching against successful historical meme coins

---

## Step 1: Data Sourcing & Token Discovery

Three parallel sources feed the scanner:

1. **Token Profiles** (`/token-profiles/latest/v1`) — newest Solana tokens with metadata, up to 100
2. **Boosted Tokens** (`/token-boosts/top/v1`) — tokens that have paid for DexScreener promotion, up to 60
3. **Trending Search** (`/latest/dex/search?q=solana+meme&limit=30`) — DexScreener trending results

All addresses are deduplicated into a single set, then enriched in batches of 29 via DexScreener's token endpoint to get full pair data (volume, liquidity, price changes, transaction counts, socials).

### Pre-filtering (before scoring)
Tokens must pass minimum thresholds:
- Liquidity >= $3,000
- 24h Volume >= $500
- Age >= 0.5 hours (30 minutes)
- Market Cap <= $500,000,000

---

## Step 2: Core Scoring — `clientScoreToken()` (0-100 scale)

Each token is scored across 12 dimensions. Points are additive with both bonuses and penalties.

### 2a. Liquidity (max +18, min -20)
| Condition | Points | Signal |
|-----------|--------|--------|
| $50K–$500K | +18 | Strong liquidity |
| $10K–$50K | +12 | Good liquidity |
| $5K–$10K | +6 | Thin liquidity |
| < $5K | -20 | Too thin |

### 2b. Volume/Market Cap Ratio (age-adjusted, max +25, min -12)
The Vol/Mcap ratio thresholds are adjusted based on token age — the same ratio means less as a token matures.

| Age | Legendary | Strong | Good | Weak |
|-----|-----------|--------|------|------|
| < 48h | 10x | 6x | 3x | 1x |
| >= 48h | 4x | 2x | 1x | 0.5x |

| Condition | Points | Signal |
|-----------|--------|--------|
| >= Legendary | +25 | Extreme vol/mcap |
| >= Strong | +20 | High vol/mcap |
| >= Good | +13 | Good vol/mcap |
| >= Weak | +6 | — |
| < Weak | -12 | Dead volume |

### 2c. Volume Acceleration (max +15, min -12)
Compares 1h volume run-rate vs 6h average run-rate (both annualised to 24h equivalent).
- `volAccel = (vol1h × 24) / ((vol6h / 6) × 24)`

| Condition | Points | Signal |
|-----------|--------|--------|
| >= 2.5x | +15 | Volume surging |
| >= 1.5x | +8 | Volume building |
| < 0.3x | -12 | Volume dying |
| < 0.6x | -5 | Volume fading |

### 2d. Wash Trade Detection (max +12, min -18)
Uses average volume per transaction as a proxy for real vs bot activity.
- `volPerTx = vol24h / totalTransactions24h`

| Avg $/tx | Points | Signal |
|----------|--------|--------|
| < $200 | +12 | Retail crowd |
| $200–$800 | +6 | — |
| $5K–$15K | -8 | Large avg tx — possible wash |
| > $15K | -18 | BOT VOLUME |

**Transaction density bonus:**
| Tx count (24h) | Points | Signal |
|----------------|--------|--------|
| > 2,000 | +8 | High tx count |
| > 500 | +4 | — |
| < 30 (with vol > $50K) | -12 | Suspicious volume |

**Buy/sell symmetry check:** If buys and sells are >95% equal AND >50 transactions in 1h → -15 pts ("possible wash trading")

### 2e. Buy Pressure (max +22, min -15)
1h buy ratio = buys / (buys + sells)

| Buy Ratio | Points | Signal |
|-----------|--------|--------|
| >= 90% | +8 | Warning: possibly manipulated |
| 75–89% | +22 | Dominant buying |
| 65–74% | +15 | Strong buy pressure |
| 55–64% | +7 | — |
| < 40% | -15 | Sell pressure |

**24h consistency bonus:** If 24h buy ratio >= 60% AND 1h buy ratio >= 65% → +6 ("Sustained buy demand")

### 2f. Age Sweet Spot (max +18, min -25)
Research finding: optimal meme coin entry is 4–12 hours post-listing.

| Age | Points | Signal |
|-----|--------|--------|
| < 30 min | -25 | Too new — sniper risk |
| 1–4h | +10 | Early |
| 4–12h | +18 | SWEET SPOT |
| 12–48h | +6 | Still early |
| 48h–7d | +2 | — |
| > 7d | -10 | Aged |

### 2g. Market Cap Band (max +18, min -12)
| Market Cap | Points | Signal |
|------------|--------|--------|
| < $100K | +18 | Micro-cap |
| $100K–$500K | +14 | Sub-500K |
| $500K–$2M | +10 | Sub-2M |
| $2M–$10M | +5 | — |
| > $100M | -12 | Large mcap — limited upside |

### 2h. Price Momentum (max +24)
| Condition | Points |
|-----------|--------|
| 1h > +30% | +14 |
| 1h > +10% | +8 |
| 1h < -25% | -12 |
| 24h > +100% | +10 |
| 24h > +50% | +6 |
| 24h < -50% | -8 |
| 1h > +5% AND 24h > +20% | +5 (momentum aligned) |

### 2i. Social Presence (max +12, min -10)
| Socials | Points | Signal |
|---------|--------|--------|
| Twitter + Telegram + Website | +12 | Full social presence |
| Twitter + Telegram | +8 | — |
| Twitter OR Telegram | +4 | — |
| None | -10 | No socials found |

**Social velocity proxy:** New token (<24h) with full socials AND >1000 tx → +8 ("Social velocity"). Token <48h with Twitter AND >500 tx → +4.

### 2j. Narrative Theme Matching (max +20, min -4)
Matches token symbol + name against current Solana meta themes:

| Theme | Weight | Keywords |
|-------|--------|----------|
| AI Agents | 20 | ai, agent, gpt, llm, neural, goat, truth, agi, claude, gemini, robot, bot, compute, gpu |
| Political | 16 | trump, maga, usa, america, potus, president, elon, doge, tesla |
| Dog Coin | 14 | dog, doge, wif, shib, puppy, pup, inu, hound |
| Cat Coin | 14 | cat, kitty, popcat, nyan, meow, feline |
| Frog/Pepe | 12 | pepe, frog, ribbit, kek, feels, apu |
| Viral Moment | 12 | kim, jong, grok, openai, sam, altman, nvidia, apple, blackrock |
| Food Meme | 10 | burger, pizza, taco, fart, poop, bonk, glizzy, tendies |
| Anime | 10 | anime, waifu, chan, kun, senpai, otaku, manga, neko |
| Sol Native | 8 | sol, solana, phantom, raydium, jupiter |

Scoring: Takes the highest matching theme weight (doesn't stack). If 2+ themes match, adds +4 bonus (capped at 20). No narrative match = -4.

### 2k. 72h Survival Bonus (max +8)
Research: 68% of Solana tokens rug within 72 hours.
- Age 72h–7d with liquidity > $10K → +8
- Age > 7d with liquidity > $10K → +5

### 2l. CEX Listing Signal (+12)
If token's website URLs reference Binance, Coinbase, Bybit, or OKX → +12

### 2m. DNA Pattern Matching
Compares token metrics against profiles of historically successful meme coins:

| DNA Template | Conditions | Confidence |
|-------------|------------|------------|
| FARTCOIN | Vol/Mcap >= 8, Buy ratio >= 73% | High |
| WIF | Vol/Mcap >= 4, Buy ratio >= 65%, Mcap < $2M | High |
| PNUT | Buy ratio >= 65%, 1h change > 15%, Age < 48h | Medium |
| POPCAT | Liquidity >= $80K, Buy ratio >= 68%, Vol/Mcap >= 3 | Medium |
| BONK | Vol/Mcap >= 10, Buy ratio >= 70%, Mcap < $100K | High |
| TRUMP | Vol/Mcap >= 3, Buy ratio >= 60%, Age < 24h, Liq >= $500K | High |
| GOAT | Vol/Mcap >= 5, Buy ratio >= 65%, Mcap < $5M, AI narrative | Medium |
| BOME | Vol/Mcap >= 6, Buy ratio >= 70%, Age < 72h, Mcap < $10M | Medium |
| MEW | Buy ratio >= 62%, Liq >= $50K, Tx > 1000, 1h > -5% | Medium |
| AI16Z | Vol/Mcap >= 3, Buy ratio >= 60%, Twitter + TG, AI narrative | Medium |

Final score is clamped to 0-100.

---

## Step 3: RugCheck Safety Enrichment

Top 15 scored tokens get a full RugCheck report. The `parseRugReport()` function extracts:

- **Kill flags**: Active mint authority, freeze authority, honeypot, blacklist, high insider — any of these = rug risk
- **LP status**: Burned (best) / Locked / Neither
- **Holder concentration**: Top 10 holder %, Top 1 holder %
- **Insider networks**: Total insider wallet percentage
- **Dev wallet**: Whether creator/dev is actively selling
- **Contract status**: Mint revoked, Freeze revoked

### Safety Score Adjustments (applied post-scoring):

| Condition | Score Impact |
|-----------|-------------|
| Kill flags present (rug.passed = false) | -30 |
| LP Burned | +18 |
| LP Locked | +10 |
| LP not locked/burned | -8 |
| Top 10 holders < 20% | +15 |
| Top 10 holders < 35% | +8 |
| Top 10 holders 50-65% | -10 |
| Top 10 holders > 65% | -22 (WHALE TRAP) |
| Single whale > 15% supply | -12 |
| Insider wallets > 20% | -15 |
| Dev wallet selling | -20 |
| Honeypot detected | -40 |
| High sell tax (> 20%) | -25 |
| Clean contract (rug score < 100) | Signal only |
| Mint authority revoked | Signal only |
| Freeze authority revoked | Signal only |

A token "passes" RugCheck if: zero kill flags AND rug score < 700.

---

## Step 4: Tier Classification

Tokens are assigned to upside potential tiers based on market cap AND score:

| Tier | Market Cap | Min Score |
|------|-----------|-----------|
| 🚀 1000x | < $200K | 60 |
| 💎 100x | < $200K (score 25-59) OR < $2M (score >= 50) | 25/50 |
| ⚡ 20x | < $2M (score 25-49) OR < $15M (score >= 40) | 25/40 |
| 📈 10x | < $75M (score >= 35) OR any (score >= 35) | 35 |

Tokens with score < 25 are excluded entirely.

Each tier is sorted by Degen Score descending. Tokens are also grouped by listing age: 2h, 24h, 7d, 30d windows.

---

## Step 5: Probability Estimation — `calcMemeProbability()`

Produces three probability estimates: P(2x), P(5x), P(10x).

### Base probability (sigmoid curve from Degen Score)
```
base2x  = sigmoid(0.08 × (score - 55))   // 50% probability at score 55
base5x  = sigmoid(0.08 × (score - 70))   // 50% probability at score 70
base10x = sigmoid(0.08 × (score - 82))   // 50% probability at score 82
```

### Historical adjustment
Uses P100 (Perfect 100) and Watchlist token history. When 5+ tracked tokens exist:
- Calculates actual hit rates for 2x, 5x, 10x milestones
- Blends learned rates with base using weight = min(0.5, tokenCount / 40)

### Feature-specific boosts (scaled by adaptive weights)
| Feature | Condition | Boost |
|---------|-----------|-------|
| Vol/Mcap >= 8 | Strong flow | +6% × adaptiveWeight(volMcap) |
| Buy % >= 73% | Dominant buying | +5% × adaptiveWeight(buyRatio) |
| Age 4-12h | Sweet spot | +4% × adaptiveWeight(age) |
| Liquidity $50K-$500K | Goldilocks zone | +3% |
| Mcap < $100K | Micro-cap | +5% × adaptiveWeight(mcap) |
| Buy % < 50% | Sell pressure | -8% × adaptiveWeight(buyRatio) |
| Vol/Mcap < 0.5 | Dead | -6% × adaptiveWeight(volMcap) |
| Age > 7d | Old | -4% × adaptiveWeight(age) |

### Final probability (clamped)
```
P(2x)  = clamp(2-95%,  (base2x  + historicalAdj + boost) × 100)
P(5x)  = clamp(1-85%,  (base5x  + historicalAdj + boost × 0.7) × 100)
P(10x) = clamp(1-70%,  (base10x + historicalAdj + boost × 0.5) × 100)
```

---

## Step 6: Adaptive Learning Engine (EWMA-based)

### Feature Buckets
The engine tracks success rates across 4 features, each with 3 buckets:

| Feature | Buckets |
|---------|---------|
| Vol/Mcap | Low (<2), Medium (2-6), High (>=6) |
| Buy Ratio | Weak (<60%), Good (60-73%), Strong (>=73%) |
| Age | Early (<12h), Mid (12-48h), Old (>=48h) |
| Market Cap | Micro (<$100K), Small ($100K-$1M), Large (>=$1M) |

### Learning Process
1. When a tracked token (P100, Watchlist, or Bought) reaches milestone age checkpoints (1h, 6h, 24h, 7d):
   - Record which milestones were hit (2x, 5x, 10x)
   - Update EWMA-smoothed rates per bucket: `rate = α × outcome + (1-α) × previous_rate`
   - α = 0.5 for first 5 samples (fast learning), then 0.2 (standard EWMA)
2. Recalculate weight multipliers: `weightMult = bestBucketRate / baselineRate`
3. Weight multipliers are clamped to [0.5, 2.0]
4. These weights flow back into `calcMemeProbability()` as adaptive multipliers

### Prediction Accuracy Tracking
Each pending outcome records the predicted score vs actual outcome:
- Hit 10x → actual = 90
- Hit 5x → actual = 70
- Hit 2x → actual = 50
- No hit → actual = 20

Average absolute error is tracked over the last 100 predictions.

---

## Step 7: Smart Money Tracker

### Wallet Learning
When a tracked token hits 5x+ milestone, the system:
1. Tags the token as a "winner"
2. Stores its top early holders as "smart wallets" (localStorage)
3. Cross-references new tokens against known smart wallets

### Smart Money Check
For new tokens, checks if any of their top holders appear in the smart wallet database. Returns count and wallet details for display.

---

## Step 8: Auto-Trade System

### Configurable Filters
| Parameter | Default | Description |
|-----------|---------|-------------|
| Enabled | OFF | Master toggle |
| Mode | Notify | notify / open_jup (auto-open Jupiter swap) |
| Min Degen Score | 90 | Minimum score to trigger |
| Min P(2x) | 70% | Minimum 2x probability |
| Max Market Cap | $500K | Maximum market cap |
| Min Buy % | 65% | Minimum 1h buy ratio |
| Min Vol/Mcap | 3x | Minimum volume/mcap ratio |
| Max Open | 3 | Maximum concurrent auto-trade positions |

### Trigger Logic
A token triggers auto-trade when ALL conditions are met:
1. Auto-trade is enabled
2. Token hasn't already been bought
3. Token hasn't already been triggered in this session
4. Degen Score >= minScore
5. P(2x) >= minProb
6. Market Cap <= maxMcap
7. Buy % >= minBuy
8. Vol/Mcap >= minVMR
9. Open positions < maxOpen

### Actions on Trigger
1. Log the trade trigger (localStorage, capped at 50 entries)
2. Show toast notification
3. Send browser notification (if permission granted)
4. If mode = "open_jup": auto-open Jupiter swap page for SOL → token

---

## Step 9: Scan Lifecycle

1. **Discovery**: Fetch token profiles + boosted + trending from DexScreener (3 parallel calls)
2. **Dedup**: Merge all addresses into unique set
3. **Enrichment**: Batch-fetch full pair data from DexScreener (29 at a time, 250ms delay between batches)
4. **Pre-filter**: Remove tokens below liquidity/volume/age/mcap thresholds
5. **Score**: Run `clientScoreToken()` on all passing tokens → sort by score
6. **RugCheck**: Top 15 tokens get full RugCheck report (150ms delay between API calls)
7. **Safety Adjust**: Apply rug-based score adjustments (LP, holders, dev, honeypot)
8. **Tier Build**: Classify into 1000x/100x/20x/10x tiers
9. **Post-processing**:
   - Check sell alerts for bought positions
   - Auto-capture perfect-100 tokens
   - Refresh P100 prices
   - Check auto-trade rules
   - Process adaptive learning outcomes
   - Fire scan-based alert rules
   - Check hall-of-fame 100x promotions
10. **Render**: Display results in tier cards with full signal breakdown
11. **Auto-refresh**: Repeats every 5 minutes

---

## Summary of Signal Weights (Maximum Contributions)

| Category | Max Positive | Max Negative |
|----------|-------------|-------------|
| Liquidity | +18 | -20 |
| Vol/Mcap Ratio | +25 | -12 |
| Volume Acceleration | +15 | -12 |
| Wash Trade Detection | +20 | -30 |
| Buy Pressure | +28 | -15 |
| Age Sweet Spot | +18 | -25 |
| Market Cap Band | +18 | -12 |
| Price Momentum | +24 | -20 |
| Social Presence | +20 | -10 |
| Narrative Match | +20 | -4 |
| 72h Survival | +8 | 0 |
| CEX Listing | +12 | 0 |
| **RugCheck (post)** | +33 | -97 |
| **Total Theoretical** | +259 | -257 |
| **Actual Range** | 0-100 (clamped) | |

---

## Tier Display Labels
| Score Range | Tier Label |
|-------------|-----------|
| >= 78 | 🔥 HOT |
| 58-77 | ⚡ WATCH |
| 38-57 | 👀 RADAR |
| < 38 | 💀 SKIP |
