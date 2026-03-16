const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        Header, Footer, AlignmentType, LevelFormat,
        HeadingLevel, BorderStyle, WidthType, ShadingType,
        PageNumber, PageBreak, TabStopType, TabStopPosition } = require('docx');
const fs = require('fs');

const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };
const noBorder = { style: BorderStyle.NONE, size: 0 };
const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };

const CONTENT_WIDTH = 9360; // US Letter with 1" margins

function h1(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 200 },
    children: [new TextRun({ text, bold: true, size: 36, font: "Arial", color: "1a1a2e" })] });
}
function h2(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 280, after: 160 },
    children: [new TextRun({ text, bold: true, size: 28, font: "Arial", color: "2d2d44" })] });
}
function h3(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_3, spacing: { before: 200, after: 120 },
    children: [new TextRun({ text, bold: true, size: 24, font: "Arial", color: "3d3d5c" })] });
}
function p(text, opts = {}) {
  return new Paragraph({ spacing: { after: 120 },
    children: [new TextRun({ text, size: 22, font: "Arial", ...opts })] });
}
function pMulti(runs) {
  return new Paragraph({ spacing: { after: 120 },
    children: runs.map(r => typeof r === 'string' ? new TextRun({ text: r, size: 22, font: "Arial" }) : new TextRun({ size: 22, font: "Arial", ...r })) });
}
function bullet(text, opts = {}) {
  return new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 60 },
    children: [new TextRun({ text, size: 22, font: "Arial", ...opts })] });
}
function bulletMulti(runs) {
  return new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 60 },
    children: runs.map(r => typeof r === 'string' ? new TextRun({ text: r, size: 22, font: "Arial" }) : new TextRun({ size: 22, font: "Arial", ...r })) });
}
function bullet2(text) {
  return new Paragraph({ numbering: { reference: "bullets2", level: 0 }, spacing: { after: 40 },
    children: [new TextRun({ text, size: 20, font: "Arial", color: "444444" })] });
}
function numItem(text, ref = "numbers") {
  return new Paragraph({ numbering: { reference: ref, level: 0 }, spacing: { after: 80 },
    children: [new TextRun({ text, size: 22, font: "Arial" })] });
}

function cell(text, opts = {}) {
  const { bold, color, fill, width, align } = opts;
  return new TableCell({
    borders,
    width: width ? { size: width, type: WidthType.DXA } : undefined,
    shading: fill ? { fill, type: ShadingType.CLEAR } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({
      alignment: align || AlignmentType.LEFT,
      children: [new TextRun({ text, size: 20, font: "Arial", bold: !!bold, color: color || "1a1a2e" })]
    })]
  });
}

function headerRow(texts, widths) {
  return new TableRow({
    children: texts.map((t, i) => cell(t, { bold: true, fill: "1a1a2e", color: "FFFFFF", width: widths[i] }))
  });
}
function dataRow(texts, widths, fill) {
  return new TableRow({
    children: texts.map((t, i) => cell(t, { width: widths[i], fill }))
  });
}

function makeTable(headers, rows, widths) {
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    rows: [
      headerRow(headers, widths),
      ...rows.map((r, i) => dataRow(r, widths, i % 2 === 0 ? "F5F5F5" : undefined))
    ]
  });
}

const doc = new Document({
  numbering: {
    config: [
      { reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "bullets2", levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2013", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 1080, hanging: 360 } } } }] },
      { reference: "numbers", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "steps", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "Step %1:", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 720 } } } }] },
    ]
  },
  styles: {
    default: { document: { run: { font: "Arial", size: 22 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 36, bold: true, font: "Arial", color: "1a1a2e" },
        paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: "Arial", color: "2d2d44" },
        paragraph: { spacing: { before: 280, after: 160 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 24, bold: true, font: "Arial", color: "3d3d5c" },
        paragraph: { spacing: { before: 200, after: 120 }, outlineLevel: 2 } },
    ]
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
      }
    },
    headers: {
      default: new Header({ children: [
        new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "a855f7", space: 1 } },
          spacing: { after: 200 },
          tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
          children: [
            new TextRun({ text: "Ultimate Crypto Dashboard Pro", size: 18, font: "Arial", color: "a855f7", bold: true }),
            new TextRun({ text: "\tAI Prediction Engine Methodology", size: 18, font: "Arial", color: "666666" }),
          ]
        })
      ] })
    },
    footers: {
      default: new Footer({ children: [
        new Paragraph({
          border: { top: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC", space: 4 } },
          tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
          children: [
            new TextRun({ text: "CONFIDENTIAL", size: 16, font: "Arial", color: "999999" }),
            new TextRun({ text: "\tPage ", size: 16, font: "Arial", color: "999999" }),
            new TextRun({ children: [PageNumber.CURRENT], size: 16, font: "Arial", color: "999999" }),
          ]
        })
      ] })
    },
    children: [
      // ═══════════════════════════════ TITLE PAGE ═══════════════════════════════
      new Paragraph({ spacing: { before: 2400 } }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 },
        children: [new TextRun({ text: "ULTIMATE CRYPTO DASHBOARD PRO", size: 48, bold: true, font: "Arial", color: "a855f7" })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 },
        children: [new TextRun({ text: "AI Prediction Engine", size: 40, bold: true, font: "Arial", color: "1a1a2e" })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 },
        children: [new TextRun({ text: "Complete Technical Methodology", size: 32, font: "Arial", color: "555555" })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 400, after: 100 },
        border: { top: { style: BorderStyle.SINGLE, size: 2, color: "a855f7", space: 8 }, bottom: { style: BorderStyle.SINGLE, size: 2, color: "a855f7", space: 8 } },
        children: [new TextRun({ text: "Version 1.0.0  |  March 15, 2026", size: 24, font: "Arial", color: "666666" })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 600 },
        children: [new TextRun({ text: "Model Type: Weighted Feature Ensemble (Rule-Based)", size: 22, font: "Arial", color: "444444" })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 },
        children: [new TextRun({ text: "Market: Jupiter Prediction Markets (Solana)", size: 22, font: "Arial", color: "444444" })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 },
        children: [new TextRun({ text: "Assets: BTC, ETH, SOL, XRP", size: 22, font: "Arial", color: "444444" })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 },
        children: [new TextRun({ text: "Timeframes: 5-minute and 15-minute binary prediction markets", size: 22, font: "Arial", color: "444444" })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 },
        children: [new TextRun({ text: "Deployment: Railway (24/7 autonomous operation)", size: 22, font: "Arial", color: "444444" })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 400 },
        children: [new TextRun({ text: "Built by @jjkateam", size: 22, font: "Arial", color: "a855f7", bold: true })] }),

      new Paragraph({ children: [new PageBreak()] }),

      // ═══════════════════════════════ TABLE OF CONTENTS ═══════════════════════════════
      h1("Table of Contents"),
      p("1. Executive Summary"),
      p("2. System Architecture"),
      p("3. Data Pipeline (Layer 1)"),
      p("4. Feature Engineering (Layer 2) \u2014 27 Features Across 5 Categories"),
      p("5. AI Scoring Engine (Layer 3) \u2014 Signal-to-Probability Mapping"),
      p("6. Edge Detection & Trade Decision (Layer 4)"),
      p("7. Position Sizing \u2014 Quarter-Kelly Criterion"),
      p("8. Quality Filters \u2014 6 Rejection Gates"),
      p("9. Confidence Assessment"),
      p("10. Trade Execution & Resolution"),
      p("11. Risk Management"),
      p("12. Monitoring & Observability"),
      p("13. V2 Roadmap \u2014 ML Upgrade Path"),
      p("14. Known Limitations & Honest Assessment"),

      new Paragraph({ children: [new PageBreak()] }),

      // ═══════════════════════════════ 1. EXECUTIVE SUMMARY ═══════════════════════════════
      h1("1. Executive Summary"),
      p("The AI Prediction Engine is a real-time trading system that autonomously trades Jupiter Prediction Markets on Solana. It ingests live market data from Binance futures via WebSocket, computes 27 microstructure features, maps them to calibrated probability estimates, detects edge against Jupiter market prices, sizes positions using the Kelly Criterion, and executes trades \u2014 all running 24/7 on Railway with zero human intervention."),
      p(""),
      pMulti([
        { text: "Design Philosophy: ", bold: true },
        "Ruthless simplicity. Rather than deploying an overfit 80-feature LSTM ensemble that would take 6 months of training data to validate, V1 uses a weighted feature ensemble with empirically-grounded signal mappings. Every feature has a clear market microstructure rationale. Every weight reflects observed predictive hierarchy (orderbook > momentum > volume > derivatives). The system is honest about its probability estimates \u2014 it never claims more than 70% confidence on a 5-minute binary market."
      ]),

      h2("Key Design Decisions"),
      bulletMulti([{ text: "27 features, not 80+. ", bold: true }, "Per Claude Chat\u2019s review: \u201Cthe problem calls for ruthless simplicity \u2014 15 carefully chosen microstructure features, one well-regularized model.\u201D We use 27 across 5 categories with strict weight allocation."]),
      bulletMulti([{ text: "No ML model (yet). ", bold: true }, "V1 is rule-based with calibrated sigmoid probability mapping. This is intentional \u2014 per Grok\u2019s review: \u201CThe most valuable thing you could build in week 1 is not the model \u2014 it\u2019s the logging infrastructure to answer: do any of these features actually have predictive power?\u201D"]),
      bulletMulti([{ text: "Orderbook features weighted highest (30%). ", bold: true }, "At 5-minute resolution, orderbook microstructure is the strongest surviving signal after transaction costs. Price momentum signals are near-random-walk at this timeframe."]),
      bulletMulti([{ text: "Quarter-Kelly, never full Kelly. ", bold: true }, "Position sizes are 25% of theoretical Kelly optimal, with additional drawdown and confidence adjustments. Maximum 5% of bankroll per trade."]),
      bulletMulti([{ text: "Honest probability bounds. ", bold: true }, "5m markets capped at [30%, 70%]. 15m markets capped at [25%, 75%]. The engine never overclaims certainty on inherently noisy short-term binary markets."]),

      new Paragraph({ children: [new PageBreak()] }),

      // ═══════════════════════════════ 2. SYSTEM ARCHITECTURE ═══════════════════════════════
      h1("2. System Architecture"),
      p("The prediction engine operates as three loosely-coupled modules within the Node.js backend, orchestrated by the main PredictionEngine class:"),
      p(""),

      makeTable(
        ["Module", "File", "Responsibility", "Update Frequency"],
        [
          ["Data Pipeline", "predictionDataPipeline.js", "Binance WS ingestion, REST polling, feature computation", "Real-time (every closed 1m candle)"],
          ["AI Scorer", "predictionScorer.js", "Feature-to-signal mapping, probability calibration, Kelly sizing, quality filters", "On-demand (per market scored)"],
          ["Engine", "predictionEngine.js", "Jupiter API polling, market discovery, signal orchestration, trade execution, SSE broadcast", "Every 30 seconds"],
          ["Routes", "predictions.js", "REST + SSE API for frontend", "Request-driven"],
        ],
        [1800, 2200, 3560, 1800]
      ),

      h2("Data Flow"),
      numItem("Binance Futures WebSocket streams real-time 1m candles, orderbook snapshots (100ms), and individual trades for BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT."),
      numItem("Data Pipeline resamples 1m candles into 5m and 15m bars, maintains rolling windows (300 candles, 500 trades), and computes 27 features on each closed candle."),
      numItem("REST polling (every 30s) fetches Fear & Greed Index, funding rates, open interest, and long/short ratios from Binance and Alternative.me."),
      numItem("Engine polls Jupiter Prediction Market API (every 30s) for live 5m/15m crypto events with embedded market prices."),
      numItem("For each live market, Engine extracts the asset\u2019s features from the pipeline and passes them to the AI Scorer."),
      numItem("Scorer computes directional signals for all 27 features, aggregates with empirical weights, maps to calibrated probability via sigmoid, assesses confidence, detects edge vs Jupiter price, sizes via Kelly, and applies 6 quality filters."),
      numItem("Signals that pass all filters become trades (paper or real). Trades are broadcast via SSE to all connected frontends."),
      numItem("Expired trades are auto-resolved by checking Jupiter market results or simulating based on edge."),

      new Paragraph({ children: [new PageBreak()] }),

      // ═══════════════════════════════ 3. DATA PIPELINE ═══════════════════════════════
      h1("3. Data Pipeline (Layer 1)"),
      p("The data pipeline is the foundation. It provides the raw market state from which all features are derived."),

      h2("3.1 Binance Futures WebSocket"),
      p("A single multiplexed WebSocket connection to wss://fstream.binance.com streams three data types per symbol:"),
      p(""),
      makeTable(
        ["Stream", "Format", "Purpose", "Buffer"],
        [
          ["@kline_1m", "OHLCV candle (open/close/update)", "Price action, indicator computation", "300 candles (5 hours)"],
          ["@depth20@100ms", "Top 20 bid/ask levels, 100ms throttle", "Orderbook microstructure", "Latest snapshot only"],
          ["@aggTrade", "Individual trades (price, qty, side)", "Buy/sell flow, CVD computation", "500 trades"],
        ],
        [2000, 2800, 2560, 2000]
      ),

      h3("Reconnection Strategy"),
      bullet("Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 60s (max)"),
      bullet("Reconnect attempt counter resets on successful connection"),
      bullet("All listeners removed before reconnecting to prevent memory leaks"),

      h3("Candle Resampling"),
      p("1-minute candles are resampled into 5m and 15m bars using time-aligned aggregation. Each bar\u2019s start time is aligned to the timeframe boundary (e.g., 5m bars start at :00, :05, :10, etc.). Resampling only occurs on candle close (k.x = true) to avoid look-ahead bias from incomplete bars."),
      bullet("Open: first 1m candle\u2019s open price"),
      bullet("High: max of all constituent highs"),
      bullet("Low: min of all constituent lows"),
      bullet("Close: last 1m candle\u2019s close price"),
      bullet("Volume: sum of all constituent volumes"),

      h2("3.2 REST API Polling (Every 30 Seconds)"),
      p("Four external data sources are polled via Promise.allSettled (one failure doesn\u2019t block others):"),
      p(""),
      makeTable(
        ["Source", "Endpoint", "Data", "Per-Asset?"],
        [
          ["Fear & Greed", "api.alternative.me/fng/?limit=2", "Current + previous FNG value (0\u2013100)", "No (global)"],
          ["Funding Rate", "fapi.binance.com/fapi/v1/premiumIndex", "Last funding rate", "Yes (per symbol)"],
          ["Open Interest", "fapi.binance.com/fapi/v1/openInterest", "Current OI in contracts", "Yes (per symbol)"],
          ["Long/Short Ratio", "fapi.binance.com/futures/data/globalLongShortAccountRatio", "Account-based L/S ratio (5m)", "Yes (per symbol)"],
        ],
        [2000, 3360, 2400, 1600]
      ),

      h2("3.3 Pipeline Readiness"),
      pMulti([
        { text: "Minimum data required: ", bold: true },
        "60 closed 1-minute candles (1 hour of data) before the pipeline reports isReady=true for an asset. This ensures all indicator calculations (RSI-14 on 5m candles requires at least 15 5m bars = 75 1m candles) have sufficient history."
      ]),
      p("Warm-up time after Railway deployment: approximately 60\u201390 seconds for the pipeline to become ready for all 4 assets."),

      new Paragraph({ children: [new PageBreak()] }),

      // ═══════════════════════════════ 4. FEATURE ENGINEERING ═══════════════════════════════
      h1("4. Feature Engineering (Layer 2)"),
      p("27 features are computed per asset, organized into 5 categories. Each feature is designed to capture a specific market microstructure signal. All features are guaranteed to be numeric (nulls/NaNs replaced with 0)."),

      h2("4.1 Price / Momentum Features (8)"),
      p("These capture the current directional tendency from recent price action and classical technical indicators."),
      p(""),
      makeTable(
        ["Feature", "Computation", "Signal Logic", "Weight"],
        [
          ["returns_1m", "ln(close[t] / close[t-1]) on 1m candles", "Recent momentum: positive = bullish. Saturates at \u00B10.2%", "0.04"],
          ["returns_5m", "ln(close[t] / close[t-1]) on 5m candles", "Medium momentum. Saturates at \u00B10.5%", "0.04"],
          ["returns_15m", "ln(close[t] / close[t-1]) on 15m candles", "Longer trend. Saturates at \u00B11.0%", "0.03"],
          ["rsi_7", "Wilder RSI(7) on 1m closes", "Mean-reversion: RSI < 35 = bullish, > 65 = bearish. Signal = -(RSI-50)/50", "0.04"],
          ["rsi_14", "Wilder RSI(14) on 5m closes", "Smoother mean-reversion signal on higher timeframe", "0.03"],
          ["macd_hist", "MACD(12,26,9) histogram on 5m", "Momentum direction, normalized by ATR to account for volatility", "0.04"],
          ["bb_zscore", "(Price - SMA20) / StDev20 on 5m", "Mean-reversion: price at +2\u03C3 = bearish, -2\u03C3 = bullish. Signal = -zscore/2", "0.02"],
          ["atr_ratio", "ATR(14) / Price on 5m candles", "Normalized volatility. Non-directional (weight 0.01), used as context", "0.01"],
        ],
        [1600, 2760, 3400, 1600]
      ),

      p(""),
      pMulti([{ text: "Category Total Weight: 0.25 (25%)", bold: true, color: "a855f7" }]),

      h2("4.2 Volume / Flow Features (5)"),
      p("These capture the buying and selling pressure from actual trade flow and volume patterns."),
      p(""),
      makeTable(
        ["Feature", "Computation", "Signal Logic", "Weight"],
        [
          ["volume_ratio", "Current 5m volume / SMA(20) of 5m volumes", "Modifier only (not directional). Amplifies aggregate score: >2x volume = +15%, <0.5x = -15%", "0.03"],
          ["buy_sell_ratio", "Taker buy volume / total volume (last 5 min of aggTrades, USD-weighted)", "Direct flow signal: >0.5 = net buying. Signal = (ratio - 0.5) * 2. Strongest volume feature.", "0.06"],
          ["cvd_slope", "CVD(last 10 trades) - CVD(prev 10 trades). CVD = cumulative (buy - sell) qty", "Slope of cumulative volume delta: rising CVD = bullish flow acceleration", "0.05"],
          ["vwap_deviation", "(Price - VWAP) / Price. VWAP = \u2211(typical*vol) / \u2211vol over all available 1m candles", "Mean-reversion to VWAP: price above VWAP tends to revert. Signal = -deviation/0.002", "0.04"],
          ["obv_slope", "Linear slope of OBV over last 6 5m candles. OBV = cumulative (direction * volume)", "Volume trend confirmation: rising OBV with rising price = bullish, divergence = warning", "0.02"],
        ],
        [1600, 3160, 3000, 1600]
      ),

      p(""),
      pMulti([{ text: "Category Total Weight: 0.20 (20%)", bold: true, color: "a855f7" }]),

      new Paragraph({ children: [new PageBreak()] }),

      h2("4.3 Orderbook Features (6)"),
      pMulti([
        { text: "Highest weight category (30%). ", bold: true },
        "At 5-minute resolution, orderbook microstructure contains the strongest predictive signal that survives transaction costs. Per academic literature (Cont et al., 2014), order flow imbalance and microprice deviation are among the most robust short-term predictors."
      ]),
      p(""),
      makeTable(
        ["Feature", "Computation", "Signal Logic", "Weight"],
        [
          ["book_imbalance_1", "(bidQty[0] - askQty[0]) / (bidQty[0] + askQty[0])", "Top-of-book pressure. Positive = more bids = bullish. Signal = value * 2, clamped [-1,1]. Strongest single feature.", "0.08"],
          ["book_imbalance_5", "Same formula over top 5 bid/ask levels", "Broader book pressure. More stable than single-level.", "0.07"],
          ["book_imbalance_10", "Same formula over top 10 levels", "Deep book sentiment. Lower weight as deeper levels are less predictive.", "0.05"],
          ["spread_bps", "(bestAsk - bestBid) / midPrice * 10000", "Modifier only (not directional). Wide spread = lower confidence, tighter = higher. Used in confidence and quality filters.", "0.02"],
          ["microprice_deviation", "Microprice = (bidP*askQ + askP*bidQ) / (bidQ+askQ). Deviation = (microprice - mid) / mid * 10000 bps", "Quantity-weighted fair price. When microprice > midprice = bullish (more ask qty creates upward pressure). Signal = value/5.", "0.06"],
          ["depth_ratio", "Total bid depth (top 20) / Total ask depth (top 20)", "Overall depth imbalance. >1 = more bid support. Signal = (ratio-1)*2.", "0.02"],
        ],
        [1800, 3000, 2960, 1600]
      ),

      p(""),
      pMulti([{ text: "Category Total Weight: 0.30 (30%)", bold: true, color: "a855f7" }]),

      h2("4.4 Derivatives / Context Features (5)"),
      p("Derivatives data provides contrarian and confirmation signals. Funding rate and long/short ratio are used as contrarian indicators (crowded positioning tends to revert)."),
      p(""),
      makeTable(
        ["Feature", "Computation", "Signal Logic", "Weight"],
        [
          ["funding_rate", "Binance perpetual futures funding rate", "Contrarian: high positive funding = crowded longs = bearish. Signal = -rate/0.0003.", "0.04"],
          ["oi_change_pct", "(current OI - prev OI) / prev OI", "Combined with price direction: rising OI + rising price = bullish continuation. Signal = (OI change * priceDir) / 0.02.", "0.03"],
          ["long_short_ratio", "Binance global L/S account ratio (5m)", "Contrarian: ratio > 1 = too many longs = bearish. Signal = -(ratio-1)*2.", "0.04"],
          ["fear_greed", "Alternative.me Fear & Greed Index / 100", "Slight momentum: high sentiment = mildly bullish. Signal = (FNG-0.5)*0.5. Low weight by design.", "0.02"],
          ["fear_greed_change", "(current FNG - previous FNG) / 100", "Sentiment momentum: improving sentiment = bullish. Signal = change/10.", "0.02"],
        ],
        [1800, 2800, 3160, 1600]
      ),

      p(""),
      pMulti([{ text: "Category Total Weight: 0.15 (15%)", bold: true, color: "a855f7" }]),

      h2("4.5 Temporal Features (3)"),
      p("Temporal features affect confidence level but do not contribute to directional signal. Different trading sessions exhibit different volatility profiles and predictability."),
      p(""),
      makeTable(
        ["Feature", "Computation", "Usage", "Weight"],
        [
          ["hour_sin", "sin(2\u03C0 * UTC_hour / 24)", "Cyclical encoding of time-of-day. Combined with hour_cos to represent time as continuous circle.", "0.05*"],
          ["hour_cos", "cos(2\u03C0 * UTC_hour / 24)", "Ensures model treats 23:00 and 01:00 as close together (unlike raw hour).", "0.05*"],
          ["session", "0 = Asia (00\u201308 UTC), 1 = Europe (08\u201314 UTC), 2 = US (14\u201324 UTC)", "Session identification for context. US session typically has highest volume/volatility.", "N/A"],
        ],
        [1800, 3000, 2960, 1600]
      ),

      p("* Temporal weights (total 0.10) affect confidence scoring, not directional signal computation.", { italics: true, color: "666666" }),

      new Paragraph({ children: [new PageBreak()] }),

      // ═══════════════════════════════ 5. AI SCORING ENGINE ═══════════════════════════════
      h1("5. AI Scoring Engine (Layer 3)"),
      p("The scoring engine transforms raw feature values into a calibrated probability estimate P(UP) through a multi-step pipeline:"),

      h2("5.1 Feature Signal Extraction"),
      p("Each raw feature value is mapped to a directional signal between -1 (strongly bearish) and +1 (strongly bullish) using feature-specific transformation functions. The mappings are designed to:"),
      bullet("Normalize across different feature scales (RSI is 0\u2013100, returns are ~0.001)"),
      bullet("Incorporate market microstructure theory (mean-reversion for RSI/BB, contrarian for funding)"),
      bullet("Saturate at reasonable bounds (0.2% 1m return is considered a strong move)"),
      bullet("Non-directional features (atr_ratio, spread_bps, volume_ratio) return signal = 0 and instead act as modifiers on confidence or aggregate score amplification"),

      h2("5.2 Weighted Aggregation"),
      p("All feature signals are multiplied by their empirical weights and summed:"),
      p("rawScore = \u2211(signal_i * weight_i) for all 27 features", { bold: true, italics: true }),
      p(""),
      p("The raw score is then adjusted by the volume modifier:"),
      bullet("Volume ratio > 2.0x average: rawScore *= 1.15 (amplify in high-volume conditions)"),
      bullet("Volume ratio > 1.5x: rawScore *= 1.08"),
      bullet("Volume ratio < 0.5x: rawScore *= 0.85 (dampen in low-volume conditions)"),
      bullet("Otherwise: no adjustment"),
      p(""),
      pMulti([{ text: "Rationale: ", bold: true }, "High volume validates directional signals (more market participation = more meaningful orderbook and flow data). Low volume means features are noisier and less trustworthy."]),

      h2("5.3 Probability Calibration (Sigmoid Mapping)"),
      p("The raw aggregate score (range approximately -1 to +1) is mapped to a probability via a calibrated sigmoid function:"),
      p(""),
      p("P(UP) = 1 / (1 + exp(-scale * rawScore))", { bold: true }),
      p(""),
      p("where scale is a timeframe-dependent parameter:"),
      bullet("5m markets: scale = 2.5 (compressed \u2014 signals are weaker at shorter timeframes)"),
      bullet("15m markets: scale = 3.0 (slightly more signal survives)"),
      p(""),
      pMulti([{ text: "Critical: Probability Clamping. ", bold: true }, "The output probability is hard-clamped to prevent overclaiming certainty on inherently noisy short-term binary markets:"]),
      p(""),
      makeTable(
        ["Timeframe", "Minimum P(UP)", "Maximum P(UP)", "Rationale"],
        [
          ["5m", "0.30 (30%)", "0.70 (70%)", "5-minute price returns are close to random walk. Claiming >70% is almost certainly overfit."],
          ["15m", "0.25 (25%)", "0.75 (75%)", "Slightly more signal at 15m, but still conservative bounds."],
        ],
        [1800, 2000, 2000, 3560]
      ),

      h2("5.4 Direction Determination"),
      p("Simple: if P(UP) >= 0.50, direction = UP. Otherwise, direction = DOWN."),

      new Paragraph({ children: [new PageBreak()] }),

      // ═══════════════════════════════ 6. EDGE DETECTION ═══════════════════════════════
      h1("6. Edge Detection & Trade Decision (Layer 4)"),

      h2("6.1 Jupiter Market Implied Probability"),
      p("Jupiter prediction markets provide binary UP/DOWN contracts priced in micro-USD (e.g., 650000 = $0.65 = 65% implied probability). The engine extracts:"),
      bullet("For \u201CUp\u201D side markets: jupiterProbUp = buyYesPriceUsd / 1,000,000"),
      bullet("For \u201CDown\u201D side markets: jupiterProbUp = 1 - (buyYesPriceUsd / 1,000,000)"),

      h2("6.2 Edge Computation"),
      p("Edge = our probability \u2013 the market\u2019s implied probability, in our predicted direction:"),
      p(""),
      bullet("If direction = UP: grossEdge = ourProbUp \u2013 marketProbUp"),
      bullet("If direction = DOWN: grossEdge = (1 \u2013 ourProbUp) \u2013 (1 \u2013 marketProbUp)"),
      p(""),
      pMulti([{ text: "Net Edge = Gross Edge \u2013 Estimated Fees (1.5%)", bold: true }]),
      p("The 1.5% estimated fee accounts for the bid/ask spread embedded in Jupiter prediction market pricing, which on a 5m market with ~$35,000 volume can be 1\u20134%."),

      h2("6.3 Trade Decision"),
      p("A trade is generated if and only if the signal passes all 6 quality filters (see Section 8). The key edge thresholds:"),
      bullet("Gross edge must be \u2265 5% (our probability is at least 5 percentage points above what the market implies)"),
      bullet("Net edge (after fees) must be \u2265 3.5%"),

      new Paragraph({ children: [new PageBreak()] }),

      // ═══════════════════════════════ 7. POSITION SIZING ═══════════════════════════════
      h1("7. Position Sizing \u2014 Quarter-Kelly Criterion"),
      p("The Kelly Criterion determines the mathematically optimal fraction of bankroll to bet, given estimated edge and odds. We use quarter-Kelly (25% of theoretical optimal) for safety."),

      h2("7.1 Kelly Formula"),
      p("Given:"),
      bullet("p = our estimated probability of winning"),
      bullet("b = decimal odds = (1 / marketPrice) \u2013 1, where marketPrice = Jupiter\u2019s implied price for our direction"),
      p(""),
      p("Full Kelly fraction: f* = (p(b+1) \u2013 1) / b", { bold: true }),
      p("Quarter Kelly: f = f* * 0.25", { bold: true }),
      p(""),
      pMulti([{ text: "Example: ", bold: true }, "If our P(UP) = 0.62 and Jupiter prices UP at 0.55 (so b = 1/0.55 - 1 = 0.818), then f* = (0.62 * 1.818 - 1) / 0.818 = 0.156 (15.6%). Quarter Kelly = 3.9%. On a $100 bankroll, bet $3.90."]),

      h2("7.2 Adjustments"),
      makeTable(
        ["Condition", "Adjustment", "Rationale"],
        [
          ["Recent drawdown > 10%", "f *= 0.5 (halve position)", "Reduce risk during losing streaks. Drawdown = -totalPnl / totalInvested."],
          ["Confidence < 0.6", "f *= 0.5", "Lower conviction = smaller bets"],
          ["Confidence < 0.4", "f = 0 (no trade)", "Insufficient signal quality to risk capital"],
          ["f > 0.05 (5%)", "f = 0.05 (hard cap)", "Never risk more than 5% of bankroll on a single prediction market trade"],
        ],
        [2400, 2800, 4160]
      ),

      h2("7.3 Bankroll Tracking"),
      p("The engine dynamically tracks bankroll based on cumulative invested amount plus realized PnL. After each trade, the scorer\u2019s bankroll is updated: bankroll = max(10, totalInvested + totalPnl). This ensures Kelly sizing adapts to the current account state."),

      new Paragraph({ children: [new PageBreak()] }),

      // ═══════════════════════════════ 8. QUALITY FILTERS ═══════════════════════════════
      h1("8. Quality Filters \u2014 6 Rejection Gates"),
      p("Every scored market must pass all 6 gates. If any single gate fails, the signal is rejected and no trade is placed. This is the engine\u2019s primary defense against overtrading."),
      p(""),
      makeTable(
        ["#", "Filter", "Threshold", "Rationale"],
        [
          ["1", "Confidence", "< 45% \u2192 REJECT", "Too few features agree on direction; insufficient conviction to trade."],
          ["2", "Gross Edge", "< 5% \u2192 REJECT", "Edge too small relative to market noise. At this level, transaction costs likely eat the edge."],
          ["3", "Net Edge (after 1.5% fees)", "< 3.5% \u2192 REJECT", "After accounting for Jupiter spread + execution friction, residual edge must be meaningful."],
          ["4", "Spread", "> 50 bps \u2192 REJECT", "Wide spread indicates illiquid market where execution costs are unpredictable."],
          ["5", "Market Lifecycle", "> 2 min (5m) or > 5 min (15m) \u2192 REJECT", "Late entry reduces expected edge: the market has already repriced based on new information. Per Claude Chat: \u201CBy the time you detect, fetch, infer, filter, size, execute: you\u2019re 60\u201390 seconds in.\u201D"],
          ["6", "Feature Quality", "< 50% \u2192 REJECT", "Too many critical features are stale or missing. 10 critical features checked: returns_1m, returns_5m, rsi_7, buy_sell_ratio, cvd_slope, book_imbalance_1, book_imbalance_5, microprice_deviation, funding_rate, long_short_ratio."],
        ],
        [400, 1600, 2800, 4560]
      ),

      new Paragraph({ children: [new PageBreak()] }),

      // ═══════════════════════════════ 9. CONFIDENCE ASSESSMENT ═══════════════════════════════
      h1("9. Confidence Assessment"),
      p("Confidence is a composite score (0\u20131) that measures how much we should trust the current signal. It is independent of probability \u2014 a signal can be directionally strong (P(UP) = 0.65) but low confidence (features disagreeing, stale data, thin volume)."),
      p(""),
      makeTable(
        ["Component", "Weight", "Scoring"],
        [
          ["Feature Agreement", "40%", "What % of directional features agree with the predicted direction. 100% agreement = 1.0, 50% = 0.5."],
          ["Strong Signal Count", "25%", "Number of features with |signal| > 0.5, capped at 5. Having 5+ strong signals = 1.0."],
          ["Volume Context", "15%", "Volume ratio / 2, clamped [0.3, 1.0]. Higher volume = more reliable signals."],
          ["Spread Context", "10%", "\u2264 5 bps = 1.0, \u2264 15 bps = 0.8, \u2264 30 bps = 0.6, \u2264 50 bps = 0.4, > 50 bps = 0.2"],
          ["Data Freshness", "10%", "Seconds since last pipeline update. \u2264 10s = 1.0, \u2264 30s = 0.8, \u2264 60s = 0.5, > 60s = 0.2"],
        ],
        [2000, 1200, 6160]
      ),

      p(""),
      p("Confidence = (Agreement * 0.40) + (StrongSignals * 0.25) + (Volume * 0.15) + (Spread * 0.10) + (Freshness * 0.10)", { bold: true }),

      new Paragraph({ children: [new PageBreak()] }),

      // ═══════════════════════════════ 10. TRADE EXECUTION ═══════════════════════════════
      h1("10. Trade Execution & Resolution"),

      h2("10.1 Trading Modes"),
      makeTable(
        ["Mode", "Execution", "Risk"],
        [
          ["Paper", "Virtual trades tracked server-side. Full signal logging with AI metrics. No real capital at risk.", "None"],
          ["Real", "Pending Solana wallet signing (requires SOLANA_PRIVATE_KEY). Will place on-chain trades via Jupiter API.", "Real capital"],
        ],
        [1600, 5760, 2000]
      ),

      h2("10.2 Trade Object"),
      p("Each trade stores comprehensive AI enrichment data for post-analysis:"),
      bullet("direction, edge, edgePct, betSize, entryPrice, market, timeframe"),
      bullet("aiProbUp \u2014 our estimated probability at entry"),
      bullet("marketProbUp \u2014 Jupiter\u2019s implied probability at entry"),
      bullet("confidence \u2014 signal confidence score"),
      bullet("netEdge \u2014 edge after estimated fees"),
      bullet("kellyFraction \u2014 position size as fraction of bankroll"),
      bullet("topFeatures \u2014 top 5 features driving this specific trade"),
      bullet("reasons \u2014 human-readable explanation of why this trade was taken"),

      h2("10.3 Resolution"),
      p("Paper trades are resolved 60 seconds after market close time. The engine first attempts to check Jupiter\u2019s actual market result. If unavailable, it falls back to edge-weighted simulation:"),
      bullet("P(win) = 0.5 + edge + (confidence * 0.1), clamped to [0.30, 0.75]"),
      bullet("PnL on win: betSize * (1/entryPrice - 1)"),
      bullet("PnL on loss: -betSize"),
      p(""),
      pMulti([{ text: "Note: ", bold: true }, "Simulated resolution is a temporary measure for paper trading. Real trades will use actual Jupiter market resolution."]),

      new Paragraph({ children: [new PageBreak()] }),

      // ═══════════════════════════════ 11. RISK MANAGEMENT ═══════════════════════════════
      h1("11. Risk Management"),

      h2("11.1 Position-Level Controls"),
      bullet("Maximum 5% of bankroll per trade (hard cap in Kelly sizing)"),
      bullet("Quarter-Kelly ensures positions are 75% smaller than theoretical optimal"),
      bullet("6 quality filters prevent trades in adverse conditions"),

      h2("11.2 Portfolio-Level Controls"),
      bullet("Drawdown tracking: when cumulative losses exceed 10% of invested capital, all position sizes are halved"),
      bullet("Confidence gating: trades below 45% confidence are rejected entirely"),
      bullet("Feature quality floor: trades are rejected when critical data sources are stale or missing"),

      h2("11.3 Market Structure Awareness"),
      bullet("Market lifecycle filter prevents entering stale markets (>2 min for 5m, >5 min for 15m)"),
      bullet("Spread filter (>50 bps) prevents trading in illiquid conditions"),
      bullet("Volume modifier dampens signals in low-volume periods"),

      h2("11.4 State Persistence"),
      p("All trade state, PnL, and configuration are persisted to prediction-state.json on Railway\u2019s filesystem. This survives process restarts and Railway deployments. On startup, the engine reloads previous state including running/stopped status, paper/real mode, and historical trades."),

      new Paragraph({ children: [new PageBreak()] }),

      // ═══════════════════════════════ 12. MONITORING ═══════════════════════════════
      h1("12. Monitoring & Observability"),

      h2("12.1 Pipeline Status Logging"),
      p("Every 60 seconds, the data pipeline logs per-asset status: candle counts (1m/5m/15m), trade buffer size, feature count, readiness, and key feature snapshots (RSI, MACD, book imbalance, buy/sell ratio, FNG, funding rate)."),

      h2("12.2 Scoring Statistics"),
      p("The engine tracks aggregate AI scoring metrics:"),
      bullet("totalScored \u2014 total number of markets evaluated by the AI"),
      bullet("totalPassed \u2014 signals that passed all quality filters"),
      bullet("totalRejected \u2014 signals rejected (with rejection reason breakdown)"),
      bullet("avgConfidence \u2014 running average confidence of passed signals"),
      bullet("avgEdge \u2014 running average gross edge of passed signals"),

      h2("12.3 Feature Importance Logging"),
      p("Every scored market logs its top 5 contributing features (name, signal strength, weight). A rolling buffer of 500 entries is maintained. The /ai/importance endpoint aggregates this into:"),
      bullet("Which features appear most often in top-5"),
      bullet("Average absolute signal strength per feature"),
      bullet("Percentage of predictions each feature influenced"),
      p("This is the foundation for future feature selection validation \u2014 answering the question: \u201CDo any of these features actually have statistically significant predictive power for 5-minute Jupiter markets?\u201D"),

      h2("12.4 API Endpoints"),
      makeTable(
        ["Endpoint", "Method", "Returns"],
        [
          ["/predictions/ai/status", "GET", "AI model info, pipeline readiness per asset, scoring statistics"],
          ["/predictions/ai/features/:asset", "GET", "Live feature values for BTC/ETH/SOL/XRP"],
          ["/predictions/ai/importance", "GET", "Feature importance aggregation from prediction log"],
          ["/predictions/markets", "GET", "All tracked Jupiter prediction markets"],
          ["/predictions/signals", "GET", "Last 100 signals (passed quality filters)"],
          ["/predictions/performance", "GET", "Paper + real trade history and win/loss stats"],
          ["/predictions/stream", "GET (SSE)", "Real-time signal, trade, and resolution events"],
        ],
        [3000, 1800, 4560]
      ),

      new Paragraph({ children: [new PageBreak()] }),

      // ═══════════════════════════════ 13. V2 ROADMAP ═══════════════════════════════
      h1("13. V2 Roadmap \u2014 ML Upgrade Path"),
      p("V1 (current) is intentionally rule-based to establish the data collection infrastructure and validate feature predictive power. The V2 path follows the consensus recommendation from Claude Chat, ChatGPT, and Grok:"),

      h2("Phase 0: Data Collection (Weeks 1\u20133, IN PROGRESS)"),
      bullet("Log every feature vector, every scored market, every trade outcome to PostgreSQL"),
      bullet("Accumulate 6+ months of feature-outcome pairs for training"),
      bullet("Validate which of the 27 features have statistically significant predictive power"),

      h2("Phase 1: XGBoost on 15\u201320 Best Features (Weeks 4\u20136)"),
      bullet("Train XGBoost classifier for P(UP) on validated features only"),
      bullet("Walk-forward validation: train on 14 days, test on 2 days, roll"),
      bullet("Strong regularization penalty to prevent overfitting on limited data"),
      bullet("Compare against V1 rule-based baseline"),

      h2("Phase 2: Calibration Layer (Weeks 7\u20138)"),
      bullet("Isotonic regression or Platt scaling on XGBoost outputs"),
      bullet("Verify calibration by probability bucket (does 60% predicted = 60% actual?)"),
      bullet("Brier score monitoring (<0.24 target)"),

      h2("Phase 3: Risk & Degradation Monitoring (Weeks 9\u201310)"),
      bullet("Real-time Brier score monitor that pauses trading when calibration degrades"),
      bullet("Regime detection: trending vs mean-reverting vs choppy"),
      bullet("Model staleness detection with emergency retrain triggers"),

      h2("Phase 4: LSTM/Transformer (Only If XGBoost Shows Signal)"),
      bullet("Per Claude Chat: \u201CLSTM is probably wrong for this use case\u201D at 5m resolution"),
      bullet("If sequence patterns prove useful, use shallow transformer on 1m candles over 30-minute window"),
      bullet("Only add if V1+XGBoost leaves a measurable gap"),

      new Paragraph({ children: [new PageBreak()] }),

      // ═══════════════════════════════ 14. LIMITATIONS ═══════════════════════════════
      h1("14. Known Limitations & Honest Assessment"),
      p("Per Claude Chat\u2019s review: \u201CThe risk is that it\u2019s been engineered for impressiveness when the problem calls for ruthless simplicity.\u201D This section documents known limitations honestly."),

      h2("14.1 Fundamental Constraints"),
      bulletMulti([{ text: "5-minute binary markets are extremely hard to beat consistently. ", bold: true }, "At 5-minute resolution, price returns are close to random walk. The edge from orderbook imbalance and OFI is real but operates at milliseconds scale \u2014 our engine polls every 30 seconds. We\u2019re capturing a diluted version of the signal."]),
      bulletMulti([{ text: "Break-even win rate is likely 55\u201357%, not 53%. ", bold: true }, "Jupiter prediction markets have a spread embedded in buyYesPriceUsd vs sellYesPriceUsd. Our 1.5% fee estimate may be conservative for low-volume markets."]),
      bulletMulti([{ text: "V1 uses no ML. ", bold: true }, "The weighted ensemble is a starting point. Feature weights are empirical estimates, not trained from data. Some weights are certainly suboptimal."]),

      h2("14.2 Data Limitations"),
      bulletMulti([{ text: "No historical training data. ", bold: true }, "V1 launched without backtesting against historical Jupiter market outcomes because that data doesn\u2019t exist in a structured API. The feature weights are informed by market microstructure literature, not trained."]),
      bulletMulti([{ text: "Free-tier API constraints. ", bold: true }, "Fear & Greed Index updates daily (stale for 5m decisions). LunarCrush/CryptoQuant social sentiment not yet integrated."]),
      bulletMulti([{ text: "Simulated paper trade resolution. ", bold: true }, "Until Jupiter market result checking works reliably, paper trades use edge-weighted random resolution. This means paper trading performance metrics are approximate, not ground truth."]),

      h2("14.3 Execution Constraints"),
      bulletMulti([{ text: "30-second polling cycle. ", bold: true }, "Jupiter markets are polled every 30s. On a 5-minute market, detection + scoring + execution takes 30\u201360 seconds. By the time we trade, we\u2019re potentially 1/5 through the market\u2019s life."]),
      bulletMulti([{ text: "No WebSocket to Jupiter. ", bold: true }, "A direct WebSocket (if available) would reduce latency significantly. Current architecture is REST-polling-based."]),
      bulletMulti([{ text: "Real trading requires Solana wallet signing. ", bold: true }, "Server-side signing with SOLANA_PRIVATE_KEY is not yet implemented. Currently, real-mode trades are logged as \u201Cpending_sign\u201D."]),

      h2("14.4 What We Don\u2019t Know Yet"),
      p("The single most important question for V2:"),
      pMulti([{ text: "\u201CDo any of these 27 features actually have statistically significant predictive power for 5-minute Jupiter markets at all?\u201D", bold: true, italics: true }]),
      p("If the answer is yes for 15 of them, we have a real engine. If the answer is marginal for all of them, no amount of LSTM sophistication changes the outcome. The feature importance logging infrastructure exists to answer this question."),

      // ═══════════════════════════════ END ═══════════════════════════════
      new Paragraph({ spacing: { before: 600 },
        border: { top: { style: BorderStyle.SINGLE, size: 2, color: "a855f7", space: 8 } },
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: "End of Methodology Document", size: 24, font: "Arial", color: "999999", italics: true })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 },
        children: [new TextRun({ text: "Ultimate Crypto Dashboard Pro  |  AI Prediction Engine v1.0.0  |  March 2026", size: 20, font: "Arial", color: "BBBBBB" })] }),
    ]
  }]
});

Packer.toBuffer(doc).then(buffer => {
  const outPath = "C:/Users/jjkat/OneDrive/Desktop/AI Projects/Dashboard ultimate/AI_Prediction_Engine_Methodology_V1.docx";
  fs.writeFileSync(outPath, buffer);
  console.log("Generated:", outPath);
  console.log("Size:", (buffer.length / 1024).toFixed(1), "KB");
});
