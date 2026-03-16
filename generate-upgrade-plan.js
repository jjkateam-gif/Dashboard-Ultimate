const fs = require('fs');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
        ShadingType, PageBreak, PageNumber, LevelFormat } = require('docx');

// Colors
const DARK_BG = "1A1A2E";
const ACCENT_GREEN = "00F5A0";
const ACCENT_CYAN = "00D4FF";
const ACCENT_ORANGE = "FF6B35";
const ACCENT_RED = "FF4757";
const ACCENT_YELLOW = "FFD93D";
const HEADER_BG = "16213E";
const ROW_ALT = "F8F9FA";
const WHITE = "FFFFFF";
const BLACK = "000000";
const GRAY = "666666";
const LIGHT_GRAY = "E8E8E8";

const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };
const noBorder = { style: BorderStyle.NONE, size: 0 };
const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };

const cellMargins = { top: 60, bottom: 60, left: 100, right: 100 };

function headerCell(text, width) {
  return new TableCell({
    borders,
    width: { size: width, type: WidthType.DXA },
    shading: { fill: HEADER_BG, type: ShadingType.CLEAR },
    margins: cellMargins,
    verticalAlign: "center",
    children: [new Paragraph({ alignment: AlignmentType.LEFT, children: [
      new TextRun({ text, bold: true, color: WHITE, font: "Arial", size: 18 })
    ]})]
  });
}

function cell(text, width, opts = {}) {
  const color = opts.color || BLACK;
  const fill = opts.fill || WHITE;
  const bold = opts.bold || false;
  return new TableCell({
    borders,
    width: { size: width, type: WidthType.DXA },
    shading: { fill, type: ShadingType.CLEAR },
    margins: cellMargins,
    verticalAlign: "center",
    children: [new Paragraph({ alignment: opts.align || AlignmentType.LEFT, children: [
      new TextRun({ text: String(text), color, font: "Arial", size: 18, bold })
    ]})]
  });
}

function heading(text, level = HeadingLevel.HEADING_1) {
  return new Paragraph({ heading: level, spacing: { before: 300, after: 150 }, children: [
    new TextRun({ text, bold: true, font: "Arial", size: level === HeadingLevel.HEADING_1 ? 32 : level === HeadingLevel.HEADING_2 ? 26 : 22 })
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

function spacer() {
  return new Paragraph({ spacing: { after: 80 }, children: [] });
}

function makeTable(headers, rows, colWidths) {
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: totalWidth, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [
      new TableRow({ children: headers.map((h, i) => headerCell(h, colWidths[i])) }),
      ...rows.map((row, ri) => new TableRow({
        children: row.map((c, i) => {
          if (typeof c === 'object' && c._cell) return c._cell;
          return cell(c, colWidths[i], { fill: ri % 2 === 1 ? ROW_ALT : WHITE });
        })
      }))
    ]
  });
}

// Build document
const children = [];

// Title page
children.push(new Paragraph({ spacing: { before: 3000 }, alignment: AlignmentType.CENTER, children: [
  new TextRun({ text: "ULTIMATE CRYPTO BACKTESTER PRO", font: "Arial", size: 44, bold: true, color: "1A1A2E" })
]}));
children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [
  new TextRun({ text: "Best Trades Engine", font: "Arial", size: 36, color: "16213E" })
]}));
children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 }, children: [
  new TextRun({ text: "Complete System Audit, Methodology Analysis & Upgrade Roadmap", font: "Arial", size: 24, color: GRAY })
]}));
children.push(spacer());
children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 }, children: [
  new TextRun({ text: "For Cross-Validation by ChatGPT, Grok & Claude", font: "Arial", size: 22, bold: true, color: ACCENT_ORANGE })
]}));
children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 400 }, children: [
  new TextRun({ text: "Generated: March 16, 2026", font: "Arial", size: 20, color: GRAY })
]}));
children.push(spacer());

// Important context box
children.push(new Paragraph({ spacing: { before: 200 }, children: [
  new TextRun({ text: "IMPORTANT CONTEXT FOR REVIEWERS", font: "Arial", size: 22, bold: true, color: ACCENT_RED })
]}));
children.push(para("This document contains the complete technical audit of a live crypto trading system running 24/7 on Railway. The system scans 20 crypto assets across 6 timeframes, generates probability-scored trade predictions, and can auto-execute trades on BloFin exchange."));
children.push(para("Current performance: 53.7% win rate across 243 resolved trades. The system is live and trading real money."));
children.push(para("We are seeking your independent review of: (1) the indicator methodology and weightings, (2) the learning/calibration system, (3) the proposed upgrade roadmap, and (4) leverage recommendations. Please flag any concerns, suggest improvements, and validate our approach."));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ═══════════════════════════════════════════════════
// SECTION 1: ARCHITECTURE
// ═══════════════════════════════════════════════════
children.push(heading("1. SYSTEM ARCHITECTURE", HeadingLevel.HEADING_1));
children.push(para("The system has three layers: Frontend (browser), Backend (Railway server), and 24/7 autonomous processes. The frontend is optional \u2014 all core scanning, prediction logging, and auto-trading runs on the server independently."));

children.push(heading("1A. Component Map: Frontend vs Backend vs 24/7", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["Component", "Location", "24/7?", "Trigger", "Description"],
  [
    ["Probability Engine Scan", "Frontend", "NO", "User clicks Scan Now", "Fetches Binance klines, computes RSI/EMA/MACD/Ichimoku/BB/Volume, scores confluence, estimates R:R"],
    ["Auto-Trade Settings UI", "Frontend", "NO", "User toggles settings", "Collects enabled/mode/minProb/size/maxOpen/leverage/per-TF rules, syncs to backend"],
    ["Scan History Rendering", "Frontend", "NO", "User clicks Refresh", "Fetches /best-trades/history, displays paginated scan log with filters"],
    ["Manual Resolve Trigger", "Frontend", "NO", "User clicks Resolve Now", "POST to /best-trades/resolve, manually triggers resolution check"],
    ["Recommendations Panel", "Frontend", "NO", "User clicks Refresh", "Fetches /recommendations/history & /summary, displays trades with P&L"],
    ["Best Trades Scanner", "Backend", "YES", "Per-TF scheduled timers", "Scans 20 assets x 6 TFs: fetch klines \u2192 compute signals \u2192 score \u2192 calibrate \u2192 log to DB \u2192 auto-trade \u2192 SSE broadcast"],
    ["Calibration Cache", "Backend", "YES (30min)", "Timer", "Queries historical outcomes for probability bucket accuracy, regime+TF win rates, quality grades, Kelly graduation"],
    ["Auto-Trade Executor", "Backend", "YES (per scan)", "After each scan", "Filters by minProb/quality/confidence, deduplicates across TFs, executes on BloFin"],
    ["Predictions Resolver", "Backend", "YES (5min)", "Timer", "Checks candle high/low vs TP/SL for open predictions, updates outcome + P&L"],
    ["Recommendation Tracker", "Backend", "YES (5min)", "Timer", "Batch CoinGecko prices vs entry/target/stop, updates outcome"],
    ["SSE Broadcasting", "Backend", "YES (per event)", "After scan/resolve", "Real-time updates to connected browsers, 30s keep-alive pings"],
  ],
  [2200, 1100, 800, 1800, 3460]
));

children.push(spacer());
children.push(heading("1B. 24/7 Autonomous Processes", HeadingLevel.HEADING_2));
children.push(para("These run on Railway even when the browser is closed:"));
children.push(makeTable(
  ["Process", "Current Interval", "Proposed Interval", "What It Does"],
  [
    ["5m TF Scan", "Every 60s", "Every 3 min", "Scans 20 assets on 5m candles"],
    ["15m TF Scan", "Every 10min", "Every 5 min", "Scans 20 assets on 15m candles"],
    ["30m TF Scan", "Every 15min", "Every 15min (same)", "Scans 20 assets on 30m candles"],
    ["1h TF Scan", "Every 30min", "Every 30min (same)", "Scans 20 assets on 1h candles"],
    ["4h TF Scan", "Every 60min", "Every 2 hours", "Scans 20 assets on 4h candles"],
    ["1d TF Scan", "Every 4 hours", "Every 8 hours", "Scans 20 assets on 1d candles"],
    ["Calibration Refresh", "Every 30min", "Every 30min (same)", "Re-queries outcomes, updates Bayesian calibration cache"],
    ["Prediction Resolution", "Every 5min", "Every 5min (same)", "Checks candle high/low vs TP/SL for open predictions"],
    ["Recommendation Resolution", "Every 5min", "Every 5min (same)", "Batch CoinGecko prices vs entry/target/stop"],
  ],
  [2500, 1700, 1700, 3460]
));

children.push(spacer());
children.push(heading("1C. Database Tables", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["Table", "Purpose", "Written By", "Read By"],
  [
    ["best_trades_log", "Scanner prediction log + outcomes", "Scanner, Resolver", "Stats, History, Calibration"],
    ["best_trades_settings", "Auto-trade configuration", "Frontend sync, Scanner", "Scanner on startup"],
    ["trade_recommendations", "Manual + auto-tracked trades", "Frontend, Scanner", "Recommendation Tracker"],
    ["live_positions", "Open BloFin positions", "Live Engine", "Safety Guard, UI"],
    ["live_trade_history", "Closed trade history", "Live Engine", "UI, Stats"],
    ["live_safety_config", "Safety guard settings", "Admin UI", "Safety Guard"],
  ],
  [2200, 2500, 2200, 2460]
));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ═══════════════════════════════════════════════════
// SECTION 2: METHODOLOGY
// ═══════════════════════════════════════════════════
children.push(heading("2. COMPLETE METHODOLOGY", HeadingLevel.HEADING_1));
children.push(para("The prediction engine uses 33 technical features across 5 categories, weighted and combined through a sigmoid transformation to produce a probability score between 25-85%."));

children.push(heading("2A. All 33 Indicators & Weights", HeadingLevel.HEADING_2));
children.push(para("Total weight = 1.00 (100%). Orderbook features have the highest combined weight at 38%."));

children.push(heading("Price/Momentum \u2014 21% Total Weight", HeadingLevel.HEADING_3));
children.push(makeTable(
  ["Indicator", "Weight", "Signal Mapping", "Purpose"],
  [
    ["returns_1m", "0.04 (4%)", "clamp(value / 0.002, -1, 1)", "Short-term momentum"],
    ["returns_5m", "0.04 (4%)", "clamp(value / 0.002, -1, 1)", "Medium-term momentum"],
    ["returns_15m", "0.03 (3%)", "clamp(value / 0.002, -1, 1)", "Longer-term momentum"],
    ["rsi_7", "0.03 (3%)", "clamp(-(value-50)/50, -1, 1)", "Fast mean-reversion (contrarian)"],
    ["rsi_14", "0.03 (3%)", "clamp(-(value-50)/50, -1, 1)", "Standard mean-reversion"],
    ["macd_hist", "0.03 (3%)", "clamp(value/threshold, -1, 1)", "Momentum divergence"],
    ["bb_zscore", "0.01 (1%)", "Bollinger z-score direct", "Volatility mean-reversion"],
  ],
  [2000, 1200, 3200, 2960]
));

children.push(spacer());
children.push(heading("Volume/Flow \u2014 20% Total Weight", HeadingLevel.HEADING_3));
children.push(makeTable(
  ["Indicator", "Weight", "Signal Mapping", "Purpose"],
  [
    ["volume_ratio", "0.03 (3%)", "Current vol / SMA(20) vol", "Volume surge detection"],
    ["buy_sell_ratio", "0.07 (7%)", "Buy vol / total vol (5min)", "Directional order flow"],
    ["cvd_slope", "0.06 (6%)", "Cumulative volume delta slope", "Volume trend direction"],
    ["vwap_deviation", "0.04 (4%)", "(Price - VWAP) / Price", "Distance from VWAP"],
  ],
  [2000, 1200, 3200, 2960]
));

children.push(spacer());
children.push(heading("Orderbook \u2014 38% Total Weight (HIGHEST)", HeadingLevel.HEADING_3));
children.push(makeTable(
  ["Indicator", "Weight", "Signal Mapping", "Purpose"],
  [
    ["ofi_cumulative", "0.09 (9%)", "clamp(value/50, -1, 1)", "HIGHEST single feature \u2014 30s rolling OFI"],
    ["book_imbalance_1", "0.09 (9%)", "clamp(value*2, -1, 1)", "Top-of-book bid/ask imbalance"],
    ["book_imbalance_5", "0.07 (7%)", "5-level depth imbalance", "Short-term liquidity pressure"],
    ["book_imbalance_10", "0.03 (3%)", "10-level depth imbalance", "Medium-term book shape"],
    ["spread_bps", "0.02 (2%)", "Bid-ask spread in basis points", "Microstructure quality"],
    ["microprice_deviation", "0.07 (7%)", "Weighted price shift in bps", "Bid/ask weighted price shift"],
    ["depth_ratio", "0.02 (2%)", "Total bid depth / ask depth", "Support/resistance depth"],
  ],
  [2000, 1200, 3200, 2960]
));

children.push(spacer());
children.push(heading("Derivatives \u2014 11% Total Weight", HeadingLevel.HEADING_3));
children.push(makeTable(
  ["Indicator", "Weight", "Signal Mapping", "Purpose"],
  [
    ["funding_rate", "0.04 (4%)", "clamp(-value/0.0003, -1, 1)", "CONTRARIAN \u2014 high funding = bearish"],
    ["oi_change_pct", "0.03 (3%)", "Open interest trend", "Position buildup detection"],
    ["long_short_ratio", "0.04 (4%)", "clamp(-(value-1)*2, -1, 1)", "CONTRARIAN \u2014 crowded = fade"],
  ],
  [2000, 1200, 3200, 2960]
));

children.push(spacer());
children.push(heading("Temporal/Session \u2014 10% Total Weight", HeadingLevel.HEADING_3));
children.push(makeTable(
  ["Indicator", "Weight", "Values", "Purpose"],
  [
    ["session_weight", "0.05 (5%)", "US=1.0, EU=0.8, Asia=0.6", "Session liquidity weighting"],
    ["hour_weight", "0.05 (5%)", "Peak 14-21 UTC=1.0, Asia=0.5", "Hour-of-day liquidity"],
  ],
  [2000, 1200, 3200, 2960]
));

children.push(spacer());
children.push(para("REMOVED in V1.1: fear_greed (daily update = zero intraday signal), fear_greed_change (same), obv_slope (redundant with cvd_slope), atr_ratio (non-directional, tiny weight)", { italics: true, color: GRAY }));

children.push(new Paragraph({ children: [new PageBreak()] }));

// Probability Formula
children.push(heading("2B. Probability Calculation Formula", HeadingLevel.HEADING_2));
children.push(para("The probability is computed in 6 steps:"));
children.push(boldPara("Step 1: ", "Each of the 33 features is mapped to a directional signal between -1 (strongly bearish) and +1 (strongly bullish) using feature-specific normalization functions."));
children.push(boldPara("Step 2: ", "Weighted sum: rawScore = \u03A3(signal[i] \u00D7 weight[i]) \u2014 produces a single score capturing all feature contributions."));
children.push(boldPara("Step 3: ", "Volume modifier: >2x volume = +15% boost, >1.5x = +8%, <0.5x = -15% penalty. Uses PREVIOUS bar volume to avoid look-ahead bias."));
children.push(boldPara("Step 4: ", "Sigmoid transformation: prob = 1 / (1 + exp(-scale \u00D7 rawScore)). Scale = 2.5 for 5m timeframe, 3.0 for all others."));
children.push(boldPara("Step 5: ", "Clamp to realistic ranges: 30-70% for 5m (tighter bounds due to noise), 25-75% for all other timeframes."));
children.push(boldPara("Step 6: ", "Direction = prob \u2265 0.5 ? UP : DOWN"));

children.push(spacer());
children.push(heading("2C. Backend Confluence Scoring", HeadingLevel.HEADING_2));
children.push(para("The backend scanner uses a separate confluence scoring system with timeframe-adaptive weights:"));
children.push(makeTable(
  ["Indicator", "Short TF (5m)", "Med-Short (15m/30m)", "Medium (1h)", "Long TF (4h/1d)"],
  [
    ["EMA", "8", "14", "20", "25"],
    ["Ichimoku", "5", "10", "16", "22"],
    ["MACD", "10", "14", "16", "18"],
    ["RSI", "22", "18", "12", "10"],
    ["StochRSI", "22", "18", "10", "8"],
    ["Bollinger Bands", "18", "14", "12", "7"],
    ["Volume", "15", "12", "14", "10"],
    ["TOTAL", "100", "100", "100", "100"],
  ],
  [2200, 1800, 1800, 1800, 1760]
));

children.push(spacer());
children.push(boldPara("Family Dampening: ", "Penalizes redundant indicators from the same family. 1st signal: 100% weight, 2nd: 60%, 3rd+: 35%."));
children.push(boldPara("Conflict Resolution: ", "Mean-reversion signals (RSI, StochRSI, BB) conflicting with strong trend signals (EMA, MACD, Ichimoku) receive only 50% credit."));
children.push(boldPara("Confluence \u2192 Probability: ", "prob = 28 + (78-28) / (1 + exp(-7 \u00D7 (confluence - 0.5)))"));
children.push(boldPara("Regime Adjustments: ", "\u00B14% for trend alignment/opposition (e.g., bull regime + long signal = +4%)."));

children.push(spacer());
children.push(heading("2D. Probability Caps by Confidence + Quality", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["Confidence Level", "Quality A", "Quality B", "Quality C"],
  [
    ["High (\u22650.65 confluence)", "82% max", "76% max", "62% max"],
    ["Medium (0.45-0.65)", "68% max", "68% max", "68% max"],
    ["Low (<0.45)", "58% max", "58% max", "58% max"],
  ],
  [2800, 2200, 2200, 2160]
));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ═══════════════════════════════════════════════════
// SECTION 3: QUALITY, CONFIDENCE, CALIBRATION
// ═══════════════════════════════════════════════════
children.push(heading("3. QUALITY GRADING, CONFIDENCE & CALIBRATION", HeadingLevel.HEADING_1));

children.push(heading("3A. Market Quality Grade (A/B/C)", HeadingLevel.HEADING_2));
children.push(para("Each scan computes a market quality score from 5 components:"));
children.push(makeTable(
  ["Component", "Score +2", "Score +1", "Score -1"],
  [
    ["ATR Ratio", "> 1.2", "> 0.8", "\u2264 0.8"],
    ["Volume Ratio", "> 1.2", "> 0.7", "\u2264 0.7"],
    ["EMA Spread", "> 0.01", "> 0.005", "\u2264 0.005"],
    ["Squeeze/BBWP", "Squeeze detected (+1)", "BBWP > 0.50 (+1)", "Neither (0)"],
    ["Aligned Indicators", "\u2265 5 aligned (+2)", "\u2265 3 aligned (+1)", "< 3 (0)"],
  ],
  [2200, 2400, 2400, 2360]
));
children.push(spacer());
children.push(boldPara("Grades: ", "A (\u22657), B (4-6), C (1-3), No-Trade (<1)"));

children.push(spacer());
children.push(heading("3B. Confidence Score (0-1 Scale)", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["Component", "Weight", "Formula"],
  [
    ["Feature Agreement", "40%", "% of features agreeing with chosen direction"],
    ["Strong Signals", "25%", "min(strongSignals / 5, 1.0)"],
    ["Volume Context", "15%", "clamp(volumeRatio / 2, 0.3, 1.0)"],
    ["Spread Context", "10%", "\u22645bps=1.0, \u226415bps=0.8, \u226430bps=0.6, \u226450bps=0.4, else=0.2"],
    ["Data Freshness", "10%", "\u226410s=1.0, \u226430s=0.8, \u226460s=0.5, else=0.2"],
  ],
  [2200, 1000, 6160]
));

children.push(spacer());
children.push(heading("3C. How the Engine Learns (Calibration System)", HeadingLevel.HEADING_2));
children.push(para("Every 30 minutes, the system queries all resolved trades and adjusts future predictions through 3 layers:"));

children.push(spacer());
children.push(boldPara("Layer 1 \u2014 Probability Bucket Correction (60% weight): ", "Groups past trades into 5% buckets (50-54%, 55-59%, etc.). Compares predicted vs actual win rate. Example: if predicted 65% but those trades actually won 83%, nudges future 65% predictions upward by ~10.8%. Formula: correction = (actual - predicted) \u00D7 shrinkage \u00D7 0.6. Shrinkage = min(1, samples/50). Minimum 8 samples required."));
children.push(boldPara("Layer 2 \u2014 Regime + Timeframe Correction (30% weight): ", "Tracks win rate per regime/TF combo (e.g., bull_15m, bear_5m). If bear_15m wins 60% vs overall 50%, boosts bear+15m signals by +3%."));
children.push(boldPara("Layer 3 \u2014 Market Quality Correction (20% weight): ", "Tracks win rate per quality grade (A/B/C). If Grade A wins 65% vs overall 50%, boosts A-grade signals by +3%."));

children.push(spacer());
children.push(heading("3D. Kelly Sizing Graduation (Position Sizing Learning)", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["Milestone", "Kelly Bonus", "Requirement"],
  [
    ["+5% Kelly multiplier", "+0.05", "50+ resolved trades, calibration error < 8%"],
    ["+10% Kelly multiplier", "+0.10", "100+ resolved trades, calibration error < 5%"],
    ["+20% Kelly multiplier", "+0.20", "200+ resolved trades, calibration error < 3%"],
    ["+5% confidence bonus", "+0.05", "Confidence level actual win rate > 60%"],
    ["-10% confidence penalty", "-0.10", "Confidence level actual win rate < 45%"],
    ["+5% quality bonus", "+0.05", "Quality grade avg P&L > +1.0%"],
    ["-10% quality penalty", "-0.10", "Quality grade avg P&L < -0.5%"],
  ],
  [3000, 1800, 4560]
));

children.push(spacer());
children.push(heading("3E. Critical Learning Gap", HeadingLevel.HEADING_2));
children.push(para("THE ENGINE IS LEARNING WITH ONE HAND TIED BEHIND ITS BACK.", { bold: true, color: ACCENT_RED }));
children.push(spacer());
children.push(para("Currently, only the FINAL probability score and outcome are stored. The individual indicator values, weights, and signal breakdown are NOT logged. This means:"));
children.push(spacer());
children.push(makeTable(
  ["What the Engine CAN Ask", "What It CANNOT Ask"],
  [
    ["Did my 65% predictions win 65%?", "Which indicators were right on winning trades?"],
    ["Do bull+15m combos perform well?", "Does RSI perform better on 15m than 4h?"],
    ["Do A-grade trades win more?", "Is the 38% orderbook weight justified by results?"],
    ["Is my calibration error shrinking?", "Do high-OFI trades win more often?"],
    ["", "Should MACD be weighted higher in bear markets?"],
  ],
  [4680, 4680]
));
children.push(spacer());
children.push(para("Upgrade #1 in the roadmap addresses this by adding a JSONB indicator snapshot column to store all 33 indicator values with each prediction."));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ═══════════════════════════════════════════════════
// SECTION 4: ENTRY/EXIT & FILTERS
// ═══════════════════════════════════════════════════
children.push(heading("4. ENTRY/EXIT LOGIC & QUALITY FILTERS", HeadingLevel.HEADING_1));

children.push(heading("4A. Stop Loss & Target Placement", HeadingLevel.HEADING_2));
children.push(boldPara("Stop Loss: ", "Base = 2\u00D7 ATR, snapped to nearest swing low/high if within 0.5 ATR."));
children.push(makeTable(
  ["Probability Range", "Base Target", "Quality A Boost", "Quality B", "Quality C"],
  [
    ["\u226572%", "2.0\u00D7 ATR", "\u00D71.25", "\u00D71.0", "\u00D70.85"],
    ["62-71%", "2.5\u00D7 ATR", "\u00D71.25", "\u00D71.0", "\u00D70.85"],
    ["<62%", "3.0\u00D7 ATR", "\u00D71.25", "\u00D71.0", "\u00D70.85"],
  ],
  [1800, 1800, 1800, 1800, 2160]
));

children.push(spacer());
children.push(heading("4B. Quality Filters & Rejection Logic", HeadingLevel.HEADING_2));
children.push(para("Predictions must pass ALL of these filters before being acted on:"));
children.push(makeTable(
  ["Filter", "Threshold", "Action"],
  [
    ["Edge too large", "> 15%", "Reject (likely stale data)"],
    ["Choppy market", "regime = 0", "Reject (no reliable signals)"],
    ["Confidence too low", "< 45%", "Reject"],
    ["Gross edge too small (US session)", "< 4%", "Reject"],
    ["Gross edge too small (EU session)", "< 5%", "Reject"],
    ["Gross edge too small (Asia session)", "< 6.5%", "Reject"],
    ["Weekend", "+30% higher edge required", "Tighter filter"],
    ["Net edge after fees", "< 3.5%", "Reject"],
    ["Spread too wide", "> 10 bps", "Reject"],
    ["Feature quality", "< 50% valid critical features", "Reject"],
  ],
  [3000, 3000, 3360]
));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ═══════════════════════════════════════════════════
// SECTION 5: CURRENT LEVERAGE
// ═══════════════════════════════════════════════════
children.push(heading("5. CURRENT LEVERAGE INFRASTRUCTURE", HeadingLevel.HEADING_1));
children.push(para("The system has significant leverage infrastructure already built, but it is effectively dormant (default leverage = 1x)."));

children.push(heading("5A. What Already Exists", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["Component", "File", "Status"],
  [
    ["setLeverage() \u2014 sets leverage per instrument", "blofinClient.js", "Fully implemented"],
    ["setMarginMode() \u2014 cross/isolated margin", "blofinClient.js", "Fully implemented"],
    ["openPosition() \u2014 accepts leverage param", "blofinClient.js", "Fully implemented"],
    ["getFundingRate() \u2014 fetches funding rate", "blofinClient.js", "Implemented but NEVER CALLED"],
    ["canOpenPosition() \u2014 max leverage cap", "safetyGuard.js", "Implemented (default max: 20x)"],
    ["shouldAutoClose() \u2014 liquidation guard", "safetyGuard.js", "Implemented (5% from liquidation)"],
    ["Kelly-based optimal leverage", "bestTradesScanner.js", "Computed but DEFAULT IS 1x"],
    ["Leverage caps by confidence", "bestTradesScanner.js", "High=10x, Med=5x, Low=2x"],
    ["Quality multiplier for leverage", "bestTradesScanner.js", "A=1.0, B=0.8, C=0.5"],
  ],
  [3500, 2500, 3360]
));

children.push(spacer());
children.push(heading("5B. What is MISSING", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["Gap", "Impact"],
  [
    ["No dynamic leverage activation", "optimalLev computed but never used (default = 1x)"],
    ["No drawdown-based leverage reduction", "No progressive de-risking after losses"],
    ["No funding rate in trade decisions", "getFundingRate() exists but never called \u2014 ignoring carry cost"],
    ["No per-timeframe leverage rules", "tfRules supports overrides but leverage not included"],
    ["No correlation-based leverage caps", "Exists for Jupiter but not BloFin \u2014 over-exposure risk"],
    ["No win rate gate for leverage", "Leverage available immediately regardless of track record"],
    ["No post-loss cool-down", "Trade cooldowns exist but no leverage-specific dampening"],
  ],
  [3500, 5860]
));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ═══════════════════════════════════════════════════
// SECTION 6: LEVERAGE RECOMMENDATIONS
// ═══════════════════════════════════════════════════
children.push(heading("6. LEVERAGE RECOMMENDATIONS", HeadingLevel.HEADING_1));

children.push(heading("6A. Probability Thresholds for Leverage Tiers", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["Leverage", "Min Prob", "Min Quality", "Min Confidence", "Min R:R", "Description"],
  [
    ["1x (Spot)", "50-64%", "Any", "Any", "1.0", "Default. No leverage."],
    ["2x", "65-69%", "B+", "Medium+", "1.5", "Conservative. Above-avg conviction."],
    ["3x", "70-74%", "B+", "Medium+", "2.0", "Moderate. Multiple confirmations."],
    ["5x", "75-79%", "A only", "High", "2.5", "Elevated. Top-tier setups only."],
    ["10x", "80%+", "A only", "High", "3.0", "Only after 60%+ WR on 500+ trades"],
    ["15-20x", "85%+", "A only", "High", "4.0", "Require manual confirmation"],
  ],
  [1000, 1100, 1200, 1400, 1000, 3660]
));

children.push(spacer());
children.push(heading("6B. Regime-Based Leverage Multipliers", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["Market Regime", "Leverage Multiplier", "Reasoning"],
  [
    ["Strong Bull (price > EMA200)", "1.0\u00D7 (full tier)", "Trend alignment reduces risk"],
    ["Sideways/Choppy", "0.5\u00D7", "Whipsaw risk"],
    ["Bear Market (shorts)", "0.6\u00D7", "Counter-trend is dangerous"],
    ["Bear Market (longs)", "0.3\u00D7", "Extremely dangerous leveraged"],
    ["High Volatility (ATR > 2\u00D7 avg)", "0.4\u00D7", "Wider swings hit liquidation"],
  ],
  [3000, 2000, 4360]
));

children.push(spacer());
children.push(heading("6C. Win Rate Gates", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["Overall Win Rate", "Sample Size", "Max Leverage Allowed"],
  [
    ["< 50%", "100+ trades", "NO LEVERAGE (1x only)"],
    ["50-54%", "100+ trades", "2x on A-grade only"],
    ["55-59%", "200+ trades", "5x on A-grade"],
    ["60%+", "300+ trades", "Full tiers unlocked"],
    ["65%+", "500+ trades", "Kelly graduation bonus (+10%)"],
  ],
  [3000, 2000, 4360]
));

children.push(spacer());
children.push(heading("6D. Drawdown Protection", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["Consecutive Leveraged Losses", "Action"],
  [
    ["2 in a row", "Reduce next trade leverage by 1 tier"],
    ["3 in a row", "Max 2x"],
    ["4 in a row", "Disable leverage for 4 hours"],
    ["5 in a row", "Disable leverage for 24 hours"],
    ["7 in a row", "Kill switch alert to user"],
  ],
  [4000, 5360]
));

children.push(spacer());
children.push(makeTable(
  ["Portfolio Drawdown from Peak", "Action"],
  [
    ["-5%", "Reduce max leverage 1 tier"],
    ["-10%", "Cap at 2x, alert user"],
    ["-15%", "Disable all leverage, require manual re-enable"],
    ["-20%", "Kill switch, close all positions"],
    ["-25%", "Emergency stop, manual intervention required"],
  ],
  [4000, 5360]
));

children.push(spacer());
children.push(heading("6E. Phased Implementation", HeadingLevel.HEADING_2));
children.push(boldPara("Phase 1 (NOW \u2014 53.7% WR, 243 trades): ", "Keep 1x default. Enable optimalLev only for A-grade, High-confidence, prob \u226570%. Cap at 3x maximum. Implement drawdown-based reduction. Integrate funding rate checks."));
children.push(boldPara("Phase 2 (After 500+ trades, 55%+ WR): ", "Raise caps to High=5x, Medium=3x, Low=2x for A-grade. Enable per-TF leverage. Add correlation caps."));
children.push(boldPara("Phase 3 (After 1000+ trades, 58%+ WR): ", "Full leverage tiers. Kelly graduation bonus active."));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ═══════════════════════════════════════════════════
// SECTION 7: UPGRADE ROADMAP
// ═══════════════════════════════════════════════════
children.push(heading("7. COMPLETE UPGRADE ROADMAP (30 Items)", HeadingLevel.HEADING_1));

children.push(heading("Priority 1: Data & Learning (Do First)", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["#", "Upgrade", "Description", "Impact"],
  [
    ["1", "Add indicator snapshot logging", "Store all 33 indicator scores + weights as JSONB per prediction", "Enables feature-importance analysis"],
    ["2", "Optimize scan intervals", "5m\u21923min, 15m\u21925min, 30m\u219215min, 1h\u219230min, 4h\u21922h, 1d\u21928h", "-47% data volume, zero accuracy loss"],
    ["3", "Add 90-day retention policy", "Daily cleanup deletes raw predictions >90 days, preserves aggregated stats", "Keeps Railway Hobby storage under 5GB"],
    ["4", "Reduce to top 3 per scan", "Log best 3 predictions per scan instead of 5", "Further -40% volume reduction"],
    ["5", "Add recency weighting", "Recent 30 days weighted more than older trades (exponential decay)", "Adapts faster to regime changes"],
    ["6", "Add per-asset calibration", "Track accuracy per asset (BTC vs altcoins) separately", "BTC may calibrate very differently"],
  ],
  [400, 2400, 3800, 2760]
));

children.push(spacer());
children.push(heading("Priority 2: Indicator & Weight Improvements", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["#", "Upgrade", "Description", "Impact"],
  [
    ["7", "Dynamic feature weight adjustment", "Use logged snapshots to auto-adjust weights based on actual win rates", "Self-optimizing \u2014 the core learning upgrade"],
    ["8", "Reduce orderbook weight 38%\u219228%", "Redistribute 10% to momentum + derivatives", "Orderbook is most gameable (spoofing)"],
    ["9", "Add multi-TF confluence", "Confirm 15m signals with 1h trend direction", "Higher TF alignment improves win rate"],
    ["10", "Integrate funding rate", "getFundingRate() exists but never called in decisions", "Strong contrarian signal being wasted"],
    ["11", "Feature importance tracking", "Report which features contribute most to wins vs losses monthly", "Data-driven weight optimization"],
    ["12", "Ensemble scoring", "Run 3 sub-models and average (momentum/orderbook/derivatives)", "Reduces single-model overfitting"],
  ],
  [400, 2600, 3600, 2760]
));

children.push(spacer());
children.push(heading("Priority 3: Risk Management & Leverage", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["#", "Upgrade", "Description", "Impact"],
  [
    ["13", "Drawdown-based leverage reduction", "Auto-reduce max leverage at -5%/-10%/-15% drawdown thresholds", "Prevents catastrophic losses"],
    ["14", "Consecutive loss tracker", "3 losses \u2192 max 2x, 5 losses \u2192 disable 24h", "Stops revenge trading spirals"],
    ["15", "Win rate gate for leverage", "Require 55%+ WR on 200+ trades before >2x", "Proves edge before risking more"],
    ["16", "Funding rate check", "Block high-leverage longs when funding >0.10%", "Avoids heavy carry costs"],
    ["17", "Per-TF leverage limits", "Add maxLeverage to tfRules", "4h at 15% WR should never leverage"],
    ["18", "Portfolio heat tracking", "Cap total at-risk across all positions at 6%", "Prevents correlated over-exposure"],
    ["19", "Phased leverage rollout", "Phase 1: max 3x. Phase 2: max 5x. Phase 3: full", "Conservative graduation"],
  ],
  [400, 2600, 3600, 2760]
));

children.push(spacer());
children.push(heading("Priority 4: Calibration & Learning Enhancements", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["#", "Upgrade", "Description", "Impact"],
  [
    ["20", "Increase shrinkage threshold", "Require 100 samples (not 50) for full correction", "More statistical confidence"],
    ["21", "Regime-transition detection", "Detect bull\u2192bear or range\u2192trend shifts", "Current detection is lagging"],
    ["22", "Feature snapshots for losers", "Post-mortem: what did indicators show on losses?", "Pattern identification"],
    ["23", "A/B testing for weights", "Shadow mode with new weights, compare after 200+ trades", "Safe weight optimization"],
    ["24", "EV as primary metric", "EV = (prob \u00D7 target) - ((1-prob) \u00D7 stop)", "More accurate trade selection"],
  ],
  [400, 2600, 3600, 2760]
));

children.push(spacer());
children.push(heading("Priority 5: Infrastructure & UX", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["#", "Upgrade", "Description", "Impact"],
  [
    ["25", "Fix distribution chart", "WINS/LOSSES filter shows only current page data", "Accurate distribution display"],
    ["26", "Correlation filter for BloFin", "Already exists for Jupiter but not BloFin", "Prevents correlated over-exposure"],
    ["27", "Disable/fix 4h timeframe", "15% win rate on 33 trades \u2014 investigate", "Stop bleeding on worst TF"],
    ["28", "Telegram/Discord alerts", "Notify on high-confidence setups", "Don\u2019t miss opportunities"],
    ["29", "Track execution latency", "Log signal\u2192fill time, flag if >2s", "Improve fill quality"],
    ["30", "Sharpe ratio tracking", "Risk-adjusted returns metric", "Better performance assessment"],
  ],
  [400, 2600, 3600, 2760]
));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ═══════════════════════════════════════════════════
// SECTION 8: DATA STORAGE PLAN
// ═══════════════════════════════════════════════════
children.push(heading("8. DATA STORAGE & INFRASTRUCTURE PLAN", HeadingLevel.HEADING_1));

children.push(heading("8A. Current vs Optimized Data Volume", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["Metric", "Current", "After Optimizations"],
  [
    ["5m logs/day", "7,200", "2,400 (-67%)"],
    ["15m logs/day", "720", "1,440 (+100% \u2014 faster detection)"],
    ["30m logs/day", "480", "480 (same)"],
    ["1h logs/day", "240", "240 (same)"],
    ["4h logs/day", "120", "60 (-50%)"],
    ["1d logs/day", "30", "15 (-50%)"],
    ["Total/day", "~8,790", "~4,635 (-47%)"],
    ["Monthly (with indicators)", "~450 MB", "~240 MB (-47%)"],
    ["90-day retention", "~1.35 GB", "~720 MB"],
  ],
  [3500, 2800, 3060]
));

children.push(spacer());
children.push(heading("8B. Infrastructure Requirements", HeadingLevel.HEADING_2));
children.push(makeTable(
  ["Service", "Plan", "Cost", "Action Needed"],
  [
    ["Railway", "Hobby ($5/mo)", "$5/mo", "Stay \u2014 add 90-day retention policy"],
    ["GitHub", "Free", "$0", "No change needed"],
  ],
  [2000, 2000, 1200, 4160]
));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ═══════════════════════════════════════════════════
// SECTION 9: CURRENT PERFORMANCE
// ═══════════════════════════════════════════════════
children.push(heading("9. CURRENT PERFORMANCE SNAPSHOT", HeadingLevel.HEADING_1));
children.push(makeTable(
  ["Metric", "Value", "Assessment"],
  [
    ["Total Trades", "243", "Moderate sample \u2014 need 500+ for statistical confidence"],
    ["Win Rate", "53.7%", "Slightly above random. Edge exists but thin."],
    ["Avg P&L per Trade", "+0.68%", "Positive expectancy \u2014 good sign"],
    ["Best Timeframe", "15m (61% WR, 41 trades)", "Strongest edge \u2014 focus here"],
    ["Worst Timeframe", "4h (15% WR, 33 trades)", "Significant underperformance \u2014 investigate"],
    ["Active Scan TFs", "Only 15m shows results", "Other TFs show 0 in scan history (was disabled)"],
    ["Calibration", "50-55% bucket: 58% actual", "Over-performing \u2014 calibration adjusting upward"],
  ],
  [2500, 3000, 3860]
));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ═══════════════════════════════════════════════════
// SECTION 10: QUESTIONS FOR REVIEWERS
// ═══════════════════════════════════════════════════
children.push(heading("10. QUESTIONS FOR CROSS-VALIDATION", HeadingLevel.HEADING_1));
children.push(para("Please review the above methodology and provide your independent assessment on these specific questions:"));
children.push(spacer());

const questions = [
  "Is 38% weight on orderbook features appropriate? Or is this over-reliant on the most gameable data source (spoofing)? What weight distribution would you recommend?",
  "Should the sigmoid scale (2.5 for 5m, 3.0 for others) be different per regime? Trending markets may need different scaling than ranging.",
  "Is Quarter-Kelly too aggressive for a 243-trade sample? Should we use Eighth-Kelly until 500+ trades?",
  "The 4h timeframe shows 15% win rate on 33 trades. Should it be disabled entirely? Or does it need different indicator weights?",
  "Should funding rate be weighted higher than 0.04 (4%)? It is a strong contrarian signal that is currently underutilized AND getFundingRate() exists but is never called in trade decisions.",
  "Is the family dampening (60%/35% for 2nd/3rd redundant signals) correctly calibrated? Should redundant signals be penalized more or less?",
  "Should the system use Expected Value (EV = prob \u00D7 target - (1-prob) \u00D7 stop) instead of raw probability as the primary trading criterion?",
  "What is the optimal minimum sample size before trusting calibration adjustments? Currently 8 per bucket \u2014 is this statistically sufficient?",
  "Should leverage EVER be enabled with only a 53.7% win rate? Or should the system prove 55%+ first over 500+ trades?",
  "Is the 30-minute calibration refresh interval optimal? Too frequent = overfitting to noise. Too slow = misses regime changes.",
  "Is storing 33 indicator values per prediction (JSONB) the right approach for feature-importance learning? Or is there a more efficient method?",
  "Should the engine implement different indicator weights per market regime (bull/bear/sideways)? Currently weights are static across all conditions.",
  "Is the 90-day retention policy sufficient for meaningful calibration? Or should we keep longer history for rare market conditions?",
  "What additional risk management rules would you recommend beyond the drawdown/consecutive loss protections proposed?",
  "Are there any critical indicators MISSING from the 33-feature set that should be added for crypto perpetual futures trading?",
];

questions.forEach((q, i) => {
  children.push(new Paragraph({ spacing: { after: 150 }, children: [
    new TextRun({ text: `${i + 1}. `, font: "Arial", size: 20, bold: true, color: ACCENT_ORANGE }),
    new TextRun({ text: q, font: "Arial", size: 20 })
  ]}));
});

children.push(spacer());
children.push(para("Please provide specific, actionable recommendations. We will compare responses across ChatGPT, Grok, and Claude to build consensus before implementing changes.", { italics: true, color: GRAY }));

// Build final document
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
        new TextRun({ text: "Ultimate Crypto Backtester Pro \u2014 System Audit & Upgrade Plan", font: "Arial", size: 16, color: GRAY, italics: true })
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
  const outPath = "C:\\Users\\jjkat\\OneDrive\\Desktop\\AI Projects\\Dashboard ultimate\\Best_Trades_Engine_Complete_Audit_and_Upgrade_Plan.docx";
  fs.writeFileSync(outPath, buffer);
  console.log("Document created: " + outPath);
});
