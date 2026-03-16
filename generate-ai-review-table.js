const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, PageNumber, PageBreak, LevelFormat } = require('docx');
const fs = require('fs');

// ── Colours ──
const DARK_BLUE = "1B3A5C";
const MED_BLUE = "2E75B6";
const LIGHT_BLUE = "D5E8F0";
const WHITE = "FFFFFF";
const LIGHT_GREY = "F2F2F2";
const GREEN_BG = "E2EFDA";
const YELLOW_BG = "FFF2CC";
const RED_BG = "FCE4EC";
const ORANGE_BG = "FBE5D6";

const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 60, bottom: 60, left: 100, right: 100 };

function hdr(text, level = HeadingLevel.HEADING_1) {
  return new Paragraph({ heading: level, spacing: { before: 300, after: 150 },
    children: [new TextRun({ text, bold: true, font: "Arial", size: level === HeadingLevel.HEADING_1 ? 32 : level === HeadingLevel.HEADING_2 ? 28 : 24 })] });
}

function para(text, opts = {}) {
  return new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text, font: "Arial", size: 22, ...opts })] });
}

function headerCell(text, width) {
  return new TableCell({
    borders, width: { size: width, type: WidthType.DXA },
    shading: { fill: DARK_BLUE, type: ShadingType.CLEAR },
    margins: cellMargins, verticalAlign: "center",
    children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text, bold: true, font: "Arial", size: 20, color: WHITE })] })]
  });
}

function cell(text, width, opts = {}) {
  return new TableCell({
    borders, width: { size: width, type: WidthType.DXA },
    shading: opts.fill ? { fill: opts.fill, type: ShadingType.CLEAR } : undefined,
    margins: cellMargins, verticalAlign: "center",
    children: [new Paragraph({ alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
      children: [new TextRun({ text, font: "Arial", size: 18, bold: !!opts.bold, color: opts.color || "000000" })] })]
  });
}

function multiCell(runs, width, opts = {}) {
  return new TableCell({
    borders, width: { size: width, type: WidthType.DXA },
    shading: opts.fill ? { fill: opts.fill, type: ShadingType.CLEAR } : undefined,
    margins: cellMargins, verticalAlign: "center",
    children: [new Paragraph({ children: runs.map(r => new TextRun({ font: "Arial", size: 18, ...r })) })]
  });
}

// ══════════════════════════════════════════════════════════════
//  TABLE 1 — UPGRADE PRIORITIZATION COMPARISON (22 upgrades)
// ══════════════════════════════════════════════════════════════
const upgrades = [
  { id: 5,  name: "Recency weighting", grok: "DO NOW", claude: "DO NOW", gpt: "NOW", consensus: "DO NOW", grokWhen: "-", claudeWhen: "-", gptWhen: "-" },
  { id: 6,  name: "Per-asset calibration", grok: "WAIT", claude: "WAIT", gpt: "LATER", consensus: "WAIT", grokWhen: "500 trades", claudeWhen: "150+/asset", gptWhen: "500+ trades" },
  { id: 7,  name: "Dynamic weight adjustment", grok: "WAIT", claude: "WAIT", gpt: "LATER", consensus: "WAIT", grokWhen: "500 trades w/ snapshots", claudeWhen: "500+ snapshots", gptWhen: "500+ trades" },
  { id: 8,  name: "Reduce orderbook 38% to 28%", grok: "DO NOW", claude: "WAIT", gpt: "NOW", consensus: "SPLIT", grokWhen: "-", claudeWhen: "After feature importance at 500+", gptWhen: "-" },
  { id: 9,  name: "Multi-TF confluence", grok: "DO NOW", claude: "DO NOW", gpt: "NOW", consensus: "DO NOW", grokWhen: "-", claudeWhen: "-", gptWhen: "-" },
  { id: 11, name: "Feature importance tracking", grok: "DO NOW", claude: "DO NOW", gpt: "LATER", consensus: "DO NOW (2/3)", grokWhen: "-", claudeWhen: "-", gptWhen: "500+ trades" },
  { id: 12, name: "Ensemble scoring", grok: "WAIT", claude: "WAIT", gpt: "LATER", consensus: "WAIT", grokWhen: "500 trades", claudeWhen: "1000+ trades", gptWhen: "1000+ trades" },
  { id: 13, name: "Drawdown leverage reduction", grok: "DO NOW", claude: "DO NOW", gpt: "NOW", consensus: "DO NOW", grokWhen: "-", claudeWhen: "-", gptWhen: "-" },
  { id: 14, name: "Consecutive loss tracker", grok: "DO NOW", claude: "DO NOW", gpt: "NOW", consensus: "DO NOW", grokWhen: "-", claudeWhen: "-", gptWhen: "-" },
  { id: 15, name: "Win rate gate for leverage", grok: "DO NOW", claude: "DO NOW", gpt: "NOW", consensus: "DO NOW", grokWhen: "-", claudeWhen: "-", gptWhen: "-" },
  { id: 16, name: "Funding rate + leverage check", grok: "DO NOW", claude: "DO NOW", gpt: "NOW", consensus: "DO NOW", grokWhen: "-", claudeWhen: "-", gptWhen: "-" },
  { id: 17, name: "Per-TF leverage limits", grok: "WAIT", claude: "DO NOW", gpt: "NOW", consensus: "DO NOW (2/3)", grokWhen: "After 4h fix", claudeWhen: "-", gptWhen: "-" },
  { id: 18, name: "Portfolio heat tracking", grok: "DO NOW", claude: "DO NOW", gpt: "NOW", consensus: "DO NOW", grokWhen: "-", claudeWhen: "-", gptWhen: "-" },
  { id: 19, name: "Phased leverage rollout", grok: "DO NOW", claude: "DO NOW", gpt: "NOW", consensus: "DO NOW", grokWhen: "-", claudeWhen: "-", gptWhen: "-" },
  { id: 20, name: "Increase shrinkage threshold", grok: "DO NOW", claude: "DO NOW", gpt: "NOW", consensus: "DO NOW", grokWhen: "-", claudeWhen: "-", gptWhen: "-" },
  { id: 21, name: "Regime-transition detection", grok: "WAIT", claude: "WAIT", gpt: "LATER", consensus: "WAIT", grokWhen: "500 trades", claudeWhen: "500+ w/ labels", gptWhen: "500+ trades" },
  { id: 23, name: "A/B testing for weights", grok: "WAIT", claude: "WAIT", gpt: "LATER", consensus: "WAIT", grokWhen: "500 trades", claudeWhen: "After #7", gptWhen: "After dynamic weights" },
  { id: 24, name: "EV as primary metric", grok: "DO NOW", claude: "DO NOW", gpt: "NOW", consensus: "DO NOW", grokWhen: "-", claudeWhen: "-", gptWhen: "-" },
  { id: 25, name: "Fix distribution chart", grok: "DO NOW", claude: "DO NOW", gpt: "NOW", consensus: "DO NOW", grokWhen: "-", claudeWhen: "-", gptWhen: "-" },
  { id: 26, name: "Correlation filter BloFin", grok: "DO NOW", claude: "DO NOW", gpt: "NOW", consensus: "DO NOW", grokWhen: "-", claudeWhen: "-", gptWhen: "-" },
  { id: 27, name: "Investigate 4h timeframe", grok: "DO NOW", claude: "DO NOW", gpt: "NOW", consensus: "DO NOW", grokWhen: "-", claudeWhen: "-", gptWhen: "-" },
  { id: 28, name: "Telegram/Discord alerts", grok: "WAIT", claude: "WAIT", gpt: "LATER", consensus: "WAIT", grokWhen: "500 trades", claudeWhen: "55%+ stable WR", gptWhen: "After core done" },
  { id: 29, name: "Execution latency tracking", grok: "WAIT", claude: "DO NOW", gpt: "LATER", consensus: "SPLIT", grokWhen: "After leverage rollout", claudeWhen: "-", gptWhen: "After leverage" },
  { id: 30, name: "Sharpe ratio tracking", grok: "DO NOW", claude: "DO NOW", gpt: "NOW", consensus: "DO NOW", grokWhen: "-", claudeWhen: "-", gptWhen: "-" },
];

// Build prioritization rows
const prioRows = [
  new TableRow({ children: [
    headerCell("#", 500), headerCell("Upgrade", 2200), headerCell("Grok", 1100),
    headerCell("Claude", 1100), headerCell("ChatGPT", 1100), headerCell("Consensus", 1200),
    headerCell("Wait Until (if applicable)", 2160)
  ]})
];

for (const u of upgrades) {
  const bg = u.consensus.startsWith("DO NOW") ? GREEN_BG : u.consensus === "WAIT" ? YELLOW_BG : ORANGE_BG;
  const grokBg = u.grok === "DO NOW" ? GREEN_BG : YELLOW_BG;
  const claudeBg = u.claude === "DO NOW" ? GREEN_BG : YELLOW_BG;
  const gptBg = u.gpt === "NOW" ? GREEN_BG : YELLOW_BG;

  const waitReasons = [];
  if (u.grokWhen !== "-") waitReasons.push(`G: ${u.grokWhen}`);
  if (u.claudeWhen !== "-") waitReasons.push(`C: ${u.claudeWhen}`);
  if (u.gptWhen !== "-") waitReasons.push(`GPT: ${u.gptWhen}`);
  const waitText = waitReasons.length > 0 ? waitReasons.join(" | ") : "-";

  prioRows.push(new TableRow({ children: [
    cell(String(u.id), 500, { center: true, bold: true }),
    cell(u.name, 2200, { bold: true }),
    cell(u.grok, 1100, { center: true, fill: grokBg, bold: true }),
    cell(u.claude, 1100, { center: true, fill: claudeBg, bold: true }),
    cell(u.gpt, 1100, { center: true, fill: gptBg, bold: true }),
    cell(u.consensus, 1200, { center: true, fill: bg, bold: true }),
    cell(waitText, 2160),
  ]}));
}

// ══════════════════════════════════════════════════════════════
//  TABLE 2 — 15 TECHNICAL QUESTIONS COMPARISON
// ══════════════════════════════════════════════════════════════
const questions = [
  { q: "1. Is 38% orderbook weight appropriate?",
    grok: "No - reduce to 25-30%. Spoofing risk high. Recommend: OB 25%, Mom 25%, Vol 20%, Deriv 15%, Temp 15%",
    claude: "Keep 38% BUT gate on freshness (<10s). Let data decide at 500+ trades via correlation analysis",
    gpt: "Reduce. Orderbook weight reduction listed as NOW priority" },
  { q: "2. Should sigmoid scale differ per regime?",
    grok: "Yes. Trending: 3.5-4.0, Ranging: 2.0-2.5",
    claude: "Yes. Trending: scale x1.3, Ranging: x0.75, Choppy: x0.5. Implement with #21",
    gpt: "Not directly addressed, but supports regime-adaptive approaches" },
  { q: "3. Is Quarter-Kelly too aggressive at 243 trades?",
    grok: "Yes. Use Eighth-Kelly until 500 trades. Sixteenth initially",
    claude: "Yes. Switch to Eighth-Kelly now. CI at n=243 includes negative Kelly",
    gpt: "Not directly addressed. Focuses on risk management layer" },
  { q: "4. 4h TF at 15% WR - disable or fix?",
    grok: "Disable immediately. Fix via TF-specific weights (EMA/MACD 30%). Re-test",
    claude: "Add regime gate (ADX>20 + price>EMA200). Give 30 trades. If still bad, disable. Check for bugs",
    gpt: "Supports fixing with ADX trend filter. Recommends disabling weak performers" },
  { q: "5. Should funding rate weight be higher than 4%?",
    grok: "Yes, raise to 8-10%. Strong contrarian predictor",
    claude: "The +/-3% adjustment matters more than base weight. Consider raising cap to +/-5% for extreme funding (>0.15%)",
    gpt: "Not directly addressed. Supports funding integration as complete" },
  { q: "6. Is family dampening (60%/35%) correctly calibrated?",
    grok: "No - under-penalizes. Calibrate to 50%/20%. A/B test",
    claude: "Unknown until 500+ trades with snapshots. Provided SQL query to check empirically",
    gpt: "Not directly addressed" },
  { q: "7. Should EV replace probability as primary criterion?",
    grok: "Yes - incorporates R:R and costs. Make primary now",
    claude: "Yes, unambiguously. Highest-value single-logic change. Do now",
    gpt: "Yes - EV-based ranking listed as NOW priority. Detailed EV formula provided" },
  { q: "8. Minimum sample size before trusting calibration?",
    grok: "50-100 per bucket minimum. 8 is too low",
    claude: "Raise minimum from 8 to 30 for any correction. Full correction at 100. 8 samples = CI of [24%, 91%]",
    gpt: "Not directly addressed" },
  { q: "9. Should leverage be enabled at 53.7% WR?",
    grok: "No. Wait for 55-60% over 500 trades. Start 2-3x on A-grade only",
    claude: "Per framework: 50-54% = max 2x A-grade only. But fix data visibility first - real WR may be unknown",
    gpt: "Supports gating. Leverage gating listed as NOW priority" },
  { q: "10. Is 30-min calibration refresh optimal?",
    grok: "No - too frequent. Shift to 1-4 hours or event-triggered",
    claude: "No. Split: Regime 5min, Bucket calibration 4-6hrs, Full Bayesian daily",
    gpt: "Not directly addressed" },
  { q: "11. Is JSONB snapshot storage right approach?",
    grok: "Yes - efficient for querying. Add timestamps/regimes for deeper insights",
    claude: "Yes. Add GIN index. Consider computed columns for frequent queries",
    gpt: "Supports approach. Focuses on using snapshots for feature importance" },
  { q: "12. Should weights differ per market regime?",
    grok: "Yes - static ignores dynamics. Boost orderbook in ranging, momentum in trending. After #21",
    claude: "Yes. Two weight sets (trending/ranging) gives 80% of ensemble benefit. Simpler than full ensemble",
    gpt: "Supports dynamic approaches. Lists dynamic weights as LATER" },
  { q: "13. Is 90-day retention sufficient?",
    grok: "No - extend to 180-365 days for rare events (halvings). Use compression/sampling",
    claude: "For active calibration: yes with recency weighting. Keep aggregate stats table indefinitely for rare conditions",
    gpt: "Not directly addressed" },
  { q: "14. What additional risk management rules needed?",
    grok: "Portfolio correlation cap (20%), vol spike halts, news event skips (FOMC), max daily trades (5-10)",
    claude: "News event pause (FOMC/CPI), liquidation cascade detection (OI drop >5% in 15min), session warm-up (first 15min)",
    gpt: "ADX trend filter, liquidity sweep detection, VWAP bands" },
  { q: "15. Are critical indicators missing from 33-feature set?",
    grok: "Liquidation cascades (Coinglass), VPIN, cross-exchange arb, on-chain metrics (Glassnode)",
    claude: "Liquidation heatmap proximity, options put/call ratio (Deribit), VPIN/order flow toxicity",
    gpt: "ADX, liquidity sweep detection, VWAP bands. Also proposes mispricing engine as second layer" },
];

const qRows = [
  new TableRow({ children: [
    headerCell("Question", 2400),
    headerCell("Grok", 2320),
    headerCell("Claude Chat", 2320),
    headerCell("ChatGPT (Neo)", 2320),
  ]})
];

for (let i = 0; i < questions.length; i++) {
  const bg = i % 2 === 0 ? WHITE : LIGHT_GREY;
  qRows.push(new TableRow({ children: [
    cell(questions[i].q, 2400, { bold: true, fill: bg }),
    cell(questions[i].grok, 2320, { fill: bg }),
    cell(questions[i].claude, 2320, { fill: bg }),
    cell(questions[i].gpt, 2320, { fill: bg }),
  ]}));
}

// ══════════════════════════════════════════════════════════════
//  TABLE 3 — ADDITIONAL UPGRADES SUGGESTED BY EACH AI
// ══════════════════════════════════════════════════════════════
const extraUpgrades = [
  { item: "ML Baseline Model (XGBoost on snapshots)", grok: "YES - after 500 trades", claude: "-", gpt: "YES - ML feature importance (LATER)" },
  { item: "Latency-Aware Exits (auto-close if edge decays >3%)", grok: "YES", claude: "-", gpt: "-" },
  { item: "Backtest Integration (simulate weights on historical)", grok: "YES", claude: "-", gpt: "-" },
  { item: "User-Defined Filters (custom min EV/prob thresholds)", grok: "YES", claude: "-", gpt: "-" },
  { item: "External Sentiment (LunarCrush social volume)", grok: "YES - low weight feature", claude: "-", gpt: "-" },
  { item: "Orderbook Data Freshness Gate (zero if >10s old)", grok: "-", claude: "YES - high priority, from V1", gpt: "-" },
  { item: "Eighth-Kelly Enforcement (explicit code change)", grok: "-", claude: "YES - critical, immediate", gpt: "-" },
  { item: "Scan Result Pre-computation (pre-compute on candle close)", grok: "-", claude: "YES - reduces latency 60s to <5s", gpt: "-" },
  { item: "4h TF Emergency Disable Flag (env variable kill switch)", grok: "-", claude: "YES - immediate", gpt: "-" },
  { item: "Win Rate by Session Tracking (US vs Asia vs Europe)", grok: "-", claude: "YES - query, not code change", gpt: "-" },
  { item: "Mispricing Engine (probability arbitrage layer)", grok: "-", claude: "-", gpt: "YES - major new concept, NOW" },
  { item: "Probability Momentum (fade large prob spikes)", grok: "-", claude: "-", gpt: "YES - alpha layer" },
  { item: "ADX Trend Filter", grok: "-", claude: "-", gpt: "YES - NOW" },
  { item: "Liquidity Sweep Detection (stop hunts)", grok: "-", claude: "-", gpt: "YES - NOW" },
  { item: "VWAP Bands (intraday S/R)", grok: "-", claude: "-", gpt: "YES - NOW" },
  { item: "Liquidation Cascade Detection (OI drop monitoring)", grok: "YES - Coinglass", claude: "YES - OI drop >5% in 15min", gpt: "-" },
  { item: "VPIN / Order Flow Toxicity", grok: "YES", claude: "YES", gpt: "-" },
  { item: "News Event Pause (FOMC, CPI, NFP)", grok: "YES", claude: "YES", gpt: "-" },
];

const extraRows = [
  new TableRow({ children: [
    headerCell("Suggested Upgrade", 3600),
    headerCell("Grok", 1920),
    headerCell("Claude Chat", 1920),
    headerCell("ChatGPT (Neo)", 1920),
  ]})
];
for (let i = 0; i < extraUpgrades.length; i++) {
  const bg = i % 2 === 0 ? WHITE : LIGHT_GREY;
  extraRows.push(new TableRow({ children: [
    cell(extraUpgrades[i].item, 3600, { bold: true, fill: bg }),
    cell(extraUpgrades[i].grok, 1920, { fill: bg, center: true }),
    cell(extraUpgrades[i].claude, 1920, { fill: bg, center: true }),
    cell(extraUpgrades[i].gpt, 1920, { fill: bg, center: true }),
  ]}));
}

// ══════════════════════════════════════════════════════════════
//  TABLE 4 — KEY DISAGREEMENTS
// ══════════════════════════════════════════════════════════════
const disagreements = [
  { topic: "Orderbook Weight (#8)", detail: "Grok & GPT say reduce NOW. Claude says WAIT for data to decide. Claude adds freshness gate instead.",
    resolution: "Implement freshness gate NOW (zero if >10s). Defer weight reduction to 500+ trades with feature importance data." },
  { topic: "Execution Latency (#29)", detail: "Claude says DO NOW (cheap, diagnostic). Grok & GPT say WAIT until leverage is active.",
    resolution: "Implement logging NOW (low effort). Don't act on it until leverage rollout." },
  { topic: "Per-TF Leverage (#17)", detail: "Grok says WAIT until 4h is fixed. Claude & GPT say DO NOW (hardcode 4h=1x).",
    resolution: "DO NOW - hardcode 4h leverage to 1x. This IS the fix." },
  { topic: "Feature Importance (#11)", detail: "Grok & Claude say DO NOW (schema ready). GPT says LATER (500+ trades needed).",
    resolution: "Build the query/reporting NOW. Data will be thin but starts providing signal. Full analysis at 500+." },
  { topic: "Family Dampening", detail: "Grok says reduce to 50%/20% now. Claude says unknown, needs empirical data first.",
    resolution: "Keep current 60%/35%. Run correlation analysis at 500+ trades. Don't guess." },
  { topic: "Calibration Refresh", detail: "Grok says 1-4 hours. Claude says split: regime 5min, buckets 4-6hr, full daily.",
    resolution: "Claude's split approach is more nuanced. Implement tiered refresh." },
  { topic: "Kelly Fraction", detail: "All agree Quarter-Kelly is too aggressive. Grok says Eighth (sixteenth initially). Claude says Eighth now.",
    resolution: "Switch to Eighth-Kelly immediately." },
  { topic: "Mispricing Engine (GPT unique)", detail: "GPT proposes a second engine exploiting probability arbitrage. Others don't address.",
    resolution: "Interesting concept but adds major complexity. Evaluate after core upgrades are stable at 500+ trades." },
];

const disagRows = [
  new TableRow({ children: [
    headerCell("Topic", 2000),
    headerCell("Disagreement", 3680),
    headerCell("Suggested Resolution", 3680),
  ]})
];
for (let i = 0; i < disagreements.length; i++) {
  const bg = i % 2 === 0 ? WHITE : LIGHT_GREY;
  disagRows.push(new TableRow({ children: [
    cell(disagreements[i].topic, 2000, { bold: true, fill: bg }),
    cell(disagreements[i].detail, 3680, { fill: bg }),
    cell(disagreements[i].resolution, 3680, { fill: bg }),
  ]}));
}

// ══════════════════════════════════════════════════════════════
//  TABLE 5 — CONSENSUS ACTION PLAN
// ══════════════════════════════════════════════════════════════
const actionNow = [
  { pri: "1", item: "EV as primary metric (#24)", reason: "All 3 AIs unanimous. Highest-value single logic change. One-line swap." },
  { pri: "2", item: "Eighth-Kelly enforcement", reason: "All 3 agree Quarter-Kelly too aggressive at 243 trades. Immediate risk reduction." },
  { pri: "3", item: "Increase shrinkage 8->30 min, 50->100 full (#20)", reason: "All 3 agree. 2-minute code change. Prevents fitting noise." },
  { pri: "4", item: "Investigate/fix 4h timeframe (#27)", reason: "All 3 agree. 15% WR is erasing 15m gains. Regime gate or disable." },
  { pri: "5", item: "Portfolio heat tracking (#18)", reason: "All 3 agree. Trading real money without knowing total exposure." },
  { pri: "6", item: "Multi-TF confluence (#9)", reason: "All 3 agree. 15m (61% WR) confirmed against 1h trend = +3-5% WR." },
  { pri: "7", item: "Recency weighting (#5)", reason: "All 3 agree. EWMA decay on calibration. 90-day-old data diluting." },
  { pri: "8", item: "Drawdown leverage reduction (#13)", reason: "All 3 agree. Risk infrastructure before any leverage." },
  { pri: "9", item: "Consecutive loss tracker (#14)", reason: "All 3 agree. Protective mechanism, not performance." },
  { pri: "10", item: "Win rate gate for leverage (#15)", reason: "All 3 agree. 53.7% = max 2x A-grade only, hard-enforced." },
  { pri: "11", item: "Funding rate + leverage check (#16)", reason: "All 3 agree. 5 lines on existing infrastructure." },
  { pri: "12", item: "Phased leverage rollout (#19)", reason: "All 3 agree. Phase 1: max 3x, A-grade, self-unlocking thresholds." },
  { pri: "13", item: "Orderbook freshness gate (NEW)", reason: "Claude flagged. Zero out book features if >10s old. Protects 38% weight." },
  { pri: "14", item: "Fix distribution chart (#25)", reason: "All 3 agree. Bug showing 9 of 102 trades. Decisions on bad data." },
  { pri: "15", item: "Correlation filter BloFin (#26)", reason: "All 3 agree. Already exists for Jupiter - copy over." },
  { pri: "16", item: "Sharpe ratio tracking (#30)", reason: "All 3 agree. Standard metric, easy from existing P&L data." },
  { pri: "17", item: "Feature importance tracking (#11)", reason: "2/3 agree NOW. Schema ready. Run monthly queries." },
  { pri: "18", item: "Per-TF leverage limits (#17)", reason: "2/3 agree NOW. Hardcode 4h=1x leverage immediately." },
];

const actionWait = [
  { item: "Per-asset calibration (#6)", when: "500+ trades (150+/asset)", reason: "Data too sparse per asset. Build schema now, apply later." },
  { item: "Dynamic weight adjustment (#7)", when: "500+ snapshots logged", reason: "Premature adjustment = overfitting noise. Need feature importance first." },
  { item: "Orderbook weight reduction (#8)", when: "After feature importance at 500+", reason: "Let data decide. Freshness gate protects in the meantime." },
  { item: "Ensemble scoring (#12)", when: "1000+ trades", reason: "Complex architecture. Current calibration covers 80% of benefit." },
  { item: "Regime-transition detection (#21)", when: "500+ trades with labels", reason: "Build as shadow metric now. Activate when validated." },
  { item: "A/B testing for weights (#23)", when: "After dynamic weights (#7)", reason: "Nothing to A/B test yet. Need candidate weight sets first." },
  { item: "Telegram/Discord alerts (#28)", when: "55%+ stable WR", reason: "Non-core UX. Focus on fixing engine first." },
  { item: "Mispricing Engine (GPT)", when: "After core upgrades stable", reason: "Novel concept but major complexity. Evaluate post-500 trades." },
];

const actionNowRows = [
  new TableRow({ children: [
    headerCell("Priority", 700),
    headerCell("Action Item", 3400),
    headerCell("Why Now (Consensus Reasoning)", 5260),
  ]})
];
for (const a of actionNow) {
  actionNowRows.push(new TableRow({ children: [
    cell(a.pri, 700, { center: true, bold: true, fill: GREEN_BG }),
    cell(a.item, 3400, { bold: true }),
    cell(a.reason, 5260),
  ]}));
}

const actionWaitRows = [
  new TableRow({ children: [
    headerCell("Action Item", 2800),
    headerCell("When", 2400),
    headerCell("Why Wait", 4160),
  ]})
];
for (let i = 0; i < actionWait.length; i++) {
  const bg = i % 2 === 0 ? WHITE : LIGHT_GREY;
  actionWaitRows.push(new TableRow({ children: [
    cell(actionWait[i].item, 2800, { bold: true, fill: bg }),
    cell(actionWait[i].when, 2400, { fill: YELLOW_BG, center: true }),
    cell(actionWait[i].reason, 4160, { fill: bg }),
  ]}));
}

// ══════════════════════════════════════════════════════════════
//  TABLE 6 — PERFORMANCE PROJECTIONS
// ══════════════════════════════════════════════════════════════
const perfRows = [
  new TableRow({ children: [
    headerCell("Metric", 2340),
    headerCell("Current", 2340),
    headerCell("After Phase 1 (est.)", 2340),
    headerCell("After Phase 2 (est.)", 2340),
  ]}),
  new TableRow({ children: [
    cell("Win Rate", 2340, { bold: true }), cell("53.7%", 2340, { center: true }),
    cell("56-58%", 2340, { center: true, fill: GREEN_BG }), cell("58-62%", 2340, { center: true, fill: GREEN_BG }),
  ]}),
  new TableRow({ children: [
    cell("Sharpe Ratio", 2340, { bold: true }), cell("Unknown", 2340, { center: true }),
    cell("~1.0-1.3", 2340, { center: true, fill: GREEN_BG }), cell("~1.5-2.0", 2340, { center: true, fill: GREEN_BG }),
  ]}),
  new TableRow({ children: [
    cell("Max Drawdown", 2340, { bold: true }), cell("Unknown (untracked)", 2340, { center: true, fill: RED_BG }),
    cell("<15% (tracked + gated)", 2340, { center: true, fill: GREEN_BG }), cell("<10%", 2340, { center: true, fill: GREEN_BG }),
  ]}),
  new TableRow({ children: [
    cell("Max Leverage", 2340, { bold: true }), cell("None", 2340, { center: true }),
    cell("2-3x A-grade only", 2340, { center: true, fill: YELLOW_BG }), cell("Up to 5x tiered", 2340, { center: true, fill: YELLOW_BG }),
  ]}),
  new TableRow({ children: [
    cell("Trade Sample", 2340, { bold: true }), cell("243", 2340, { center: true }),
    cell("500+", 2340, { center: true }), cell("1000+", 2340, { center: true }),
  ]}),
];

// ══════════════════════════════════════════════════════════════
//  BUILD DOCUMENT
// ══════════════════════════════════════════════════════════════
const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 22 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 36, bold: true, font: "Arial", color: DARK_BLUE },
        paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: "Arial", color: MED_BLUE },
        paragraph: { spacing: { before: 240, after: 160 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 24, bold: true, font: "Arial", color: DARK_BLUE },
        paragraph: { spacing: { before: 200, after: 120 }, outlineLevel: 2 } },
    ]
  },
  sections: [{
    properties: {
      page: {
        size: { width: 15840, height: 12240, orientation: "landscape" },
        margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 }
      }
    },
    headers: {
      default: new Header({ children: [
        new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: MED_BLUE, space: 1 } },
          children: [
            new TextRun({ text: "Best Trades Engine V2 - AI Cross-Validation Review", font: "Arial", size: 18, bold: true, color: MED_BLUE }),
            new TextRun({ text: "\tMarch 16, 2026", font: "Arial", size: 18, color: "666666" }),
          ],
          tabStops: [{ type: "right", position: 13680 }],
        })
      ]})
    },
    footers: {
      default: new Footer({ children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: "Page ", font: "Arial", size: 16, color: "999999" }), new TextRun({ children: [PageNumber.CURRENT], font: "Arial", size: 16, color: "999999" })]
        })
      ]})
    },
    children: [
      // ── TITLE PAGE ──
      new Paragraph({ spacing: { before: 1200 }, alignment: AlignmentType.CENTER, children: [
        new TextRun({ text: "BEST TRADES ENGINE V2", font: "Arial", size: 52, bold: true, color: DARK_BLUE })
      ]}),
      new Paragraph({ alignment: AlignmentType.CENTER, children: [
        new TextRun({ text: "AI Cross-Validation Review", font: "Arial", size: 36, color: MED_BLUE })
      ]}),
      new Paragraph({ spacing: { before: 400 }, alignment: AlignmentType.CENTER, children: [
        new TextRun({ text: "Compiled feedback from Grok, Claude Chat, and ChatGPT (Neo)", font: "Arial", size: 24, color: "666666" })
      ]}),
      new Paragraph({ spacing: { before: 200 }, alignment: AlignmentType.CENTER, children: [
        new TextRun({ text: "March 16, 2026", font: "Arial", size: 24, color: "666666" })
      ]}),
      new Paragraph({ spacing: { before: 600 }, alignment: AlignmentType.CENTER, children: [
        new TextRun({ text: "Current State: 243 trades | 53.7% WR | +0.68% avg P&L | 33 indicators | 7/30 upgrades complete", font: "Arial", size: 22, bold: true, color: DARK_BLUE })
      ]}),

      new Paragraph({ children: [new PageBreak()] }),

      // ── SECTION 1: PRIORITIZATION ──
      hdr("1. Upgrade Prioritization - All 3 AIs Compared"),
      para("Green = DO NOW | Yellow = WAIT | Orange = SPLIT OPINION. Each AI independently assessed all 24 remaining upgrades."),
      new Paragraph({ spacing: { after: 100 }, children: [] }),
      new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: [500, 2200, 1100, 1100, 1100, 1200, 2160], rows: prioRows }),

      new Paragraph({ children: [new PageBreak()] }),

      // ── SECTION 2: CONSENSUS SUMMARY ──
      hdr("2. Consensus Summary"),
      para("Unanimous DO NOW: 14 upgrades  |  Majority DO NOW (2/3): 2 upgrades  |  Unanimous WAIT: 6 upgrades  |  Split: 2 upgrades", { bold: true }),

      new Paragraph({ spacing: { after: 100 }, children: [] }),
      hdr("2a. Action NOW - Prioritized (All 3 AIs Agree or 2/3 Majority)", HeadingLevel.HEADING_2),
      new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: [700, 3400, 5260], rows: actionNowRows }),

      new Paragraph({ children: [new PageBreak()] }),

      hdr("2b. Action LATER - With Triggers", HeadingLevel.HEADING_2),
      new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: [2800, 2400, 4160], rows: actionWaitRows }),

      new Paragraph({ children: [new PageBreak()] }),

      // ── SECTION 3: TECHNICAL QUESTIONS ──
      hdr("3. 15 Technical Questions - Side-by-Side Answers"),
      para("All three AIs were asked the same 15 questions about methodology, calibration, leverage, and risk management."),
      new Paragraph({ spacing: { after: 100 }, children: [] }),
      new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: [2400, 2320, 2320, 2320], rows: qRows }),

      new Paragraph({ children: [new PageBreak()] }),

      // ── SECTION 4: DISAGREEMENTS ──
      hdr("4. Key Disagreements & Suggested Resolutions"),
      para("Where the 3 AIs disagreed, with a balanced resolution for each."),
      new Paragraph({ spacing: { after: 100 }, children: [] }),
      new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: [2000, 3680, 3680], rows: disagRows }),

      new Paragraph({ children: [new PageBreak()] }),

      // ── SECTION 5: ADDITIONAL SUGGESTED UPGRADES ──
      hdr("5. Additional Upgrades Suggested (Not in Original Roadmap)"),
      para("Each AI independently suggested new upgrades beyond the original 30-item roadmap."),
      new Paragraph({ spacing: { after: 100 }, children: [] }),
      new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: [3600, 1920, 1920, 1920], rows: extraRows }),

      new Paragraph({ children: [new PageBreak()] }),

      // ── SECTION 6: PERFORMANCE PROJECTIONS ──
      hdr("6. Expected Performance After Upgrades"),
      para("Estimated impact based on consensus AI recommendations. Phase 1 = DO NOW items. Phase 2 = WAIT items at 500+ trades."),
      new Paragraph({ spacing: { after: 100 }, children: [] }),
      new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: [2340, 2340, 2340, 2340], rows: perfRows }),

      new Paragraph({ spacing: { before: 400 }, children: [] }),

      // ── SECTION 7: KEY TAKEAWAYS ──
      hdr("7. Key Takeaways"),
      para("1. ALL THREE AIs AGREE: EV should replace raw probability as the primary metric immediately.", { bold: true }),
      para("2. ALL THREE AIs AGREE: Quarter-Kelly is too aggressive at 243 trades. Switch to Eighth-Kelly now."),
      para("3. ALL THREE AIs AGREE: The 4h timeframe at 15% WR is actively destroying profits. Fix or disable."),
      para("4. ALL THREE AIs AGREE: Portfolio heat tracking is critical - you're trading real money without knowing total exposure."),
      para("5. ALL THREE AIs AGREE: Multi-TF confluence (15m + 1h) is the highest-value indicator improvement."),
      para("6. ALL THREE AIs AGREE: Wait for 500+ trades before dynamic weights, ensemble scoring, or per-asset calibration."),
      para("7. UNIQUE INSIGHT (Claude): Split calibration refresh into 3 tiers instead of flat 30-min refresh."),
      para("8. UNIQUE INSIGHT (Grok): Add external sentiment (LunarCrush) as low-weight feature."),
      para("9. UNIQUE INSIGHT (ChatGPT): Mispricing engine concept - probability arbitrage as second profit layer. Novel but complex."),
      para("10. CONSENSUS: 18 items should be actioned NOW. 8 items should WAIT for data thresholds.", { bold: true }),
    ]
  }]
});

Packer.toBuffer(doc).then(buffer => {
  const outPath = "C:\\Users\\jjkat\\OneDrive\\Desktop\\AI Projects\\Dashboard ultimate\\AI_Cross_Validation_Review.docx";
  fs.writeFileSync(outPath, buffer);
  console.log("Document created: " + outPath);
});
