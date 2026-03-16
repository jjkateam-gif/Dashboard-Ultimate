const PDFDocument = require('pdfkit');
const fs = require('fs');

const doc = new PDFDocument({
  size: 'A4',
  margins: { top: 50, bottom: 50, left: 55, right: 55 },
  info: {
    Title: 'Ultimate Crypto Backtester Pro — Complete Probability Engine Logic v3',
    Author: 'Dashboard Ultimate',
    Subject: 'Full technical documentation of the probability engine pipeline',
    CreationDate: new Date(),
  }
});

const stream = fs.createWriteStream('Probability_Engine_Logic_v3.pdf');
doc.pipe(stream);

// Color palette
const C = {
  bg: '#0a0f0d',
  green: '#00c77b',
  red: '#e04060',
  yellow: '#d4a020',
  purple: '#8a6ae0',
  blue: '#4a90d9',
  orange: '#e07030',
  white: '#1a1a2e',
  gray: '#555555',
  lightGray: '#888888',
  darkBg: '#0d1b14',
  accent: '#00c77b',
};

// Fonts
const TITLE_SIZE = 22;
const H1_SIZE = 15;
const H2_SIZE = 12;
const H3_SIZE = 10.5;
const BODY_SIZE = 9;
const SMALL_SIZE = 7.5;
const CODE_SIZE = 8;

let pageNum = 0;

function addHeader() {
  // Top bar
  doc.rect(0, 0, doc.page.width, 35).fill('#0d1b14');
  doc.fontSize(8).fill('#00c77b').font('Helvetica-Bold')
    .text('ULTIMATE CRYPTO BACKTESTER PRO', 55, 12, { continued: true })
    .fill('#666666').font('Helvetica')
    .text('  |  Probability Engine Logic v3  |  ' + new Date().toLocaleDateString(), { continued: false });
  doc.moveTo(0, 35).lineTo(doc.page.width, 35).strokeColor('#00c77b').lineWidth(0.5).stroke();
}

function addFooter() {
  pageNum++;
  const y = doc.page.height - 35;
  doc.moveTo(55, y).lineTo(doc.page.width - 55, y).strokeColor('#333333').lineWidth(0.3).stroke();
  doc.fontSize(7).fill('#666666').font('Helvetica')
    .text(`Page ${pageNum}`, 55, y + 8, { width: doc.page.width - 110, align: 'center' });
  doc.text('CONFIDENTIAL', 55, y + 8, { width: doc.page.width - 110, align: 'right' });
}

function newPage() {
  doc.addPage();
  addHeader();
  addFooter();
  doc.y = 50;
}

function checkSpace(needed = 80) {
  if (doc.y > doc.page.height - 80 - needed) {
    newPage();
  }
}

function h1(text) {
  checkSpace(40);
  doc.moveDown(0.8);
  doc.rect(55, doc.y, doc.page.width - 110, 24).fill('#0d1b14');
  doc.fontSize(H1_SIZE).fill('#00c77b').font('Helvetica-Bold').text(text, 62, doc.y + 5);
  doc.y += 30;
  doc.x = 55;
}

function h2(text) {
  checkSpace(30);
  doc.moveDown(0.5);
  doc.fontSize(H2_SIZE).fill('#e07030').font('Helvetica-Bold').text(text, 55);
  doc.moveTo(55, doc.y + 2).lineTo(250, doc.y + 2).strokeColor('#e07030').lineWidth(0.3).stroke();
  doc.moveDown(0.3);
}

function h3(text) {
  checkSpace(25);
  doc.moveDown(0.3);
  doc.fontSize(H3_SIZE).fill('#4a90d9').font('Helvetica-Bold').text(text, 55);
  doc.moveDown(0.2);
}

function body(text) {
  checkSpace(20);
  doc.fontSize(BODY_SIZE).fill('#333333').font('Helvetica').text(text, 55, undefined, { width: doc.page.width - 110, lineGap: 3 });
}

function bullet(text, indent = 0) {
  checkSpace(15);
  const x = 62 + indent;
  doc.fontSize(BODY_SIZE).fill('#00c77b').font('Helvetica').text('>', x, doc.y, { continued: true });
  doc.fill('#333333').font('Helvetica').text('  ' + text, { width: doc.page.width - 110 - indent, lineGap: 2 });
}

function codeLine(text) {
  checkSpace(14);
  doc.rect(62, doc.y - 1, doc.page.width - 124, 13).fill('#f5f5f0');
  doc.fontSize(CODE_SIZE).fill('#1a1a2e').font('Courier').text(text, 66, doc.y + 1, { width: doc.page.width - 130 });
  doc.moveDown(0.15);
}

function tableRow(cols, widths, isHeader = false) {
  checkSpace(18);
  const startX = 62;
  let x = startX;
  const y = doc.y;
  const h = 16;

  if (isHeader) {
    doc.rect(startX - 4, y - 2, widths.reduce((a, b) => a + b, 0) + 8, h).fill('#0d1b14');
  } else {
    doc.rect(startX - 4, y - 2, widths.reduce((a, b) => a + b, 0) + 8, h).fill('#fafafa');
  }

  cols.forEach((col, i) => {
    doc.fontSize(isHeader ? 7.5 : 7.5)
      .fill(isHeader ? '#00c77b' : '#333333')
      .font(isHeader ? 'Helvetica-Bold' : 'Helvetica')
      .text(String(col), x, y + 2, { width: widths[i] - 4 });
    x += widths[i];
  });
  doc.y = y + h;
}

function note(text) {
  checkSpace(25);
  doc.rect(58, doc.y, doc.page.width - 116, 1).fill('#d4a020');
  doc.y += 4;
  doc.fontSize(8).fill('#8a6a20').font('Helvetica-BoldOblique').text('NOTE: ' + text, 62, undefined, { width: doc.page.width - 124, lineGap: 2 });
  doc.moveDown(0.3);
}

function formula(text) {
  checkSpace(18);
  doc.rect(62, doc.y - 2, doc.page.width - 124, 16).fill('#f0f5f2');
  doc.rect(62, doc.y - 2, 3, 16).fill('#00c77b');
  doc.fontSize(CODE_SIZE).fill('#1a1a2e').font('Courier-Bold').text(text, 72, doc.y + 1, { width: doc.page.width - 140 });
  doc.moveDown(0.3);
}

// ═══════════════════════════════════════════════════════════
// PAGE 1 — COVER
// ═══════════════════════════════════════════════════════════
doc.rect(0, 0, doc.page.width, doc.page.height).fill('#0a0f0d');

// Title block
doc.rect(0, 180, doc.page.width, 3).fill('#00c77b');
doc.fontSize(28).fill('#00c77b').font('Helvetica-Bold')
  .text('PROBABILITY ENGINE', 55, 210, { width: doc.page.width - 110, align: 'center' });
doc.fontSize(16).fill('#ffffff')
  .text('Complete Logic Documentation v3', 55, 248, { width: doc.page.width - 110, align: 'center' });
doc.rect(0, 280, doc.page.width, 3).fill('#00c77b');

// Subtitle info
doc.fontSize(10).fill('#666666').font('Helvetica')
  .text('Ultimate Crypto Backtester Pro', 55, 310, { width: doc.page.width - 110, align: 'center' });
doc.fontSize(9).fill('#888888')
  .text('12-Step Pipeline  |  7 Indicators  |  10 Research-Backed Improvements  |  10 Cross-AI Feedback Fixes', 55, 335, { width: doc.page.width - 110, align: 'center' });

// Version info
doc.fontSize(8).fill('#555555').font('Helvetica')
  .text('Document Version: 3.0', 55, 400, { width: doc.page.width - 110, align: 'center' });
doc.text('Generated: ' + new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString(), 55, 415, { width: doc.page.width - 110, align: 'center' });
doc.text('Engine Size: ~1.08M characters | Single-file monolithic frontend', 55, 430, { width: doc.page.width - 110, align: 'center' });

// Feature boxes
const features = [
  ['Calibrated Kelly Sizing', 'Calibration feedback loop adjusts position sizing based on actual prediction accuracy'],
  ['A-Grade Auto Leverage', 'Automatically applies 2x leverage when market conditions are excellent'],
  ['Entry Efficiency Filter', 'Prevents chasing extended moves with Excellent/Acceptable/Late/Chasing classification'],
  ['Cross-Asset Correlation', 'Discounts correlated signals to prevent naive position stacking'],
];
let boxY = 480;
features.forEach(([title, desc]) => {
  doc.rect(80, boxY, doc.page.width - 160, 32).lineWidth(0.5).strokeColor('#1a3a25').stroke();
  doc.rect(80, boxY, 4, 32).fill('#00c77b');
  doc.fontSize(8).fill('#00c77b').font('Helvetica-Bold').text(title, 92, boxY + 5);
  doc.fontSize(7).fill('#888888').font('Helvetica').text(desc, 92, boxY + 17, { width: doc.page.width - 185 });
  boxY += 38;
});

addFooter();

// ═══════════════════════════════════════════════════════════
// PAGE 2 — TABLE OF CONTENTS
// ═══════════════════════════════════════════════════════════
newPage();
doc.y = 55;
doc.fontSize(18).fill('#00c77b').font('Helvetica-Bold').text('TABLE OF CONTENTS', 55, doc.y);
doc.moveDown(1);

const toc = [
  ['STEP 1', 'Engine Trigger', 'runProbEngine() initialization and user inputs'],
  ['STEP 2', 'Fetch BTC Macro Regime', 'Blended regime detection for altcoins'],
  ['STEP 3', 'Asset Loop & Cross-TF Fetch', 'Parallel data fetching and higher-TF bias'],
  ['STEP 4', 'Compute Live Signals', '7 indicators with TF-adaptive parameters'],
  ['STEP 5', 'Market Quality Grade', 'A/B/C/No-Trade environment scoring'],
  ['STEP 6', 'Entry Efficiency Filter', 'Prevent chasing extended moves'],
  ['STEP 7', 'Blend Regime for Altcoins', 'Gradient numeric blending (not binary)'],
  ['STEP 8', 'Score Confluence', 'Family dampening, priority waterfall, calibration'],
  ['STEP 9', 'Estimate Risk/Reward', 'Structural stops, calibrated Kelly, auto leverage'],
  ['STEP 10', 'Post-Scoring Adjustments', 'Correlation discount, entry penalty, leverage penalty'],
  ['STEP 11', 'Calibration Tracking', 'Record, resolve, and feed back predictions'],
  ['STEP 12', 'Sort, Render & Auto-Trade', 'Card UI, execution gates, MQ sizing'],
];

toc.forEach(([step, title, desc], i) => {
  const y = doc.y;
  doc.rect(55, y, doc.page.width - 110, 22).fill(i % 2 === 0 ? '#fafafa' : '#ffffff');
  doc.fontSize(8).fill('#00c77b').font('Helvetica-Bold').text(step, 62, y + 4);
  doc.fontSize(9).fill('#1a1a2e').font('Helvetica-Bold').text(title, 120, y + 3);
  doc.fontSize(7).fill('#888888').font('Helvetica').text(desc, 120, y + 13, { width: 350 });
  doc.y = y + 24;
});

doc.moveDown(1);
doc.fontSize(8).fill('#555555').font('Helvetica-BoldOblique')
  .text('This document covers the complete pipeline from scan trigger to trade execution,', 55)
  .text('including all research-backed improvements and cross-AI feedback fixes.', 55);

// ═══════════════════════════════════════════════════════════
// STEP 1 — ENGINE TRIGGER
// ═══════════════════════════════════════════════════════════
newPage();
h1('STEP 1: Engine Trigger');
body('When the user clicks "Scan Now" or the background auto-scan timer fires, the engine begins its 12-step pipeline. The function runProbEngine() orchestrates everything.');
doc.moveDown(0.3);

h3('Initialization');
bullet('Sets PROBE.running = true to prevent duplicate concurrent scans');
bullet('Reads user-selected timeframe (e.g., 4h) from the UI dropdown');
bullet('Reads user-selected leverage (e.g., 1x, 2x, 5x) from the UI');
bullet('Clears previously logged trade indices for fresh scan results');
bullet('Shows loading animation with asset count, timeframe, and cross-TF info');

doc.moveDown(0.3);
h3('Background Auto-Scan Timer');
body('The auto-scan timer runs in the background even when the user navigates away from the Best Trades tab. Intervals are timeframe-smart:');
doc.moveDown(0.2);

const scanIntervals = [
  ['Timeframe', 'Scan Interval', 'Rationale'],
  ['1m', '60 seconds', 'Every candle close'],
  ['5m', '3 minutes', 'Every other candle'],
  ['15m', '10 minutes', '2/3 of a candle'],
  ['1h', '30 minutes', 'Half a candle'],
  ['4h', '60 minutes', 'Quarter of a candle'],
  ['1d', '4 hours', 'Reasonable daily check'],
];
const w1 = [100, 120, 250];
scanIntervals.forEach((row, i) => tableRow(row, w1, i === 0));

// ═══════════════════════════════════════════════════════════
// STEP 2 — BTC MACRO REGIME
// ═══════════════════════════════════════════════════════════
newPage();
h1('STEP 2: Fetch BTC Macro Regime');
body('Before scanning individual assets, the engine fetches BTC candle data once and detects the macro market regime. BTC is the crypto market — its regime affects all altcoins.');

doc.moveDown(0.3);
h3('detectCurrentRegime() Logic');
bullet('EMA 50 vs EMA 200 position: EMA50 > EMA200 + price > EMA200 = Bull');
bullet('Both EMA50 and price below EMA200 = Bear');
bullet('Mixed conditions = Sideways');

doc.moveDown(0.2);
h3('Volatility Suffix Detection');
body('Compares recent 20-bar ATR average to older 30-bar ATR average:');
bullet('Recent ATR > 1.3x older = "_volatile" suffix (expanding volatility)');
bullet('Recent ATR < 0.7x older = "_squeeze" suffix (contracting volatility)');

doc.moveDown(0.2);
h3('Possible Regime Outputs');
const regimes = [
  ['Regime', 'Meaning', 'Trading Implication'],
  ['bull', 'Clear uptrend', 'Longs favored, +4 pts for longs'],
  ['bear', 'Clear downtrend', 'Shorts favored, +4 pts for shorts'],
  ['sideways', 'Ranging / mixed', 'Trade range extremes only'],
  ['bull_volatile', 'Uptrend + expanding vol', 'Opportunities but size down'],
  ['bear_squeeze', 'Downtrend + low vol', 'Breakout imminent, be ready'],
];
const w2 = [110, 150, 210];
regimes.forEach((row, i) => tableRow(row, w2, i === 0));

// ═══════════════════════════════════════════════════════════
// STEP 3 — ASSET LOOP & CROSS-TF
// ═══════════════════════════════════════════════════════════
newPage();
h1('STEP 3: Asset Loop & Cross-TF Fetch');
body('For each tracked asset (BTC, ETH, SOL, etc.), two parallel requests fire simultaneously to minimize latency:');

doc.moveDown(0.3);
h3('Parallel Data Fetching');
bullet('Base timeframe candles: ~500 bars from Binance (e.g., 500 x 4h candles)');
bullet('Higher timeframe candles: via fetchCrossTFBias() for cross-TF alignment');

doc.moveDown(0.3);
h3('Cross-Timeframe Map');
const ctfMap = [
  ['Base TF', 'Higher TFs Checked', 'Multiplier'],
  ['5m', '15m, 1h', '3x + 12x'],
  ['15m', '1h, 4h', '4x + 16x'],
  ['30m', '4h, 1d', '8x + 48x'],
  ['1h', '4h, 1d', '4x + 24x'],
  ['4h', '1d, 1w', '6x + 42x'],
  ['1d', '1w', '7x (macro only)'],
];
const w3 = [80, 160, 230];
ctfMap.forEach((row, i) => tableRow(row, w3, i === 0));

doc.moveDown(0.4);
h3('quickTrendBias() — Higher TF Scoring');
body('Each higher timeframe is scored using 4 sub-indicators with weighted scoring:');
bullet('EMA 200 position (double-weighted) — most research-backed HTF filter');
bullet('EMA 21/55 trend direction — golden cross / death cross');
bullet('RSI > 50 = bullish momentum, < 50 = bearish');
bullet('MACD histogram direction — Elder\'s preferred Screen 1 indicator');

doc.moveDown(0.2);
formula('bullPts = (EMA200 ? 2 : 0) + (EMA_bull ? 1 : 0) + (RSI_bull ? 1 : 0) + (MACD_bull ? 1 : 0)');
formula('strength = |ratio - 0.5| * 2    // 0 = mixed, 1 = full agreement');

// ═══════════════════════════════════════════════════════════
// STEP 4 — COMPUTE LIVE SIGNALS
// ═══════════════════════════════════════════════════════════
newPage();
h1('STEP 4: Compute Live Signals');
body('Runs 7 indicators on the base timeframe candle data. Each indicator returns bull/bear/neutral signals. Parameters now adapt to the selected timeframe.');

doc.moveDown(0.2);
note('Stale Candle Guard: If the most recent candle range is <25% of the average (barely formed), it is excluded from ATR calculation to prevent false squeeze/volatility signals.');

doc.moveDown(0.3);
h2('4a. RSI (14-period) — Regime-Adaptive Thresholds');
body('Thresholds shift based on whether price is above or below EMA 200:');

const rsiThresh = [
  ['Regime', 'Oversold Threshold', 'Overbought Threshold', 'Why'],
  ['Bull (above EMA200)', '<= 40', '>= 75', 'RSI rarely hits 30 in bull markets'],
  ['Bear (below EMA200)', '<= 25', '>= 55', 'RSI rarely hits 70 in bear markets'],
  ['Neutral', '<= 35', '>= 65', 'Standard balanced thresholds'],
];
const w4 = [110, 100, 100, 160];
rsiThresh.forEach((row, i) => tableRow(row, w4, i === 0));

doc.moveDown(0.4);
h2('4b. EMA 21/55 Trend');
bullet('If EMA spread < 0.5% => Flat/Ranging (neutral signal, no points)');
bullet('EMA 21 > EMA 55 => Bull trend');
bullet('EMA 21 < EMA 55 => Bear trend');
bullet('Detects golden crosses and death crosses for bonus points');

doc.moveDown(0.4);
h2('4c. MACD — TF-Adaptive Parameters');
body('Parameters now adapt per timeframe instead of one-size-fits-all:');

const macdParams = [
  ['Timeframe Range', 'Fast / Slow / Signal', 'Rationale'],
  ['1m - 15m (Short)', '5 / 13 / 8', 'Faster, responsive to micro-momentum'],
  ['30m - 4h (Medium)', '5 / 35 / 5', 'Crypto-optimized (research-backed)'],
  ['1d+ (Long)', '12 / 26 / 9', 'Traditional, better for daily/weekly trends'],
];
const w5 = [130, 130, 210];
macdParams.forEach((row, i) => tableRow(row, w5, i === 0));

doc.moveDown(0.2);
bullet('Neutral zone: MACD line within 0.1% of price = no momentum signal');
bullet('Cross quality filter: only crosses >0.2% from zero line count as strong');

newPage();
h2('4d. Bollinger Bands (20-period, 2.5 std dev)');
bullet('2.5 sigma instead of 2.0 sigma (wider for crypto volatility)');
bullet('BB% < 15% => at lower band (bullish signal)');
bullet('BB% > 85% => at upper band (bearish signal)');
bullet('BBWP Squeeze: bandwidth percentile over 100 bars. Bottom 20th = squeeze');
note('The BB squeeze bonus (+8 pts) is applied independently OUTSIDE the family dampening loop, since it measures volatility compression, not mean-reversion.');

doc.moveDown(0.4);
h2('4e. StochRSI (14-period) — Regime-Adaptive');
const stochThresh = [
  ['Regime', 'Oversold', 'Overbought'],
  ['Bull', '<= 25', '>= 85'],
  ['Bear', '<= 15', '>= 75'],
  ['Neutral', '<= 20', '>= 80'],
];
const w6 = [160, 155, 155];
stochThresh.forEach((row, i) => tableRow(row, w6, i === 0));

doc.moveDown(0.4);
h2('4f. Ichimoku Cloud — TF-Adaptive Periods');
body('Periods adapt to timeframe. Traditional 9/26/52 works at micro scale, crypto-adjusted periods for longer horizons:');

const ichiParams = [
  ['Timeframe', 'Tenkan / Kijun / Span B', 'Rationale'],
  ['1m - 15m', '9 / 26 / 52', 'Traditional (works at micro scale)'],
  ['30m - 4h', '10 / 30 / 60', 'Moderate crypto adjustment'],
  ['1d+', '20 / 60 / 120', 'Full crypto-adjusted (24/7 markets)'],
];
const w7 = [120, 140, 210];
ichiParams.forEach((row, i) => tableRow(row, w7, i === 0));

doc.moveDown(0.2);
h3('Signal Logic');
bullet('Bull: Price above cloud AND Tenkan > Kijun (Chikou confirms = stronger)');
bullet('Bear: Price below cloud AND Tenkan < Kijun');
bullet('Neutral: Price inside cloud, or signals conflict');

doc.moveDown(0.4);
h2('4g. Volume — 3-Layer Analysis');
h3('Layer 1: Doji Filter');
bullet('If candle body < 15% of total range => doji => direction ambiguous => force neutral');

h3('Layer 1b: Body-Weighted Directional Ratio');
formula('dirRatio = 0.6 * (bodyDirection * bodyRatio) + 0.4 * wickBuyRatio');
bullet('60% weight to where the body closed, 40% to wick position');

h3('Layer 2: OBV (On-Balance Volume) Slope');
bullet('Builds running OBV from all candles, takes last 10 bars');
bullet('Linear regression on OBV => normalized slope');
bullet('Positive = accumulation, Negative = distribution');

h3('Layer 3: Combine');
bullet('Doji => always neutral (kills signal regardless)');
bullet('Volume < 0.5x avg => "drying up" (-5 pts penalty later)');
bullet('Volume > 1.5x + direction clear + OBV agrees => bull/bear signal');
bullet('OBV diverges from candle direction => neutral (conflicting flow)');

// ═══════════════════════════════════════════════════════════
// STEP 5 — MARKET QUALITY GRADE
// ═══════════════════════════════════════════════════════════
newPage();
h1('STEP 5: Market Quality Grade');
body('Scores the trading environment to determine if it is worth trading. This directly affects position sizing, leverage caps, and auto-trade eligibility.');

doc.moveDown(0.3);
h3('Scoring Components');
const mqScoring = [
  ['Factor', 'Points', 'Logic'],
  ['ATR expanding (>1.2x old)', '+2', 'Expanding volatility = opportunity'],
  ['ATR normal', '+1', 'Baseline conditions'],
  ['ATR contracting', '-1', 'Choppy, low opportunity'],
  ['Volume > 1.2x avg', '+2', 'Above-average participation'],
  ['Volume normal (>0.7x)', '+1', 'Adequate flow'],
  ['Volume low (<0.7x)', '-1', 'Thin market, avoid'],
  ['EMA spread > 1%', '+2', 'Clear trend separation'],
  ['EMA spread > 0.5%', '+1', 'Moderate trend'],
  ['EMA flat (<0.5%)', '-1', 'Ranging / directionless'],
  ['BB squeeze detected', '+1', 'Breakout imminent'],
  ['BB bandwidth > 50th pctile', '+1', 'Decent bandwidth'],
  ['5+ indicators aligned', '+2', 'Strong directional agreement'],
  ['3+ indicators aligned', '+1', 'Moderate agreement'],
];
const w8 = [155, 50, 265];
mqScoring.forEach((row, i) => tableRow(row, w8, i === 0));

doc.moveDown(0.4);
h3('Grade Mapping & Impact');
const mqGrades = [
  ['Score', 'Grade', 'Position Size', 'Leverage Mult', 'Auto-Trade'],
  ['>= 7', 'A-Grade', '100%', '1.0x', 'Yes + 2x auto-lev'],
  ['>= 4', 'B-Grade', '80%', '0.8x', 'Yes'],
  ['>= 1', 'C-Grade', '50%', '0.5x', 'Yes (reduced)'],
  ['< 1', 'No-Trade', '0%', '0x', 'BLOCKED'],
];
const w9 = [55, 70, 90, 90, 165];
mqGrades.forEach((row, i) => tableRow(row, w9, i === 0));

// ═══════════════════════════════════════════════════════════
// STEP 6 — ENTRY EFFICIENCY
// ═══════════════════════════════════════════════════════════
newPage();
h1('STEP 6: Entry Efficiency Filter');
body('Measures how favorable the current price location is for entry. Prevents the engine from recommending trades when price has already moved significantly — a common cause of losing trades even with correct direction calls.');

doc.moveDown(0.3);
h3('Input Signals');
bullet('Distance from EMA 21 (how far price has deviated from short-term mean)');
bullet('Recent 3-bar impulse size relative to ATR');
bullet('Distance from Bollinger Band midline');
bullet('Whether last 3 candles are consecutively directional (runaway move)');

doc.moveDown(0.3);
h3('Classification Logic');
const entryEff = [
  ['Classification', 'Condition', 'Prob Penalty', 'Auto-Trade'],
  ['Excellent', 'Near EMA21 + near BB mid', '0 (none)', 'Allowed'],
  ['Acceptable', 'Default / normal', '0 (none)', 'Allowed'],
  ['Late', 'Impulse > 1.8x ATR', '-1 pt', 'Allowed'],
  ['Chasing', '3+ expansion bars OR impulse > 2.5x ATR', '-3 pts', 'BLOCKED'],
];
const w10 = [90, 180, 80, 120];
entryEff.forEach((row, i) => tableRow(row, w10, i === 0));

doc.moveDown(0.3);
note('Entry efficiency is a light penalty, not a hard block for manual trades. Only auto-trade blocks Chasing entries. This keeps the system from being overly restrictive.');

// ═══════════════════════════════════════════════════════════
// STEP 7 — BLEND REGIME
// ═══════════════════════════════════════════════════════════
h1('STEP 7: Blend Regime for Altcoins');
body('Uses gradient numeric scoring instead of binary logic. This preserves nuance: "BTC bull + SOL bear" is a genuine divergence warning, not just "sideways."');

doc.moveDown(0.3);
h3('Numeric Regime Scores');
formula('bull = +1,  sideways = 0,  bear = -1');

doc.moveDown(0.2);
h3('Blending Weights');
bullet('BTC itself: uses 100% own regime');
bullet('Major L1s (ETH, SOL, BNB): 50% BTC + 50% local (decouple more)');
bullet('All other alts: 60% BTC + 40% local (BTC-heavy)');

doc.moveDown(0.2);
formula('blendedScore = btcWeight * btcScore + (1 - btcWeight) * localScore');
formula('> 0.3 => bull  |  < -0.3 => bear  |  else => sideways');

doc.moveDown(0.2);
bullet('Volatility suffix (_volatile, _squeeze) always comes from local asset data');

// ═══════════════════════════════════════════════════════════
// STEP 8 — SCORE CONFLUENCE
// ═══════════════════════════════════════════════════════════
newPage();
h1('STEP 8: Score Confluence');
body('Called TWICE per asset — once for LONG, once for SHORT — to get both directional probabilities. The higher probability becomes the recommended direction.');

doc.moveDown(0.3);
h2('8a. Timeframe-Aware Indicator Weights');
const tfWeights = [
  ['Indicator', 'Short (1m-15m)', 'Med (30m-1h)', 'Long (6h-1w)', 'Default (2h-4h)'],
  ['RSI', '22', '18', '10', '12'],
  ['StochRSI', '22', '18', '8', '10'],
  ['BB', '18', '14', '7', '12'],
  ['EMA', '8', '14', '25', '20'],
  ['MACD', '10', '14', '18', '16'],
  ['Ichimoku', '5', '10', '22', '16'],
  ['Volume', '15', '12', '10', '14'],
];
const w11 = [75, 90, 90, 90, 95];
tfWeights.forEach((row, i) => tableRow(row, w11, i === 0));

doc.moveDown(0.2);
note('Short TFs favor mean-reversion (RSI, StochRSI). Long TFs favor trend (EMA, Ichimoku). This reflects how markets behave at different time horizons.');

doc.moveDown(0.4);
h2('8b. Family Correlation Dampening');
body('Indicators grouped into families. When multiple indicators from the same family agree, diminishing returns prevent inflation:');

const families = [
  ['Family', 'Indicators', '1st Signal', '2nd Signal', '3rd Signal'],
  ['Mean-Reversion', 'RSI, StochRSI, BB', '100%', '60%', '35%'],
  ['Trend', 'EMA, MACD, Ichimoku', '100%', '60%', '35%'],
  ['Flow', 'Volume', '100%', 'N/A', 'N/A'],
];
const w12 = [100, 130, 70, 70, 70];
families.forEach((row, i) => tableRow(row, w12, i === 0));

doc.moveDown(0.2);
body('Example: If RSI, StochRSI, and BB all signal bullish — RSI gets 100% weight, StochRSI gets 60%, BB gets 35%. This prevents 3 correlated signals from inflating probability like 3 independent signals would.');

doc.moveDown(0.4);
h2('8c. Trend vs Mean-Reversion Conflict');
bullet('If 2+ trend indicators point one direction (strong trend)...');
bullet('...but a mean-reversion indicator points the opposite way...');
bullet('...the mean-reversion signal is HALVED (fighting the trend)');
body('Example: RSI oversold but EMA + MACD + Ichimoku all bearish => RSI bullish signal cut to 50%.');

newPage();
h2('8d. Scoring Loop');
bullet('Aligned with direction => add weight x family dampening factor');
bullet('Cross bonus (golden cross, MACD cross): +30% extra');
bullet('Opposing direction => subtract 40% of weight');
bullet('Neutral => miss (zero points)');
bullet('BB Squeeze bonus => +8 pts (independent, not family-dampened)');
bullet('Volume drying up => -5 pts penalty');

doc.moveDown(0.3);
h2('8e. Sigmoid Mapping to Probability');
body('Raw confluence ratio (0-1) is mapped through a sigmoid curve:');
formula('prob = 28 + (78 - 28) / (1 + e^(-7 * (confluence - 0.5)))');
body('This creates an S-curve: 50% confluence = ~53% probability. Very high/low confluence asymptotically approaches 28%-78%.');

doc.moveDown(0.4);
h2('8f. Priority Waterfall — Contextual Adjustments');
body('Applied in order of predictive value. Each has a sub-cap. Global cap = +/-20 pts.');

const waterfall = [
  ['Priority', 'Factor', 'Sub-Cap', 'Details'],
  ['1 (Top)', 'Cross-TF Alignment', '+/-14', 'HTF aligned: +4 to +7/TF. Opposing: -8 to -12. All aligned: +4 bonus'],
  ['2', 'Regime', '+/-4', 'Bull + Long = +4. Bull + Short = -4. Same for bear.'],
  ['3', 'Funding Rate', '+/-4', 'Percentile-based: >95th longs = -3. <10th = +3. No data = SKIP.'],
  ['4', 'Historical Perf', '+/-6', 'Min 30 trades. 30-99 = 40% strength. 100+ = full.'],
  ['5', 'Optimizer', '+/-4', 'Personal backtester top-5 avg win rate adjustment.'],
];
const w13 = [55, 110, 50, 255];
waterfall.forEach((row, i) => tableRow(row, w13, i === 0));

doc.moveDown(0.2);
note('Funding rate fallback: When not enough percentile data (<20 data points), the system now SKIPS the adjustment instead of using stale hardcoded thresholds. Only extreme outliers (>0.15%) trigger fallback.');

doc.moveDown(0.4);
h2('8g. Confidence Rating & Probability Caps');
const confCaps = [
  ['Confluence', 'Confidence', 'Max Probability'],
  ['>= 65%', 'High', '76%'],
  ['>= 45%', 'Medium', '68%'],
  ['< 45%', 'Low', '58%'],
];
const w14 = [160, 155, 155];
confCaps.forEach((row, i) => tableRow(row, w14, i === 0));
doc.moveDown(0.1);
body('Minimum probability floor: 25%. This prevents the engine from showing anything below a quarter chance.');

// ═══════════════════════════════════════════════════════════
// STEP 9 — ESTIMATE R/R
// ═══════════════════════════════════════════════════════════
newPage();
h1('STEP 9: Estimate Risk/Reward');

h2('9a. Stop Loss — Structural Snapping');
body('The stop-loss calculation uses ATR as a baseline, then snaps to actual market structure:');

bullet('Start with 2.0x ATR as default stop distance');
bullet('Run findSwingPoints() on candle data (left=5, right=3 bar confirmation)');
bullet('Check if any swing point exists within +/-0.5x ATR of default stop (last 50 candles)');
bullet('If found => snap stop to that swing point (with 0.1x ATR buffer below/above)');
bullet('Clamp: never tighter than 1.2x ATR, never wider than 3.0x ATR');

doc.moveDown(0.2);
note('Stops placed at actual structure (support/resistance) are less likely to get wicked out by noise compared to arbitrary ATR-only stops.');

doc.moveDown(0.3);
h2('9b. Take Profit Target');
body('Inverted relationship — high probability setups use tighter, more reliable targets:');
const tpMults = [
  ['Probability', 'Target Multiple', 'Rationale'],
  ['>= 72%', '2.0x ATR', 'High confidence, take reliable target'],
  ['>= 62%', '2.5x ATR', 'Moderate, balanced R:R'],
  ['< 62%', '3.0x ATR', 'Low confidence needs wider target to justify risk'],
];
const w15 = [130, 130, 210];
tpMults.forEach((row, i) => tableRow(row, w15, i === 0));

doc.moveDown(0.3);
h2('9c. Fee Calculation');
formula('Round-trip fees = 0.06% * 2 * leverage  (BloFin taker fee per side)');
formula('Net target = target% - (fee impact / leverage)');

doc.moveDown(0.3);
h2('9d. Leveraged P&L');
formula('levStopPct = stopPct * leverage');
formula('levTargetPct = netTargetPct * leverage');
formula('R:R = levTargetPct / levStopPct');

doc.moveDown(0.3);
h2('9e. Expected Value');
formula('EV = (prob/100 * levTargetPct) - ((1 - prob/100) * levStopPct)');
body('Positive EV = statistical edge. Negative EV = avoid. Auto-trade requires positive EV.');

doc.moveDown(0.3);
h2('9f. Calibrated Kelly Criterion');
body('Kelly sizing now uses CALIBRATED probability (from actual prediction accuracy), not raw:');
formula('calibratedProb = getCalibratedProb(rawProb)  // uses tracked win rates');
formula('kellyFrac = ((calibratedProb/100) * RR - (1 - calibratedProb/100)) / RR');
formula('safeKelly = max(0, kellyFrac * 0.5)  // Half-Kelly for safety');
formula('optimalLev = floor(safeKelly / (stopPct / 100))');
doc.moveDown(0.1);
body('The display shows raw probability (what indicators say). Position sizing uses calibrated probability (what actually happens). This bridges the gap between theoretical and real performance.');

newPage();
h2('9g. Confidence x Market Quality Leverage Caps');
body('Even if Kelly recommends high leverage, hard caps prevent overexposure:');
const levCaps = [
  ['Confidence', 'Base Cap', 'A-Grade (x1.0)', 'B-Grade (x0.8)', 'C-Grade (x0.5)'],
  ['High', '10x', '10x', '8x', '5x'],
  ['Medium', '5x', '5x', '4x', '2x'],
  ['Low', '2x', '2x', '1x', '1x'],
];
const w16 = [80, 80, 90, 90, 90];
levCaps.forEach((row, i) => tableRow(row, w16, i === 0));

doc.moveDown(0.4);
h2('9h. A-Grade Auto Leverage Boost');
body('When market conditions are excellent, the engine automatically applies a minimum 2x leverage:');
bullet('Market Quality = A (score >= 7)');
bullet('Confidence = Medium or High');
bullet('Expected Value is positive');
bullet('=> Optimal leverage boosted to minimum 2x');
bullet('=> Recommended mode flips from "spot" to "perps 2x"');
doc.moveDown(0.2);
note('This is a floor, not a ceiling. If Kelly math supports higher leverage, it can go up to the confidence x market quality cap. The 2x boost just ensures A-grade setups aren\'t left on spot when they could benefit from leverage.');

// ═══════════════════════════════════════════════════════════
// STEP 10 — POST-SCORING ADJUSTMENTS
// ═══════════════════════════════════════════════════════════
newPage();
h1('STEP 10: Post-Scoring Adjustments');
body('After all assets are individually scored, three portfolio-level adjustments are applied:');

doc.moveDown(0.3);
h2('10a. Leverage Penalty');
body('If user selected leverage > 1x, a non-linear penalty is applied to probability:');
formula('penalty = 3.3 * leverage^0.75 - 3.3');
const levPen = [
  ['Leverage', 'Penalty', 'Rationale'],
  ['2x', '-2%', 'Minor risk increase'],
  ['5x', '-7%', 'Moderate — stops hit more often'],
  ['10x', '-15%', 'Significant — noise becomes lethal'],
  ['20x', '-25%', 'Extreme — most trades will fail'],
];
const w17 = [130, 130, 210];
levPen.forEach((row, i) => tableRow(row, w17, i === 0));

doc.moveDown(0.4);
h2('10b. Cross-Asset Correlation Discount');
body('When 3+ assets signal the same direction above 60% probability, they are likely correlated (one bet in disguise). Small discounts prevent naive position stacking:');
bullet('Top-ranked asset: full probability (no discount)');
bullet('2nd asset: -2 pts');
bullet('3rd asset: -3 pts');
bullet('4th+ assets: -4 pts each');
doc.moveDown(0.1);
note('This is a light touch — doesn\'t kill trades, just flags that BTC/ETH/SOL all going long together is really one crypto-beta trade, not three independent opportunities.');

doc.moveDown(0.4);
h2('10c. Entry Efficiency Penalty');
bullet('Chasing entries: -3 pts to probability');
bullet('Late entries: -1 pt to probability');
bullet('Acceptable / Excellent entries: no penalty');

// ═══════════════════════════════════════════════════════════
// STEP 11 — CALIBRATION TRACKING
// ═══════════════════════════════════════════════════════════
newPage();
h1('STEP 11: Calibration Tracking');
body('Premium-level prediction accountability. Tracks what the engine predicted vs what actually happened, building a reliability diagram over time.');

doc.moveDown(0.3);
h2('11a. Recording Predictions');
bullet('Every signal with probability >= 55% is recorded to localStorage');
bullet('Stores: asset, timeframe, probability, direction, entry/stop/target prices, timestamp');
bullet('Capped at 500 pending predictions to prevent localStorage bloat');

doc.moveDown(0.3);
h2('11b. Resolving Predictions');
body('On each scan, pending predictions are checked against current price:');
bullet('If current price hit TARGET price => resolved as WIN');
bullet('If current price hit STOP price => resolved as LOSS');
bullet('If older than 30 days => expired and discarded');

doc.moveDown(0.3);
h2('11c. Bucketing Results');
bullet('Results grouped into 5% probability buckets (e.g., 55-60%, 60-65%, 65-70%)');
bullet('Each bucket tracks: total predictions and total wins');
bullet('This builds a reliability diagram showing calibration accuracy');

doc.moveDown(0.3);
h2('11d. Calibration Feedback Loop (NEW)');
body('The key innovation: calibration data feeds back into position sizing via getCalibratedProb():');
formula('If bucket has 20+ resolved predictions:');
formula('  weight = predictions / (predictions + 50)  // Bayesian shrinkage');
formula('  calibratedProb = rawProb * (1 - weight) + actualWinRate * weight');
doc.moveDown(0.2);
body('Example: Engine says 65% but the 65-70% bucket has historically won only 58% over 80 trades:');
formula('  weight = 80 / (80 + 50) = 0.615');
formula('  calibratedProb = 65 * 0.385 + 58 * 0.615 = 60.7%');
body('Kelly sizing uses 60.7% instead of 65%, resulting in more conservative (and accurate) position sizes. As more data accumulates, the weight increases and calibration becomes more precise.');

// ═══════════════════════════════════════════════════════════
// STEP 12 — SORT, RENDER & AUTO-TRADE
// ═══════════════════════════════════════════════════════════
newPage();
h1('STEP 12: Sort, Render & Auto-Trade');

h2('12a. Sorting & Display');
bullet('All asset results sorted by probability descending');
bullet('Top setup gets gold medal badge (only if Medium+ confidence)');
bullet('Each card displays: direction, probability arc, R:R, market quality badge, entry efficiency, confidence, signals, EV, fees, sizing info');

doc.moveDown(0.3);
h2('12b. Recommendations Saved');
bullet('Any setup with >= 60% probability saved to backend for tracking');
bullet('Stores: symbol, direction, probability, entry/stop/target, R:R, timeframe, confidence, leverage, mode');

doc.moveDown(0.3);
h2('12c. Auto-Trade Execution Gates');
body('Before auto-trade places any order, ALL of these must be true:');
bullet('Probability >= user threshold (default 70%)');
bullet('Market quality != No-Trade');
bullet('Confidence = Medium or High (not Low)');
bullet('Entry efficiency != Chasing');
bullet('Expected value > 0 (positive edge)');
bullet('Open positions < max allowed');
bullet('Available balance >= position size');

doc.moveDown(0.3);
h2('12d. Market Quality Position Sizing');
body('Auto-trade adjusts position size based on market quality:');
const mqSizing = [
  ['Grade', 'Size Multiplier', 'Example ($100 base)'],
  ['A-Grade', '100%', '$100 (full size + 2x auto-lev)'],
  ['B-Grade', '80%', '$80'],
  ['C-Grade', '50%', '$50'],
  ['No-Trade', '0% (blocked)', 'Not executed'],
];
const w18 = [120, 140, 210];
mqSizing.forEach((row, i) => tableRow(row, w18, i === 0));

doc.moveDown(0.3);
h2('12e. Post-Scan Actions');
bullet('Alert dot flashes on trades tab if any setup >= 70%');
bullet('Background timer reschedules next scan based on timeframe');
bullet('Calibration predictions resolved for each asset');
bullet('Balance auto-refreshes every 30 seconds');

// ═══════════════════════════════════════════════════════════
// APPENDIX — COMPLETE FLOW DIAGRAM
// ═══════════════════════════════════════════════════════════
newPage();
h1('APPENDIX A: Complete Pipeline Flow');
doc.moveDown(0.3);

const flow = [
  ['1. TRIGGER', 'User clicks Scan / Auto-scan timer fires'],
  ['2. BTC REGIME', 'Fetch BTC candles => detectCurrentRegime()'],
  ['3. ASSET LOOP', 'For each asset: fetch base TF + higher TFs in parallel'],
  ['4. INDICATORS', '7 indicators computed with TF-adaptive parameters'],
  ['5. MKT QUALITY', 'Score environment: A/B/C/No-Trade'],
  ['6. ENTRY CHECK', 'Classify entry: Excellent/Acceptable/Late/Chasing'],
  ['7. REGIME BLEND', 'BTC + local regime blended with gradient scoring'],
  ['8. CONFLUENCE', 'Score both directions with family dampening + waterfall'],
  ['9. RISK/REWARD', 'Structural stops + calibrated Kelly + MQ leverage caps'],
  ['10. ADJUSTMENTS', 'Leverage penalty + correlation discount + entry penalty'],
  ['11. CALIBRATE', 'Record prediction + resolve pending + feed back to Kelly'],
  ['12. OUTPUT', 'Sort, render cards, save recs, auto-trade if enabled'],
];

flow.forEach(([step, desc], i) => {
  const y = doc.y;
  // Arrow connector
  if (i > 0) {
    doc.rect(88, y - 6, 2, 6).fill('#00c77b');
    doc.moveTo(84, y).lineTo(89, y - 3).lineTo(94, y).fill('#00c77b');
  }
  doc.rect(58, y + 2, doc.page.width - 116, 22).lineWidth(0.5).strokeColor('#1a3a25').stroke();
  doc.rect(58, y + 2, 90, 22).fill('#0d1b14');
  doc.fontSize(7.5).fill('#00c77b').font('Helvetica-Bold').text(step, 64, y + 8);
  doc.fontSize(8).fill('#333333').font('Helvetica').text(desc, 155, y + 8, { width: 330 });
  doc.y = y + 30;
});

// ═══════════════════════════════════════════════════════════
// APPENDIX B — VERSION HISTORY
// ═══════════════════════════════════════════════════════════
newPage();
h1('APPENDIX B: Version History');

doc.moveDown(0.3);
h2('v1.0 — Initial Engine');
bullet('Basic 7-indicator confluence scoring');
bullet('Fixed RSI/BB thresholds, fixed MACD 12/26/9');
bullet('Simple ATR-based stops, no structure');
bullet('No regime detection, no cross-TF analysis');

doc.moveDown(0.3);
h2('v2.0 — Research-Backed Overhaul (10 improvements)');
bullet('Family correlation dampening (100%/60%/35%)');
bullet('Blended BTC + local regime for alts');
bullet('3-layer volume analysis (doji + body-weighted + OBV)');
bullet('Structural stop snapping to swing points');
bullet('Priority waterfall for contextual adjustments');
bullet('Sample size guardrails (min 30 trades)');
bullet('Confidence-based leverage caps');
bullet('Market quality grade (A/B/C/No-Trade)');
bullet('Funding rate percentile thresholds');
bullet('Calibration tracking (record + resolve)');

doc.moveDown(0.3);
h2('v3.0 — Cross-AI Feedback (10 improvements)');
body('Based on analysis from Claude, ChatGPT, and Grok:');
bullet('Calibration feedback loop — Kelly uses actual win rates');
bullet('Market quality => position sizing (A=100%, B=80%, C=50%)');
bullet('Gradient regime blending (numeric, not binary)');
bullet('Cross-asset correlation discount');
bullet('TF-specific MACD parameters (5/13/8, 5/35/5, 12/26/9)');
bullet('TF-specific Ichimoku parameters (9/26/52, 10/30/60, 20/60/120)');
bullet('Entry efficiency filter (Excellent/Acceptable/Late/Chasing)');
bullet('Funding fallback: skip instead of stale hardcoded values');
bullet('Market quality x leverage caps (A=1.0, B=0.8, C=0.5)');
bullet('Stale candle guard (exclude <25% formed candles from ATR)');
bullet('A-grade auto 2x leverage boost for Medium+ confidence + positive EV');
bullet('Auto-trade gates: blocks No-Trade, Low confidence, Chasing, negative EV');

// Finalize
doc.end();

stream.on('finish', () => {
  console.log('PDF generated: Probability_Engine_Logic_v3.pdf');
  const stats = fs.statSync('Probability_Engine_Logic_v3.pdf');
  console.log('Size: ' + (stats.size / 1024).toFixed(0) + ' KB');
});
