const fs = require('fs');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
        ShadingType, PageBreak, PageNumber, LevelFormat } = require('docx');

const HEADER_BG = "16213E";
const ROW_ALT = "F8F9FA";
const WHITE = "FFFFFF";
const BLACK = "000000";
const GRAY = "666666";
const ACCENT_ORANGE = "FF6B35";
const ACCENT_RED = "FF4757";
const ACCENT_GREEN = "00A86B";
const DONE_BG = "E8F5E9";

const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 60, bottom: 60, left: 100, right: 100 };

function headerCell(text, width) {
  return new TableCell({
    borders, width: { size: width, type: WidthType.DXA },
    shading: { fill: HEADER_BG, type: ShadingType.CLEAR },
    margins: cellMargins, verticalAlign: "center",
    children: [new Paragraph({ alignment: AlignmentType.LEFT, children: [
      new TextRun({ text, bold: true, color: WHITE, font: "Arial", size: 18 })
    ]})]
  });
}

function cell(text, width, opts = {}) {
  return new TableCell({
    borders, width: { size: width, type: WidthType.DXA },
    shading: { fill: opts.fill || WHITE, type: ShadingType.CLEAR },
    margins: cellMargins, verticalAlign: "center",
    children: [new Paragraph({ alignment: opts.align || AlignmentType.LEFT, children: [
      new TextRun({ text: String(text), color: opts.color || BLACK, font: "Arial", size: 18, bold: opts.bold || false })
    ]})]
  });
}

function heading(text, level = HeadingLevel.HEADING_1) {
  const sz = level === HeadingLevel.HEADING_1 ? 32 : level === HeadingLevel.HEADING_2 ? 26 : 22;
  return new Paragraph({ heading: level, spacing: { before: 300, after: 150 }, children: [
    new TextRun({ text, bold: true, font: "Arial", size: sz })
  ]});
}

function para(text, opts = {}) {
  return new Paragraph({ spacing: { after: 120 }, children: [
    new TextRun({ text, font: "Arial", size: 20, color: opts.color || BLACK, bold: opts.bold || false, italics: opts.italics || false })
  ]});
}

function boldPara(label, text) {
  return new Paragraph({ spacing: { after: 120 }, children: [
    new TextRun({ text: label, font: "Arial", size: 20, bold: true }),
    new TextRun({ text, font: "Arial", size: 20 })
  ]});
}

function spacer() { return new Paragraph({ spacing: { after: 80 }, children: [] }); }

function makeTable(headers, rows, colWidths) {
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: totalWidth, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [
      new TableRow({ children: headers.map((h, i) => headerCell(h, colWidths[i])) }),
      ...rows.map((row, ri) => new TableRow({
        children: row.map((c, i) => {
          if (typeof c === 'object' && c._isCell) return c;
          const isDone = typeof c === 'string' && c.startsWith('\u2705');
          return cell(c, colWidths[i], { fill: isDone ? DONE_BG : (ri % 2 === 1 ? ROW_ALT : WHITE), bold: isDone, color: isDone ? ACCENT_GREEN : BLACK });
        })
      }))
    ]
  });
}

const children = [];

// ═══ TITLE PAGE ═══
children.push(new Paragraph({ spacing: { before: 2500 }, alignment: AlignmentType.CENTER, children: [
  new TextRun({ text: "ULTIMATE CRYPTO BACKTESTER PRO", font: "Arial", size: 44, bold: true, color: "1A1A2E" })
]}));
children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [
  new TextRun({ text: "Best Trades Engine", font: "Arial", size: 36, color: "16213E" })
]}));
children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 }, children: [
  new TextRun({ text: "System Audit, Methodology, Upgrades Completed & Remaining Roadmap", font: "Arial", size: 24, color: GRAY })
]}));
children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 }, children: [
  new TextRun({ text: "V2 \u2014 Updated March 16, 2026", font: "Arial", size: 22, bold: true, color: ACCENT_ORANGE })
]}));
children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 400 }, children: [
  new TextRun({ text: "For Review & Prioritization by ChatGPT, Grok & Claude", font: "Arial", size: 20, color: GRAY })
]}));
children.push(spacer());

children.push(new Paragraph({ spacing: { before: 200 }, children: [
  new TextRun({ text: "WHAT WE NEED FROM YOU", font: "Arial", size: 24, bold: true, color: ACCENT_RED })
]}));
children.push(para("This document contains the complete technical audit of a LIVE crypto trading system. We have already implemented 7 upgrades (marked green). There are 22 remaining upgrades."));
children.push(para("We need you to:"));
children.push(boldPara("1. ", "Review the methodology, indicators, weights, and calibration system. Flag any concerns."));
children.push(boldPara("2. ", "For each remaining upgrade: Should it be done NOW or LATER? If later, WHEN and WHY wait?"));
children.push(boldPara("3. ", "Answer the 15 specific technical questions at the end of this document."));
children.push(boldPara("4. ", "Suggest any critical upgrades we may have MISSED."));
children.push(para("Current performance: 53.7% win rate across 243 resolved trades. Live trading real money on BloFin exchange via Railway server 24/7.", { bold: true }));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ═══ SECTION 1: WHAT HAS BEEN UPGRADED ═══
children.push(heading("1. UPGRADES ALREADY COMPLETED", HeadingLevel.HEADING_1));
children.push(para("The following 7 upgrades have been implemented and deployed to production:"));
children.push(spacer());

children.push(makeTable(
  ["#", "Upgrade", "What Changed", "Impact"],
  [
    ["\u2705 1", "\u2705 Indicator Snapshot Logging", "All signal values (RSI, MACD, EMA, BB, Ichimoku, StochRSI, Volume states + values) stored as JSONB per prediction. Also stores raw_probability, EV, optimal_lev, ATR, hits/misses, volume_ratio, confluence_score", "Engine can now learn WHICH indicators predict correctly"],
    ["\u2705 2", "\u2705 Optimized Scan Intervals", "5m\u21923min, 15m\u21925min, 30m\u219215min (same), 1h\u219230min (same), 4h\u21922h, 1d\u21928h", "-47% data volume with zero accuracy loss"],
    ["\u2705 3", "\u2705 90-Day Retention Policy", "Daily cleanup deletes resolved predictions >90 days and abandoned pending >30 days", "Railway Hobby storage stays under 5GB"],
    ["\u2705 4", "\u2705 Reduced to Top 3 Per Scan", "Logs best 3 predictions per scan instead of 5", "Further -40% data volume"],
    ["\u2705 10", "\u2705 Funding Rate Integration", "Fetches Binance Futures funding rates every 5min. Contrarian adjustment: high positive funding penalizes longs (up to -3%), rewards shorts (up to +2%)", "Strong contrarian signal now active in scoring"],
    ["\u2705 22", "\u2705 Feature Snapshots for All Trades", "Covered by upgrade #1 \u2014 all trades (wins AND losses) now store full indicator snapshots", "Post-mortem analysis now possible"],
    ["\u2705 FIX", "\u2705 Scanner Always-On", "Scanner was gated behind auto-trade toggle (disabled = no scanning). Now scans 24/7 regardless of auto-trade setting. Auto-trading gated separately.", "Predictions now logging to database for calibration"],
  ],
  [500, 2200, 4200, 2460]
));

children.push(spacer());
children.push(heading("What the Engine Now Stores Per Prediction", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["Data Field", "Before", "After"],
  [
    ["Final calibrated probability", "Stored", "Stored"],
    ["Raw (pre-calibration) probability", "NOT stored", "\u2705 NOW STORED"],
    ["All indicator signals (bull/bear/value per indicator)", "NOT stored", "\u2705 NOW STORED (JSONB)"],
    ["Which indicators agreed with direction (hits)", "NOT stored", "\u2705 NOW STORED (JSONB)"],
    ["Which indicators disagreed (misses)", "NOT stored", "\u2705 NOW STORED (JSONB)"],
    ["ATR value at time of signal", "NOT stored", "\u2705 NOW STORED"],
    ["Volume ratio at time of signal", "NOT stored", "\u2705 NOW STORED"],
    ["Confluence score (0-1)", "NOT stored", "\u2705 NOW STORED"],
    ["Expected Value (EV)", "NOT stored", "\u2705 NOW STORED"],
    ["Optimal leverage calculated", "NOT stored", "\u2705 NOW STORED"],
    ["Funding rate at time of signal", "NOT stored", "\u2705 NOW STORED"],
    ["Confidence level", "Stored", "Stored"],
    ["Market quality grade (A/B/C)", "Stored", "Stored"],
    ["Regime (bull/bear/sideways)", "Stored", "Stored"],
    ["Outcome (win/loss/expired)", "Stored", "Stored"],
    ["P&L percentage", "Stored", "Stored"],
  ],
  [3800, 2500, 3060]
));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ═══ SECTION 2: METHODOLOGY (condensed from V1) ═══
children.push(heading("2. CURRENT METHODOLOGY (Summary)", HeadingLevel.HEADING_1));
children.push(para("Full methodology details were in V1. Key points for context:"));

children.push(heading("2A. Indicator Weights (33 Features)", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["Category", "Weight", "Top Indicators"],
  [
    ["Orderbook (7 features)", "38%", "OFI cumulative (9%), book_imbalance_1 (9%), microprice_deviation (7%)"],
    ["Price/Momentum (7 features)", "21%", "returns_1m (4%), returns_5m (4%), RSI_7 (3%), RSI_14 (3%), MACD (3%)"],
    ["Volume/Flow (4 features)", "20%", "buy_sell_ratio (7%), cvd_slope (6%), vwap_deviation (4%)"],
    ["Derivatives (3 features)", "11%", "funding_rate (4%), long_short_ratio (4%), OI_change (3%)"],
    ["Temporal/Session (2 features)", "10%", "session_weight (5%), hour_weight (5%)"],
  ],
  [2800, 1000, 5560]
));

children.push(spacer());
children.push(heading("2B. Probability Formula", HeadingLevel.HEADING_2));
children.push(boldPara("Step 1: ", "33 features \u2192 directional signals [-1, +1]"));
children.push(boldPara("Step 2: ", "Weighted sum: rawScore = \u03A3(signal[i] \u00D7 weight[i])"));
children.push(boldPara("Step 3: ", "Volume modifier: >2x = +15%, >1.5x = +8%, <0.5x = -15%"));
children.push(boldPara("Step 4: ", "Sigmoid: prob = 1/(1 + exp(-scale \u00D7 rawScore)). Scale = 2.5 (5m) or 3.0 (others)"));
children.push(boldPara("Step 5: ", "Clamp: 30-70% (5m) or 25-75% (others)"));
children.push(boldPara("Step 6: ", "NEW: Funding rate contrarian adjustment (\u00B13%)"));
children.push(boldPara("Step 7: ", "Calibration: Bayesian correction from historical outcomes (3 layers)"));

children.push(spacer());
children.push(heading("2C. Learning System (Calibration)", HeadingLevel.HEADING_2));
children.push(para("Every 30 minutes, queries all resolved trades and adjusts future predictions:"));
children.push(boldPara("Layer 1 (60% weight): ", "Probability bucket correction \u2014 if predicted 65% but actual 83%, nudge upward"));
children.push(boldPara("Layer 2 (30% weight): ", "Regime + timeframe correction \u2014 if bear_15m wins 60% vs overall 50%, boost"));
children.push(boldPara("Layer 3 (20% weight): ", "Market quality correction \u2014 if Grade A wins 65% vs overall 50%, boost"));
children.push(boldPara("Shrinkage: ", "min(1, samples/50) \u2014 full correction at 50+ samples, minimum 8 samples to start"));
children.push(boldPara("Kelly graduation: ", "+5% at 50 trades, +10% at 100, +20% at 200 (if calibration error < threshold)"));

children.push(spacer());
children.push(heading("2D. Quality Grade (A/B/C)", HeadingLevel.HEADING_2));
children.push(para("Score from 5 components: ATR ratio, volume ratio, EMA spread, squeeze/BBWP, indicator alignment. A(\u22657), B(4-6), C(1-3), No-Trade(<1)."));

children.push(heading("2E. Confidence Score (0-1)", HeadingLevel.HEADING_2));
children.push(para("40% feature agreement + 25% strong signals + 15% volume + 10% spread + 10% freshness."));

children.push(heading("2F. Confluence Scoring (Backend)", HeadingLevel.HEADING_2));
children.push(para("7 indicators (EMA, Ichimoku, MACD, RSI, StochRSI, BB, Volume) with TF-adaptive weights. Family dampening: 1st=100%, 2nd=60%, 3rd+=35%. Mean-reversion vs trend conflict = 50% credit."));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ═══ SECTION 3: CURRENT PERFORMANCE ═══
children.push(heading("3. CURRENT PERFORMANCE", HeadingLevel.HEADING_1));
children.push(makeTable(
  ["Metric", "Value", "Assessment"],
  [
    ["Total Trades", "243", "Moderate sample \u2014 need 500+ for confidence"],
    ["Win Rate", "53.7%", "Slightly above random. Edge exists but thin."],
    ["Avg P&L per Trade", "+0.68%", "Positive expectancy \u2014 good sign"],
    ["Best Timeframe", "15m (61% WR, 41 trades)", "Strongest edge \u2014 focus here"],
    ["Worst Timeframe", "4h (15% WR, 33 trades)", "Significant underperformance"],
    ["Scan History", "Was empty (scanner was disabled)", "NOW FIXED \u2014 logging 24/7"],
    ["Indicator Logging", "Was not storing signals", "NOW STORING all 33 indicators per prediction"],
  ],
  [2500, 3000, 3860]
));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ═══ SECTION 4: REMAINING UPGRADES ═══
children.push(heading("4. REMAINING UPGRADES \u2014 NEED YOUR PRIORITIZATION", HeadingLevel.HEADING_1));
children.push(para("For each upgrade below, please advise: DO NOW or WAIT? If wait, when and why?", { bold: true, color: ACCENT_RED }));

children.push(spacer());
children.push(heading("Priority 1: Data & Learning", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["#", "Upgrade", "Description", "Your Recommendation: NOW or LATER?"],
  [
    ["5", "Recency weighting for calibration", "Recent 30 days weighted more than older trades via exponential decay. Currently all trades weighted equally.", ""],
    ["6", "Per-asset calibration", "Track accuracy separately for BTC vs altcoins. BTC may calibrate very differently from small caps.", ""],
  ],
  [400, 2400, 3800, 2760]
));

children.push(spacer());
children.push(heading("Priority 2: Indicator & Weight Improvements", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["#", "Upgrade", "Description", "Your Recommendation: NOW or LATER?"],
  [
    ["7", "Dynamic feature weight adjustment", "Use logged indicator snapshots to auto-adjust weights based on actual win rates. Requires 500+ predictions with snapshots.", ""],
    ["8", "Reduce orderbook weight 38%\u219228%", "Redistribute 10% to momentum + derivatives. Orderbook data is most gameable (spoofing).", ""],
    ["9", "Multi-timeframe confluence", "Confirm 15m signals with 1h trend direction before trading. Higher TF alignment improves win rate.", ""],
    ["11", "Feature importance tracking", "Monthly report: which features contribute most to wins vs losses. Requires accumulated snapshot data.", ""],
    ["12", "Ensemble scoring", "Run 3 sub-models (momentum-focused, orderbook-focused, derivatives-focused) and average. Reduces overfitting.", ""],
  ],
  [400, 2400, 3800, 2760]
));

children.push(spacer());
children.push(heading("Priority 3: Risk Management & Leverage", HeadingLevel.HEADING_2));
children.push(para("Context: The system has full leverage infrastructure already built (Kelly sizing, BloFin API, safety guards) but currently defaults to 1x. Current win rate is 53.7% on 243 trades."));
children.push(makeTable(
  ["#", "Upgrade", "Description", "Your Recommendation: NOW or LATER?"],
  [
    ["13", "Drawdown-based leverage reduction", "Track portfolio drawdown from peak, auto-reduce max leverage at -5%/-10%/-15% thresholds.", ""],
    ["14", "Consecutive loss tracker", "After 3 leveraged losses \u2192 max 2x, after 5 \u2192 disable 24h.", ""],
    ["15", "Win rate gate for leverage", "Require 55%+ WR on 200+ trades before enabling leverage above 2x.", ""],
    ["16", "Funding rate check before leveraged entry", "Block high-leverage longs when funding >0.10%. getFundingRate() now active.", ""],
    ["17", "Per-timeframe leverage limits", "Add maxLeverage to existing tfRules. 4h at 15% WR should never be leveraged.", ""],
    ["18", "Portfolio heat tracking", "Track total portfolio at risk across all open positions, cap at 6%.", ""],
    ["19", "Phased leverage rollout", "Phase 1: max 3x. Phase 2 (500+ trades, 55% WR): max 5x. Phase 3 (1000+): full.", ""],
  ],
  [400, 2400, 3800, 2760]
));

children.push(spacer());
children.push(heading("Priority 4: Calibration & Learning Enhancements", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["#", "Upgrade", "Description", "Your Recommendation: NOW or LATER?"],
  [
    ["20", "Increase shrinkage threshold", "Require 100 samples (not 50) for full Bayesian correction. More statistical confidence.", ""],
    ["21", "Regime-transition detection", "Detect bull\u2192bear or range\u2192trend shifts in real-time. Current detection is lagging.", ""],
    ["23", "A/B testing for weight changes", "Shadow mode: run new weights alongside production, compare after 200+ trades.", ""],
    ["24", "EV as primary metric", "Use Expected Value = (prob \u00D7 target) - ((1-prob) \u00D7 stop) instead of raw probability.", ""],
  ],
  [400, 2400, 3800, 2760]
));

children.push(spacer());
children.push(heading("Priority 5: Infrastructure & UX", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["#", "Upgrade", "Description", "Your Recommendation: NOW or LATER?"],
  [
    ["25", "Fix scan history distribution chart", "WINS/LOSSES filter shows only current page (9 of 102). Need to fetch all from server.", ""],
    ["26", "Correlation filter for BloFin", "Already exists for Jupiter but not BloFin execution path. Prevents correlated over-exposure.", ""],
    ["27", "Investigate/fix 4h timeframe", "15% win rate on 33 trades. Needs root cause analysis or should be disabled.", ""],
    ["28", "Telegram/Discord alerts", "Notify on high-confidence setups without opening browser.", ""],
    ["29", "Track execution latency", "Log time from signal to order fill. If >2s on 5m, signal may be stale.", ""],
    ["30", "Sharpe ratio tracking", "Risk-adjusted returns metric for better performance assessment.", ""],
  ],
  [400, 2400, 3800, 2760]
));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ═══ SECTION 5: LEVERAGE RECOMMENDATIONS ═══
children.push(heading("5. LEVERAGE RECOMMENDATIONS (For Review)", HeadingLevel.HEADING_1));
children.push(para("Our proposed leverage framework. Please validate or suggest changes:"));

children.push(heading("5A. Probability Thresholds", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["Leverage", "Min Prob", "Min Quality", "Min Confidence", "Min R:R"],
  [
    ["1x (Spot)", "50-64%", "Any", "Any", "1.0"],
    ["2x", "65-69%", "B+", "Medium+", "1.5"],
    ["3x", "70-74%", "B+", "Medium+", "2.0"],
    ["5x", "75-79%", "A only", "High", "2.5"],
    ["10x", "80%+", "A only", "High", "3.0"],
    ["15-20x", "85%+", "A only", "High", "4.0"],
  ],
  [1200, 1400, 1600, 1800, 3360]
));

children.push(spacer());
children.push(heading("5B. Win Rate Gates", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["Win Rate", "Sample Size Required", "Max Leverage"],
  [
    ["< 50%", "100+ trades", "NO LEVERAGE (1x only)"],
    ["50-54% (CURRENT)", "100+ trades", "2x on A-grade only"],
    ["55-59%", "200+ trades", "5x on A-grade"],
    ["60%+", "300+ trades", "Full tiers unlocked"],
    ["65%+", "500+ trades", "Kelly graduation bonus (+10%)"],
  ],
  [2500, 2500, 4360]
));

children.push(spacer());
children.push(heading("5C. Drawdown Protection", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["Trigger", "Action"],
  [
    ["2 consecutive leveraged losses", "Reduce next trade leverage by 1 tier"],
    ["3 consecutive", "Max 2x"],
    ["4 consecutive", "Disable leverage 4 hours"],
    ["5 consecutive", "Disable leverage 24 hours"],
    ["-5% portfolio drawdown", "Reduce max leverage 1 tier"],
    ["-10% drawdown", "Cap at 2x, alert user"],
    ["-15% drawdown", "Disable all leverage, require manual re-enable"],
    ["-20% drawdown", "Kill switch, close all positions"],
  ],
  [4000, 5360]
));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ═══ SECTION 6: QUESTIONS ═══
children.push(heading("6. QUESTIONS FOR YOUR REVIEW", HeadingLevel.HEADING_1));
children.push(para("Please provide specific, actionable answers:"));
children.push(spacer());

const questions = [
  "Is 38% weight on orderbook features appropriate? Or over-reliant on gameable data (spoofing)? What distribution do you recommend?",
  "Should the sigmoid scale (2.5/3.0) differ per regime? Trending vs ranging markets may need different scaling.",
  "Is Quarter-Kelly too aggressive for 243 trades? Should we use Eighth-Kelly until 500+?",
  "The 4h timeframe shows 15% win rate on 33 trades. Disable it? Or fix with different indicator weights?",
  "Should funding rate weight be higher than 4%? It is a strong contrarian signal. We now fetch it every 5min and apply \u00B13% adjustment.",
  "Is family dampening (60%/35% for 2nd/3rd redundant signals) correctly calibrated?",
  "Should Expected Value (EV) replace raw probability as the primary trading criterion?",
  "Minimum sample size before trusting calibration? Currently 8 per bucket. Is this enough?",
  "Should leverage EVER be enabled at 53.7% win rate? Or prove 55%+ first over 500+ trades?",
  "Is 30-minute calibration refresh optimal? Too frequent = overfitting. Too slow = misses regime changes.",
  "We now store 33 indicator snapshots per prediction as JSONB. Is this the right approach for feature-importance learning?",
  "Should the engine use different indicator weights per market regime (bull/bear/sideways)? Currently weights are static.",
  "Is 90-day retention sufficient for calibration? Should we keep longer history for rare conditions?",
  "What additional risk management rules beyond our drawdown/consecutive loss protections?",
  "Are there critical indicators MISSING from our 33-feature set for crypto perpetual futures?",
];

questions.forEach((q, i) => {
  children.push(new Paragraph({ spacing: { after: 180 }, children: [
    new TextRun({ text: `${i + 1}. `, font: "Arial", size: 20, bold: true, color: ACCENT_ORANGE }),
    new TextRun({ text: q, font: "Arial", size: 20 })
  ]}));
});

children.push(new Paragraph({ children: [new PageBreak()] }));

// ═══ SECTION 7: PRIORITIZATION REQUEST ═══
children.push(heading("7. PRIORITIZATION REQUEST", HeadingLevel.HEADING_1));
children.push(para("Please fill in the table below with your recommended action for each remaining upgrade:", { bold: true }));
children.push(spacer());

children.push(makeTable(
  ["#", "Upgrade", "DO NOW or WAIT?", "If WAIT: When?", "Reasoning"],
  [
    ["5", "Recency weighting", "", "", ""],
    ["6", "Per-asset calibration", "", "", ""],
    ["7", "Dynamic weight adjustment", "", "", ""],
    ["8", "Reduce orderbook 38%\u219228%", "", "", ""],
    ["9", "Multi-TF confluence", "", "", ""],
    ["11", "Feature importance tracking", "", "", ""],
    ["12", "Ensemble scoring", "", "", ""],
    ["13", "Drawdown leverage reduction", "", "", ""],
    ["14", "Consecutive loss tracker", "", "", ""],
    ["15", "Win rate gate for leverage", "", "", ""],
    ["16", "Funding rate + leverage check", "", "", ""],
    ["17", "Per-TF leverage limits", "", "", ""],
    ["18", "Portfolio heat tracking", "", "", ""],
    ["19", "Phased leverage rollout", "", "", ""],
    ["20", "Increase shrinkage threshold", "", "", ""],
    ["21", "Regime-transition detection", "", "", ""],
    ["23", "A/B testing for weights", "", "", ""],
    ["24", "EV as primary metric", "", "", ""],
    ["25", "Fix distribution chart", "", "", ""],
    ["26", "Correlation filter BloFin", "", "", ""],
    ["27", "Investigate 4h timeframe", "", "", ""],
    ["28", "Telegram/Discord alerts", "", "", ""],
    ["29", "Execution latency tracking", "", "", ""],
    ["30", "Sharpe ratio tracking", "", "", ""],
  ],
  [400, 2200, 1600, 1600, 3560]
));

children.push(spacer());
children.push(para("Please also suggest any upgrades we may have MISSED that should be on this list.", { bold: true, color: ACCENT_RED }));
children.push(spacer());
children.push(para("Thank you for your thorough review. We will compare responses across ChatGPT, Grok, and Claude to build consensus before implementing any changes.", { italics: true, color: GRAY }));

// Build document
const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 20 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, font: "Arial", color: "1A1A2E" },
        paragraph: { spacing: { before: 300, after: 200 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 26, bold: true, font: "Arial", color: "16213E" },
        paragraph: { spacing: { before: 240, after: 150 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 22, bold: true, font: "Arial", color: "2C3E50" },
        paragraph: { spacing: { before: 180, after: 120 }, outlineLevel: 2 } },
    ]
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1200, right: 1200, bottom: 1200, left: 1200 }
      }
    },
    headers: {
      default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [
        new TextRun({ text: "Ultimate Crypto Backtester Pro \u2014 V2 Audit & Upgrade Plan", font: "Arial", size: 16, color: GRAY, italics: true })
      ]})] })
    },
    footers: {
      default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
        new TextRun({ text: "Page ", font: "Arial", size: 16, color: GRAY }),
        new TextRun({ children: [PageNumber.CURRENT], font: "Arial", size: 16, color: GRAY }),
        new TextRun({ text: " \u2014 Confidential \u2014 For AI Cross-Validation Review", font: "Arial", size: 16, color: GRAY })
      ]})] })
    },
    children,
  }]
});

Packer.toBuffer(doc).then(buffer => {
  const outPath = "C:\\Users\\jjkat\\OneDrive\\Desktop\\AI Projects\\Dashboard ultimate\\Best_Trades_Engine_Audit_V2_Updated.docx";
  fs.writeFileSync(outPath, buffer);
  console.log("Document created: " + outPath);
});
