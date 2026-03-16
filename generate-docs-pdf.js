const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');

const doc = new PDFDocument({
  size: 'A4',
  margins: { top: 50, bottom: 50, left: 55, right: 55 },
  info: {
    Title: 'Dashboard Ultimate - Complete Technical Documentation',
    Author: 'Dashboard Ultimate Team',
    Subject: 'Crypto Trading Dashboard Documentation',
    CreationDate: new Date()
  }
});

const output = fs.createWriteStream('Dashboard_Ultimate_Documentation.pdf');
doc.pipe(output);

// Color palette
const C = {
  bg: '#0a0f0d',
  green: '#00875a',
  greenLight: '#00f5a0',
  orange: '#cc5500',
  purple: '#7c3aed',
  blue: '#2563eb',
  red: '#dc2626',
  yellow: '#ca8a04',
  text: '#1a1a1a',
  textLight: '#4a4a4a',
  accent: '#0d6b3f',
  headerBg: '#0d1b12',
  tableBorder: '#d1d5db',
  tableHeader: '#f0fdf4',
  tableStripe: '#f9fafb',
};

let pageNum = 0;

// Helper functions
function addPage() {
  if (pageNum > 0) doc.addPage();
  pageNum++;
  // Footer
  doc.fontSize(8).fillColor('#999')
    .text(`Dashboard Ultimate Documentation — Page ${pageNum}`, 55, doc.page.height - 35, { align: 'center', width: doc.page.width - 110 });
  doc.y = 50;
}

function title(text, size = 24) {
  doc.fontSize(size).fillColor(C.accent).font('Helvetica-Bold').text(text);
  doc.moveDown(0.3);
  // Underline
  doc.moveTo(55, doc.y).lineTo(doc.page.width - 55, doc.y).strokeColor(C.green).lineWidth(2).stroke();
  doc.moveDown(0.6);
}

function heading(text, size = 16) {
  if (doc.y > doc.page.height - 120) addPage();
  doc.fontSize(size).fillColor(C.accent).font('Helvetica-Bold').text(text);
  doc.moveDown(0.3);
}

function subheading(text, size = 13) {
  if (doc.y > doc.page.height - 100) addPage();
  doc.fontSize(size).fillColor(C.orange).font('Helvetica-Bold').text(text);
  doc.moveDown(0.2);
}

function body(text) {
  if (doc.y > doc.page.height - 80) addPage();
  doc.fontSize(10).fillColor(C.text).font('Helvetica').text(text, { lineGap: 3 });
  doc.moveDown(0.4);
}

function bullet(text, indent = 0) {
  if (doc.y > doc.page.height - 70) addPage();
  const x = 65 + indent;
  doc.fontSize(10).fillColor(C.text).font('Helvetica');
  doc.text(`•  ${text}`, x, doc.y, { lineGap: 2, indent: 0 });
  doc.moveDown(0.15);
}

function codeBlock(text) {
  if (doc.y > doc.page.height - 100) addPage();
  const startY = doc.y;
  doc.fontSize(8.5).font('Courier').fillColor('#333');
  const textHeight = doc.heightOfString(text, { width: doc.page.width - 130 });
  // Background
  doc.save();
  doc.roundedRect(60, startY - 4, doc.page.width - 120, textHeight + 12, 4).fill('#f1f5f1');
  doc.restore();
  doc.fillColor('#1e3a29').text(text, 68, startY + 2, { width: doc.page.width - 140 });
  doc.moveDown(0.5);
}

function table(headers, rows) {
  const colWidth = (doc.page.width - 120) / headers.length;
  const startX = 60;
  let y = doc.y;

  if (y > doc.page.height - 150) { addPage(); y = doc.y; }

  // Header row
  doc.save();
  doc.rect(startX, y, doc.page.width - 120, 22).fill(C.tableHeader);
  doc.restore();
  headers.forEach((h, i) => {
    doc.fontSize(9).font('Helvetica-Bold').fillColor(C.accent)
      .text(h, startX + i * colWidth + 4, y + 5, { width: colWidth - 8 });
  });
  y += 22;

  // Data rows
  rows.forEach((row, ri) => {
    if (y > doc.page.height - 70) { addPage(); y = doc.y; }
    const rowH = 18;
    if (ri % 2 === 1) {
      doc.save();
      doc.rect(startX, y, doc.page.width - 120, rowH).fill(C.tableStripe);
      doc.restore();
    }
    row.forEach((cell, i) => {
      doc.fontSize(8.5).font('Helvetica').fillColor(C.text)
        .text(String(cell), startX + i * colWidth + 4, y + 4, { width: colWidth - 8 });
    });
    y += rowH;
  });
  doc.y = y + 8;
}

function spacer(n = 0.5) { doc.moveDown(n); }

function screenshot(filename, caption) {
  const imgPath = path.join(SCREENSHOTS_DIR, filename);
  if (!fs.existsSync(imgPath)) {
    body('[Screenshot not available: ' + filename + ']');
    return;
  }
  if (doc.y > doc.page.height - 350) addPage();
  const maxW = doc.page.width - 110;
  const maxH = 380;
  try {
    doc.image(imgPath, 55, doc.y, { fit: [maxW, maxH], align: 'center' });
    doc.y += maxH + 5;
    if (caption) {
      doc.fontSize(8).fillColor('#666').font('Helvetica-Oblique').text(caption, { align: 'center' });
    }
    doc.moveDown(0.5);
  } catch(e) {
    body('[Could not embed image: ' + filename + ']');
  }
}

// =====================================================
// COVER PAGE
// =====================================================
addPage();
doc.y = 150;
doc.fontSize(36).fillColor(C.accent).font('Helvetica-Bold')
  .text('Dashboard Ultimate', { align: 'center' });
doc.moveDown(0.3);
doc.fontSize(16).fillColor(C.orange).font('Helvetica')
  .text('Complete Technical Documentation', { align: 'center' });
doc.moveDown(0.5);
doc.moveTo(150, doc.y).lineTo(doc.page.width - 150, doc.y).strokeColor(C.green).lineWidth(3).stroke();
doc.moveDown(1);
doc.fontSize(12).fillColor(C.textLight).font('Helvetica')
  .text('AI-Powered Crypto Trading Platform', { align: 'center' });
doc.moveDown(0.3);
doc.text('Multi-Indicator Confluence Scoring | Real-Time BloFin Execution', { align: 'center' });
doc.moveDown(0.3);
doc.text('Backtesting | Auto-Trading | Portfolio Management', { align: 'center' });
doc.moveDown(3);
doc.fontSize(10).fillColor('#999')
  .text(`Generated: ${new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}`, { align: 'center' });
doc.text('Version 1.0', { align: 'center' });

// =====================================================
// TABLE OF CONTENTS
// =====================================================
addPage();
title('Table of Contents');
const toc = [
  '1. Platform Overview',
  '2. Dashboard Tabs & Navigation',
  '3. Best Trades Tab — Signal Scanner',
  '4. Probability & Confidence Scoring Algorithm',
  '5. All Technical Indicators Explained',
  '6. Market Regime Detection',
  '7. Risk/Reward & Stop Loss/Take Profit Calculation',
  '8. Leverage-Aware Position Sizing',
  '9. Auto-Trade Engine',
  '10. BloFin Exchange Integration',
  '11. Backtester & Strategy Optimizer',
  '12. Paper Trading System',
  '13. Track Record & Trade Recommendations',
  '14. Portfolio & Compounding Tracker',
  '15. News Integration',
  '16. Safety Guards & Kill Switch',
  '17. Scanned Assets',
  '18. Funding Rate Monitor',
  '19. Architecture & Tech Stack',
];
toc.forEach(item => {
  doc.fontSize(11).fillColor(C.text).font('Helvetica').text(item);
  doc.moveDown(0.2);
});

// =====================================================
// 1. PLATFORM OVERVIEW
// =====================================================
addPage();
title('1. Platform Overview');
body('Dashboard Ultimate is an AI-powered cryptocurrency trading platform that combines multi-indicator technical analysis with real-time exchange execution. The platform scans 20 crypto assets across multiple timeframes, generates probability-scored trade signals, and can automatically execute trades on the BloFin exchange.');
spacer();
heading('Key Features', 14);
bullet('Real-time scanning of 20 crypto assets across 12 timeframes');
bullet('7 technical indicators combined into a confluence probability score (30-85%)');
bullet('Timeframe-aware indicator weighting (short TF favours momentum, long TF favours trend)');
bullet('Performance-adaptive scoring — learns from its own historical win rates');
bullet('Market regime detection (bull/bear/sideways with volatility state)');
bullet('Leverage-adjusted stop loss and take profit calculations');
bullet('Full auto-trade mode with BloFin exchange integration');
bullet('Paper trading system for strategy testing');
bullet('Strategy backtester with parameter optimizer');
bullet('Portfolio tracking with compounding P&L');
bullet('Safety guards: kill switch, daily loss limits, liquidation protection');
bullet('Encrypted API credential storage (AES-256-GCM with PBKDF2)');
spacer();
heading('How It Works — High Level', 14);
body('1. SCAN: The engine fetches 200 candles of price data for each of the 20 assets on your chosen timeframe.');
body('2. ANALYSE: Seven technical indicators are computed per asset. Each indicator generates a bullish, bearish, or neutral signal.');
body('3. SCORE: A weighted confluence score combines all signals. Weights change based on timeframe (e.g., RSI is weighted 22 on 15m but only 10 on daily). Additional adjustments are made for market regime, funding rates, and historical win rates.');
body('4. RANK: Assets are ranked by probability. The best direction (long or short) is selected per asset.');
body('5. TRADE: You can manually execute via the modal, or enable auto-trade to let the dashboard trade automatically when signals meet your threshold.');

// =====================================================
// 2. DASHBOARD TABS
// =====================================================
addPage();
title('2. Dashboard Tabs & Navigation');

subheading('Best Trades Tab (Default)');
screenshot('ss_02_best_trades.png', 'Figure: Best Trades tab — header, regime banner, and scan controls');
body('The primary tab showing live-scanned trade setups. Displays card-based view of all assets ranked by probability score. Each card shows: asset name, direction (long/short), probability percentage, risk/reward ratio, confidence rating, stop loss %, take profit %, indicator signals (hits/misses), and action buttons (Log Trade / Execute).');
spacer();

subheading('Backtester Tab');
screenshot('ss_01_backtester.png', 'Figure: Backtester — symbol selection, date range, indicators, funding rate monitor');
body('Historical strategy testing engine. Select any asset, date range, timeframe, and combination of indicators. The backtester runs your strategy against historical data and reports win rate, total return, Sharpe ratio, max drawdown, and individual trade results. Includes a parameter optimizer that finds the best indicator combinations.');
spacer();

subheading('Auto-Trade Panel');
screenshot('ss_03_autotrade.png', 'Figure: Auto-Trade panel with enable toggle, mode, probability threshold, and position size');
body('Located above the trade cards on the Best Trades tab. Controls: Enable Auto-Trade checkbox, Mode (Full Auto / Confirm First), Min Probability threshold, Position Size ($), and Max Open Positions. When enabled, the dashboard automatically executes or prompts for trades meeting your criteria.');
spacer();

subheading('Track Record Tab');
screenshot('ss_12_track_record.png', 'Figure: Track Record — win rate, P&L, timeframe performance breakdown');
body('Shows all logged trade recommendations with outcomes. Displays overall win rate, total trades, wins/losses, average P&L, current streak, and timeframe performance breakdown with visual bars showing which timeframes perform best.');
spacer();

subheading('Live Trading Panel');
screenshot('ss_08_live_trading.png', 'Figure: Live Trading — BloFin connection, balance, positions');
body('BloFin connection status, balance display, active positions with live P&L, and trade execution modal. Shows real-time mark price, estimated liquidation price, and margin information.');
spacer();

subheading('News Tab');
screenshot('ss_05_market_intel.png', 'Figure: Market Intel / News tab');
body('Aggregated crypto news from multiple sources with trade signal integration. News items can generate trade ideas that appear alongside technical signals.');
spacer();

subheading('Degen Scanner Tab');
screenshot('ss_04_degen_scanner.png', 'Figure: Degen Scanner tab');
spacer();

subheading('Alerts Tab');
screenshot('ss_06_alerts.png', 'Figure: Alerts tab — live trade alerts');
spacer();

subheading('Paper Trade Tab');
screenshot('ss_07_paper_trade.png', 'Figure: Paper Trade — simulated trading');
spacer();

subheading('Settings');
body('API credential management (encrypted storage), safety guard configuration, position sizing policy, and account preferences.');

// =====================================================
// 3. BEST TRADES TAB
// =====================================================
addPage();
title('3. Best Trades Tab — Signal Scanner');

subheading('How Scanning Works');
body('When you click "Scan Now" (or scans auto-run on the configured interval), the engine:');
bullet('Fetches 200 candles from Binance for each of the 20 assets on your selected timeframe');
bullet('Computes all 7 indicators (RSI, EMA, MACD, Bollinger Bands, StochRSI, Ichimoku, Volume)');
bullet('Detects the current market regime (bull/bear/sideways)');
bullet('Retrieves live funding rates from BloFin');
bullet('Scores both LONG and SHORT directions, picks the stronger one');
bullet('Applies leverage penalty if leverage > 1x');
bullet('Calculates ATR-based stop loss and take profit levels');
bullet('Ranks all assets by probability score');
spacer();

subheading('Trade Card Layout');
screenshot('ss_10_trade_cards.png', 'Figure: Trade cards showing probability, R/R, confidence, indicators, and action buttons');
body('Each scanned asset displays as a card containing:');
bullet('Asset icon, name, direction arrow (green up for long, red down for short)');
bullet('Probability gauge (circular arc showing 0-100%)');
bullet('Risk/Reward ratio (e.g., 2.5:1)');
bullet('Confidence rating badge (High / Medium / Low)');
bullet('Editable Stop Loss % and Take Profit % fields');
bullet('Spot/Perps toggle and Leverage selector');
bullet('Indicator signal list (green dot = aligned, grey = neutral/opposing)');
bullet('Long/Short probability comparison (e.g., "Long 70% | Short 34%")');
bullet('"Log Trade" button — saves to track record for monitoring');
bullet('"Execute" button — opens the BloFin execution modal');
spacer();

subheading('Full Scan Results View');
screenshot('ss_09_scan_results.png', 'Figure: Complete scan results — regime banner, all 20 assets scanned with probability scores');
spacer();

subheading('Market Regime Banner');
body('Above the cards, a banner shows the current BTC-based regime: "BULL REGIME — Longs favoured" (green), "BEAR REGIME — Shorts favoured" (red), or "SIDEWAYS — Range plays favoured" (yellow). This is determined by BTC\'s position relative to its 200 EMA and 50/200 EMA crossover.');

// =====================================================
// 4. PROBABILITY SCORING
// =====================================================
addPage();
title('4. Probability & Confidence Scoring');

subheading('Overview');
body('The probability score represents the estimated likelihood that a trade setup will be profitable. It is NOT a simple percentage — it is a composite score built from multiple layers of analysis. The final score ranges from 30% (weak/random) to 85% (very strong confluence).');
spacer();

subheading('Step 1: Indicator Confluence Score');
body('Each of the 7 indicators generates a bullish, bearish, or neutral signal. These are weighted and combined:');
spacer();

body('For each indicator:');
bullet('If the signal ALIGNS with the trade direction: +weight points (x1.3 bonus if crossover detected)');
bullet('If the signal OPPOSES the trade direction: -weight x 0.4 penalty');
bullet('If neutral: small implicit penalty (no points added)');
spacer();
body('Special: If Bollinger Bands detect a SQUEEZE (bandwidth < 10th percentile of recent bars), an extra +8 points are added to signal an imminent breakout.');
spacer();
body('The raw confluence ratio = total score / maximum possible score (range: 0 to 1)');
spacer();

subheading('Step 2: Base Probability Mapping');
codeBlock('probability = 38 + (confluence_ratio x 42)');
body('This maps the 0-1 confluence ratio to a 38-80% probability range. A score of 38% means no indicator alignment (random). A score of 80% means perfect alignment across all indicators.');
spacer();

subheading('Step 3: Regime Adjustment (+/- 4 points)');
body('The market regime (detected from BTC\'s EMA structure) adjusts the probability:');
bullet('Bull regime + Long trade: +4 points');
bullet('Bull regime + Short trade: -4 points');
bullet('Bear regime + Short trade: +4 points');
bullet('Bear regime + Long trade: -4 points');
spacer();

subheading('Step 4: Funding Rate Adjustment (+/- 3 points)');
body('Live perpetual funding rates from BloFin fine-tune the score:');
bullet('Long + high positive funding (>0.08%): -3 (crowded long, mean reversion risk)');
bullet('Long + negative funding (<-0.02%): +3 (short squeeze fuel)');
bullet('Short + very negative funding (<-0.05%): -3 (crowded short)');
bullet('Short + extreme positive funding (>0.10%): +3 (fade extreme longs)');
spacer();

subheading('Step 5: Performance-Adaptive Scoring (+/- 8 points)');
body('The dashboard learns from its own track record. If a timeframe has 5 or more resolved trades, its historical win rate adjusts the score:');
codeBlock('adjustment = clamp((win_rate - 50) x 0.8, -8, +8)');
body('Examples:');
bullet('1h timeframe with 54% win rate across 24 trades: +3.2 points');
bullet('4h timeframe with 22% win rate across 23 trades: -8 points (capped)');
bullet('15m timeframe with 50% win rate: +0 points (at baseline)');
spacer();

subheading('Step 6: Personal Optimizer Blend (30% weight)');
body('If you\'ve run the backtester/optimizer, the top 5 strategies\' average win rate is blended in at 30% weight:');
codeBlock('final_prob = (indicator_prob x 0.7) + (personal_avg_WR x 0.3)');
spacer();

subheading('Step 7: Final Clamping');
codeBlock('probability = clamp(round(probability), 30, 85)');
body('The final score is clamped between 30% (minimum) and 85% (maximum). This prevents overconfidence and maintains statistical honesty.');
spacer();

subheading('Confidence Rating');
body('Derived from the raw confluence ratio (before probability mapping):');
table(['Confluence Ratio', 'Confidence', 'Colour'], [
  ['>= 0.72', 'High', 'Green'],
  ['>= 0.50', 'Medium', 'Yellow'],
  ['< 0.50', 'Low', 'Orange/Red'],
]);

// =====================================================
// 5. INDICATORS
// =====================================================
addPage();
title('5. All Technical Indicators');

body('The dashboard uses 7 core indicators for its probability scoring, plus 5 additional indicators available in the backtester. Each indicator generates a bullish, bearish, or neutral signal per asset.');
spacer();

subheading('RSI — Relative Strength Index');
body('Period: 14 bars. Measures momentum on a 0-100 scale.');
table(['Condition', 'Signal', 'Meaning'], [
  ['RSI <= 35', 'BULLISH', 'Oversold — potential bounce/reversal up'],
  ['RSI >= 65', 'BEARISH', 'Overbought — potential pullback/reversal down'],
  ['35 < RSI < 65', 'NEUTRAL', 'No clear signal'],
]);
body('Best on: Short timeframes (1m-1h) where overbought/oversold conditions resolve quickly.');
spacer();

subheading('EMA — Exponential Moving Average Crossover');
body('Fast: 21 periods. Slow: 55 periods. Tracks trend direction.');
table(['Condition', 'Signal', 'Meaning'], [
  ['21 EMA crosses ABOVE 55 EMA', 'BULLISH (cross)', 'Golden cross — uptrend starting'],
  ['Price above both EMAs', 'BULLISH', 'Established uptrend'],
  ['21 EMA crosses BELOW 55 EMA', 'BEARISH (cross)', 'Death cross — downtrend starting'],
  ['Price below both EMAs', 'BEARISH', 'Established downtrend'],
]);
body('Cross signals receive a 1.3x weight bonus. Best on: Medium-long timeframes (4h-1d).');
spacer();

subheading('MACD — Moving Average Convergence Divergence');
body('Fast: 12. Slow: 26. Signal: 9. Tracks momentum shifts.');
table(['Condition', 'Signal', 'Meaning'], [
  ['MACD crosses ABOVE signal line', 'BULLISH (cross)', 'Momentum turning up'],
  ['MACD above signal line', 'BULLISH', 'Upward momentum'],
  ['MACD crosses BELOW signal line', 'BEARISH (cross)', 'Momentum turning down'],
  ['MACD below signal line', 'BEARISH', 'Downward momentum'],
]);
body('Cross signals receive a 1.3x weight bonus. Balanced across all timeframes.');
spacer();

subheading('Bollinger Bands (BB)');
body('Period: 20. Standard Deviations: 2. Measures volatility and mean reversion.');
table(['Condition', 'Signal', 'Meaning'], [
  ['Price at/below lower band (pos <= 20%)', 'BULLISH', 'Oversold relative to volatility'],
  ['Price at/above upper band (pos >= 80%)', 'BEARISH', 'Overbought relative to volatility'],
  ['Bandwidth < 10th percentile', 'SQUEEZE', 'Low volatility — breakout imminent (+8 bonus)'],
]);
body('The squeeze signal adds +8 bonus points regardless of direction. Best on: Short-medium timeframes.');

addPage();
subheading('StochRSI — Stochastic RSI');
body('Applies a stochastic calculation to the RSI itself. K Period: 14-bar RSI mapped to 0-100 via min/max of last 14 bars. More sensitive than regular RSI.');
table(['Condition', 'Signal', 'Meaning'], [
  ['K < 20', 'BULLISH', 'Deeply oversold — high reversal probability'],
  ['K > 80', 'BEARISH', 'Deeply overbought — high reversal probability'],
  ['20 <= K <= 80', 'NEUTRAL', 'No extreme condition'],
]);
body('Best on: Short timeframes (1m-1h) for catching quick reversals. Weighted 22 on short TF, only 8 on daily.');
spacer();

subheading('Ichimoku Cloud');
body('A comprehensive trend system using 5 components:');
bullet('Tenkan-sen (Conversion): 9-period midpoint');
bullet('Kijun-sen (Base): 26-period midpoint');
bullet('Senkou Span A: (Tenkan + Kijun) / 2, displaced 26 bars forward');
bullet('Senkou Span B: 52-period midpoint, displaced 26 bars forward');
table(['Condition', 'Signal', 'Meaning'], [
  ['Tenkan crosses above Kijun + price above cloud', 'BULLISH (cross)', 'Strong uptrend confirmation'],
  ['Price above cloud', 'BULLISH', 'Uptrend'],
  ['Tenkan crosses below Kijun + price below cloud', 'BEARISH (cross)', 'Strong downtrend confirmation'],
  ['Price below cloud', 'BEARISH', 'Downtrend'],
]);
body('Cross signals receive 1.3x bonus. Best on: Long timeframes (4h-1w). Weighted 22 on daily, only 5 on 15m.');
spacer();

subheading('Volume Analysis');
body('Compares current volume to the 20-bar simple moving average of volume.');
table(['Condition', 'Signal', 'Meaning'], [
  ['Volume ratio > 1.5x', 'BULLISH', 'Volume spike — strong conviction in current move'],
  ['Volume ratio < 0.5x', 'BEARISH', 'Volume drying up — move losing steam'],
  ['0.5x - 1.5x', 'NEUTRAL', 'Normal volume'],
]);
spacer();

heading('Backtester-Only Indicators', 14);
body('These additional indicators are available in the backtester/optimizer but not in the live scanner:');
bullet('TD Sequential: Counts 9 consecutive closes vs 4 bars ago for exhaustion signals');
bullet('Supertrend: ATR-based trailing stop that flips between support/resistance');
bullet('VWAP: Volume-weighted average price for mean reversion trades');
bullet('OBV: On-Balance Volume with 5/20 EMA crossover for volume momentum');
bullet('ADX: Average Directional Index (14-period) — confirms trend strength above 25');
bullet('Traffic Light / Pi Cycle: Uses 111 MA vs 2x350 MA for macro cycle positioning');

// =====================================================
// 6. MARKET REGIME
// =====================================================
addPage();
title('6. Market Regime Detection');

body('The dashboard continuously analyses BTC\'s market structure to determine the overall crypto market regime. This regime influences probability scoring for all assets.');
spacer();

subheading('Detection Method');
body('Uses BTC\'s last 200 candles to compute:');
bullet('50-period EMA and 200-period EMA');
bullet('14-period RSI');
bullet('14-period ATR (Average True Range) for volatility');
spacer();

subheading('Regime Classification');
table(['Condition', 'Regime', 'Effect on Scoring'], [
  ['Price > EMA200 AND EMA50 > EMA200', 'BULL', 'Longs +4, Shorts -4'],
  ['Price < EMA200 AND EMA50 < EMA200', 'BEAR', 'Shorts +4, Longs -4'],
  ['Mixed (one above, one below)', 'SIDEWAYS', 'No adjustment'],
  ['Neither condition clear', 'NEUTRAL', 'No adjustment'],
]);
spacer();

subheading('Volatility Overlay');
body('The regime also tracks volatility expansion/compression by comparing recent ATR (last 20 bars) to older ATR (bars 20-50):');
bullet('Expanding (recent > old x 1.3): Suffix "_volatile" — higher risk, wider stops recommended');
bullet('Compressing (recent < old x 0.7): Suffix "_squeeze" — breakout imminent');
spacer();
body('Possible combined regimes: bull, bull_volatile, bull_squeeze, bear, bear_volatile, bear_squeeze, sideways, sideways_volatile, sideways_squeeze, neutral.');
spacer();

subheading('Regime Banner');
body('The regime is displayed as a banner above the trade cards:');
bullet('Green banner: "BULL REGIME — Longs favoured" with BTC above EMA200 and RSI reading');
bullet('Red banner: "BEAR REGIME — Shorts favoured"');
bullet('Yellow banner: "SIDEWAYS — Range plays favoured"');

// =====================================================
// 7. RISK/REWARD
// =====================================================
addPage();
title('7. Risk/Reward & SL/TP Calculation');

subheading('ATR-Based Stop Loss & Take Profit');
body('Stop loss and take profit levels are calculated from the Average True Range (ATR), which measures volatility. This ensures stops are proportional to the asset\'s actual price movement.');
spacer();

subheading('Spot Trading (Leverage = 1x)');
table(['Probability', 'Stop Multiplier', 'Target Multiplier', 'R/R Ratio'], [
  ['>= 70%', '1.0x ATR', '2.5x ATR', '2.5:1'],
  ['>= 60%', '1.0x ATR', '2.0x ATR', '2.0:1'],
  ['< 60%', '1.0x ATR', '1.5x ATR', '1.5:1'],
]);
spacer();

subheading('Leveraged Trading (Leverage > 1x)');
body('When using leverage, stops are WIDENED to give the position breathing room against wicks and slippage, while targets are TIGHTENED because leverage amplifies gains:');
table(['Probability', 'Stop Multiplier', 'Target Multiplier', 'R/R Ratio'], [
  ['>= 70%', '1.5x ATR', '1.8x ATR', '1.2:1'],
  ['>= 60%', '1.5x ATR', '1.5x ATR', '1.0:1'],
  ['< 60%', '1.5x ATR', '1.2x ATR', '0.8:1'],
]);
spacer();

subheading('Price Calculation');
codeBlock(`LONG position:
  Stop Loss  = Current Price - (ATR x Stop Multiplier)
  Take Profit = Current Price + (ATR x Target Multiplier)

SHORT position:
  Stop Loss  = Current Price + (ATR x Stop Multiplier)
  Take Profit = Current Price - (ATR x Target Multiplier)`);
spacer();

subheading('Leveraged P&L Percentages');
body('The displayed P&L percentages account for leverage:');
codeBlock(`Stop Loss %  = (ATR x Stop Mult / Price) x 100 x Leverage
Take Profit % = (ATR x Target Mult / Price) x 100 x Leverage
Risk/Reward = Take Profit % / Stop Loss %`);
body('Example: 2% price-level stop with 10x leverage = 20% account loss on stop out.');
spacer();

subheading('Leverage Penalty on Probability');
body('Higher leverage reduces the probability score because leveraged positions are more sensitive to wicks, slippage, and liquidation:');
codeBlock('penalty = (leverage - 1) x 2 points\n\nExamples:\n  5x leverage:  -8 points\n  10x leverage: -18 points\n  25x leverage: -48 points (will hit floor of 30%)');

// =====================================================
// 8. LEVERAGE POSITION SIZING
// =====================================================
addPage();
title('8. Leverage-Aware Position Sizing');

subheading('How Position Size is Calculated');
body('When you enter a collateral amount (e.g., $10 USDT), the dashboard calculates the actual position size and contract count:');
spacer();
codeBlock(`Position Size (USD) = Collateral x Leverage
Contracts = Position Size / (Mark Price x Contract Value)

Example: $10 collateral at 5x on SUI ($0.99, contractValue=1):
  Position = $10 x 5 = $50
  Contracts = $50 / ($0.99 x 1) = 50.5 => 51 contracts`);
spacer();

subheading('Contract Value');
body('Each BloFin perpetual contract represents a fixed amount of the base asset:');
bullet('BTC-USDT: 0.001 BTC per contract');
bullet('ETH-USDT: 0.01 ETH per contract');
bullet('Most altcoins: 1 unit per contract (e.g., 1 SUI, 1 SOL)');
body('The dashboard fetches exact contract values from BloFin\'s instrument API to ensure accurate sizing.');
spacer();

subheading('Estimated Liquidation Price');
body('The modal shows an estimated liquidation price calculated as:');
codeBlock(`For LONG:  Liq Price = Entry Price x (1 - 1/Leverage) x 0.9
For SHORT: Liq Price = Entry Price x (1 + 1/Leverage) x 1.1

Note: Actual liquidation depends on BloFin's margin tiers.
The estimate is approximate — always check BloFin.`);

// =====================================================
// 9. AUTO-TRADE ENGINE
// =====================================================
addPage();
title('9. Auto-Trade Engine');

subheading('Overview');
body('The auto-trade engine monitors scan results and automatically executes trades when signals meet your configured criteria. It runs after every scan cycle.');
spacer();

subheading('Configuration Settings');
table(['Setting', 'Default', 'Description'], [
  ['Enable Auto-Trade', 'OFF', 'Master on/off switch'],
  ['Mode', 'Confirm', '"Full Auto" executes immediately, "Confirm" shows a 30s popup'],
  ['Min Probability', '65%', 'Only trades with probability >= this threshold'],
  ['Position Size', '$10', 'USD amount per trade (capped by policy max)'],
  ['Max Open Positions', '3', 'Prevents over-exposure'],
]);
spacer();

subheading('Full Auto Mode');
body('When set to "Full Auto", qualifying signals are executed immediately without user intervention:');
bullet('Fetches current price from BloFin (fallback: Binance)');
bullet('Calculates SL/TP prices from the card\'s percentages');
bullet('Sends order to backend with USD size — backend converts to contracts');
bullet('Logs the trade to Track Record automatically');
bullet('Shows toast notification: "Auto-executing: BTC LONG (72% prob)"');
spacer();

subheading('Confirm Mode');
body('Shows a floating notification card for each qualifying signal with a 30-second timer:');
bullet('Displays asset, direction, probability, R/R ratio, confidence');
bullet('"Execute" button — places the trade');
bullet('"Skip" button — dismisses the signal');
bullet('Auto-dismisses after 30 seconds if no action taken');
spacer();

subheading('Position Limit Enforcement');
body('Before executing, the engine syncs with BloFin to count real open positions. If the count meets or exceeds Max Open Positions, no new trades are placed.');

// =====================================================
// 10. BLOFIN INTEGRATION
// =====================================================
addPage();
title('10. BloFin Exchange Integration');

subheading('Connection Setup');
body('To connect to BloFin:');
bullet('Create an API key on BloFin (CCXT or API Transaction type)');
bullet('Enable Read + Trade permissions');
bullet('Leave IP whitelist blank (Railway IPs change on deploy)');
bullet('Enter API Key, Secret Key, and Passphrase in the dashboard');
bullet('Credentials are encrypted with AES-256-GCM using your password');
bullet('Stored encrypted in the database — decrypted to RAM only when unlocked');
spacer();

subheading('Authentication');
body('Every API request to BloFin is signed using:');
codeBlock(`Prehash = requestPath + METHOD + timestamp(ms) + nonce(UUID) + body
Signature = Base64( HMAC-SHA256(prehash, secretKey).hex() )

Headers: ACCESS-KEY, ACCESS-SIGN, ACCESS-TIMESTAMP, ACCESS-NONCE, ACCESS-PASSPHRASE`);
spacer();

subheading('Order Execution Flow');
body('When you click "Confirm Execute" or auto-trade fires:');
bullet('1. Set position mode to "hedge" (long_short_mode) — allows simultaneous long + short');
bullet('2. Set leverage for the specific side (e.g., 5x for long on BTC-USDT)');
bullet('3. Calculate contract size: USD / (mark_price x contract_value)');
bullet('4. Place market order with brokerId (CCXT broker ID)');
bullet('5. If TP/SL provided, place a separate TPSL order');
spacer();

subheading('Rate Limits');
table(['Bucket', 'Limit', 'Refill Period'], [
  ['General API', '500 requests', '60 seconds'],
  ['Trading API', '30 requests', '10 seconds'],
]);
spacer();

subheading('Balance Display');
body('The global status bar shows your BloFin USDT balance in real-time. Funds must be in the USDT-M Futures wallet (not Spot) for the dashboard to see them.');

// =====================================================
// 11. BACKTESTER
// =====================================================
addPage();
title('11. Backtester & Strategy Optimizer');

subheading('Backtester');
body('The backtester lets you test any combination of indicators against historical data:');
bullet('Select asset (any of the 20 scanned assets or custom symbol)');
bullet('Choose date range and timeframe');
bullet('Check which indicators to use (RSI, EMA, MACD, BB, StochRSI, Ichimoku, etc.)');
bullet('Each indicator can use a different timeframe (cross-timeframe analysis)');
bullet('Set logic mode: AND (all must agree) or OR (any one triggers)');
bullet('Configure stop loss and take profit percentages');
spacer();

body('Results include:');
bullet('Win Rate (%)');
bullet('Total Return (%)');
bullet('Sharpe Ratio');
bullet('Maximum Drawdown (%)');
bullet('Number of trades');
bullet('Average win/loss per trade');
bullet('Individual trade list with entry/exit prices and P&L');
spacer();

subheading('Strategy Optimizer');
body('The optimizer exhaustively searches combinations of indicators and parameters to find the highest-performing strategies:');
bullet('Tests all possible 2-4 indicator combinations');
bullet('Varies timeframes per indicator');
bullet('Ranks results by win rate, Sharpe ratio, or return');
bullet('Top 5 results influence live probability scoring (30% weight blend)');
bullet('"Use" button applies the optimal settings to the live scanner');

// =====================================================
// 12. PAPER TRADING
// =====================================================
addPage();
title('12. Paper Trading System');

subheading('Overview');
body('The paper trading system simulates live trading without risking real money. It runs on the backend with the same signal logic as the live scanner.');
spacer();

subheading('How It Works');
bullet('Configure a paper strategy: asset, timeframe, indicators, SL/TP');
bullet('The backend polls every 60 seconds, fetching 500 candles');
bullet('Indicators are computed and signals generated');
bullet('Simulated entries on buy signals, exits on sell/SL/TP');
bullet('Equity curve tracked over time');
spacer();

subheading('Paper Trading State');
table(['Field', 'Description'], [
  ['Equity', 'Current simulated account value'],
  ['Capital', 'Starting capital'],
  ['Positions', 'Open simulated positions (direction, entry, size, timestamp)'],
  ['Trades', 'Closed trades with P&L'],
  ['Equity Curve', 'Array of equity values over time for charting'],
]);

// =====================================================
// 13. TRACK RECORD
// =====================================================
addPage();
title('13. Track Record & Recommendations');

subheading('How Trades Are Tracked');
body('Every trade logged (via "Log Trade" button or auto-trade) is saved as a recommendation in the database:');
table(['Field', 'Description'], [
  ['Symbol', 'e.g., BTCUSDT'],
  ['Direction', 'LONG or SHORT'],
  ['Probability', 'Score at time of logging'],
  ['Entry Price', 'Price when logged'],
  ['Target Price', 'Calculated TP level'],
  ['Stop Price', 'Calculated SL level'],
  ['R/R Ratio', 'Risk/reward at time of entry'],
  ['Source', '"manual", "auto", or "news"'],
  ['Timeframe', 'e.g., 1h, 4h'],
  ['Confidence', 'High / Medium / Low'],
  ['Leverage', 'Leverage used'],
  ['Mode', '"spot" or "perps"'],
]);
spacer();

subheading('Trade Resolution');
body('The backend periodically checks open recommendations against current prices:');
bullet('If price hits Take Profit level: marked as WIN');
bullet('If price hits Stop Loss level: marked as LOSS');
bullet('P&L percentage calculated from entry to exit');
spacer();

subheading('Summary Statistics');
body('The Track Record panel shows:');
bullet('Total trades, Wins, Losses');
bullet('Overall Win Rate');
bullet('Average P&L per trade');
bullet('Current streak (e.g., "3W" or "2L")');
bullet('Timeframe Performance breakdown — bar chart showing win rate per timeframe');
body('The timeframe performance data feeds back into the probability scorer (performance-adaptive scoring).');

// =====================================================
// 14. PORTFOLIO
// =====================================================
addPage();
title('14. Portfolio & Compounding Tracker');

subheading('Portfolio Settings');
body('Configure your portfolio parameters:');
bullet('Starting Balance: Your initial account size (e.g., $1,000)');
bullet('% Per Trade: What percentage of equity to risk per trade (e.g., 10%)');
spacer();

subheading('Compounding Calculation');
body('The portfolio tracker applies compounding logic to your track record:');
bullet('Each trade\'s position size is calculated as % of current equity (not initial)');
bullet('Winning trades grow the equity pool, increasing future position sizes');
bullet('Losing trades shrink the equity pool, reducing future position sizes');
bullet('This models real compounding P&L over your full trade history');
spacer();

subheading('Display');
body('Shows running equity total, cumulative P&L, and position size progression across all resolved trades in your track record.');

// =====================================================
// 15. NEWS
// =====================================================
title('15. News Integration');

subheading('News Aggregation');
body('The backend aggregates crypto news from multiple sources and delivers them in real-time via Server-Sent Events (SSE):');
bullet('Real-time news feed with live updates');
bullet('Filterable by asset or category');
bullet('News items can include sentiment analysis');
bullet('Trade action buttons on news items (Long/Short with pre-filled parameters)');
spacer();

subheading('News-Based Trade Signals');
body('Some news items generate trade ideas that appear alongside technical signals. These are tagged with source "news" in the track record.');

// =====================================================
// 16. SAFETY GUARDS
// =====================================================
addPage();
title('16. Safety Guards & Kill Switch');

body('The safety system protects your account from excessive losses and runaway automation.');
spacer();

subheading('Safety Configuration');
table(['Guard', 'Default', 'Description'], [
  ['Max Position Size', '$500', 'Maximum USD value for any single position'],
  ['Max Leverage', '20x', 'Maximum leverage allowed'],
  ['Daily Loss Limit', '$100', 'Trading halted if daily P&L exceeds this loss'],
  ['Auto-Close Liquidation %', '5%', 'Positions closed if within 5% of liquidation price'],
  ['Kill Switch', 'OFF', 'Emergency stop — closes all positions and halts trading'],
]);
spacer();

subheading('Kill Switch');
body('The kill switch is an emergency mechanism that:');
bullet('Immediately closes ALL open positions on BloFin');
bullet('Deactivates all live strategies');
bullet('Halts all auto-trade execution');
bullet('Remains active until manually deactivated');
bullet('Any attempt to trade while active returns an error');
spacer();

subheading('Daily Loss Limit');
body('Tracks cumulative realised P&L for the current day. When total losses exceed the configured limit, all new trade attempts are blocked. Resets at midnight UTC.');
spacer();

subheading('Liquidation Protection');
body('For open positions, the system monitors the distance between mark price and estimated liquidation price. If the gap narrows to within the configured percentage (default 5%), the position is automatically closed to prevent full liquidation.');

// =====================================================
// 17. SCANNED ASSETS
// =====================================================
addPage();
title('17. Scanned Assets');

body('The dashboard scans 20 cryptocurrency perpetual futures contracts on BloFin:');
spacer();

table(['#', 'Asset', 'Symbol', 'Category'], [
  ['1', 'Bitcoin (BTC)', 'BTC-USDT', 'Large Cap'],
  ['2', 'Ethereum (ETH)', 'ETH-USDT', 'Large Cap'],
  ['3', 'Solana (SOL)', 'SOL-USDT', 'Large Cap'],
  ['4', 'SUI', 'SUI-USDT', 'Layer 1'],
  ['5', 'BNB', 'BNB-USDT', 'Large Cap'],
  ['6', 'Dogecoin (DOGE)', 'DOGE-USDT', 'Meme'],
  ['7', 'XRP', 'XRP-USDT', 'Large Cap'],
  ['8', 'Cardano (ADA)', 'ADA-USDT', 'Layer 1'],
  ['9', 'Avalanche (AVAX)', 'AVAX-USDT', 'Layer 1'],
  ['10', 'Chainlink (LINK)', 'LINK-USDT', 'DeFi/Oracle'],
]);
spacer();
table(['#', 'Asset', 'Symbol', 'Category'], [
  ['11', 'Polkadot (DOT)', 'DOT-USDT', 'Layer 0'],
  ['12', 'NEAR Protocol', 'NEAR-USDT', 'Layer 1'],
  ['13', 'Arbitrum (ARB)', 'ARB-USDT', 'Layer 2'],
  ['14', 'Optimism (OP)', 'OP-USDT', 'Layer 2'],
  ['15', 'Aptos (APT)', 'APT-USDT', 'Layer 1'],
  ['16', 'Injective (INJ)', 'INJ-USDT', 'DeFi'],
  ['17', 'PEPE', 'PEPE-USDT', 'Meme'],
  ['18', 'BONK', 'BONK-USDT', 'Meme'],
  ['19', 'dogwifhat (WIF)', 'WIF-USDT', 'Meme'],
  ['20', 'Render (RENDER)', 'RENDER-USDT', 'AI/GPU'],
]);
spacer();
body('These assets were selected for high liquidity, tight spreads, and availability on BloFin perpetual futures.');

// =====================================================
// 18. FUNDING RATES
// =====================================================
addPage();
title('18. Funding Rate Monitor');

subheading('What Are Funding Rates?');
body('Perpetual futures use funding rates to keep the futures price aligned with the spot price. Positive funding means longs pay shorts; negative funding means shorts pay longs. Extreme rates indicate crowded positions.');
spacer();

subheading('How the Dashboard Uses Funding Rates');
body('Live funding rates are fetched from BloFin and used in two ways:');
bullet('Probability adjustment: Crowded positions get penalised, contrarian setups get boosted');
bullet('Visual display: Funding rate cards colour-coded by severity');
spacer();

subheading('Colour Coding');
table(['Funding Rate', 'Category', 'Colour', 'Meaning'], [
  ['<= 0.05%', 'Neutral', 'Green', 'Normal market conditions'],
  ['0.05% - 0.10%', 'Elevated', 'Yellow', 'Slightly crowded — be cautious'],
  ['> 0.10%', 'Extreme', 'Orange', 'Very crowded — mean reversion likely'],
  ['Negative', 'Squeeze Risk', 'Purple', 'Shorts paying longs — potential short squeeze'],
]);

// =====================================================
// 19. ARCHITECTURE
// =====================================================
addPage();
title('19. Architecture & Tech Stack');

subheading('Frontend');
bullet('Single-page application: one index.html file');
bullet('Deployed to GitHub Pages (static hosting)');
bullet('No framework — vanilla JavaScript for performance');
bullet('All indicator calculations run client-side for speed');
bullet('Price data fetched from Binance (scanning) and BloFin (execution)');
spacer();

subheading('Backend');
bullet('Node.js + Express.js server');
bullet('Deployed on Railway (auto-deploy from GitHub)');
bullet('PostgreSQL database (Railway-hosted)');
bullet('JWT authentication');
bullet('Server-Sent Events (SSE) for real-time updates');
spacer();

subheading('Security');
table(['Feature', 'Implementation'], [
  ['API Credential Encryption', 'AES-256-GCM with PBKDF2 key derivation (100,000 iterations)'],
  ['Authentication', 'JWT tokens with configurable expiry'],
  ['Password Hashing', 'bcrypt with salt rounds'],
  ['API Key Storage', 'Encrypted at rest in PostgreSQL, decrypted to RAM on unlock only'],
  ['BloFin API Auth', 'HMAC-SHA256 signed requests with timestamp + nonce'],
]);
spacer();

subheading('Key Backend Services');
table(['Service', 'File', 'Purpose'], [
  ['BloFin Client', 'blofinClient.js', 'All BloFin API communication'],
  ['Live Engine', 'liveEngine.js', 'Credential management, strategy execution'],
  ['Safety Guard', 'safetyGuard.js', 'Risk limits, kill switch, liquidation protection'],
  ['Paper Engine', 'paperEngine.js', 'Simulated trading on historical data'],
  ['Recommendation Tracker', 'recommendationTracker.js', 'Trade logging, resolution, stats'],
  ['News Aggregator', 'newsAggregator.js', 'Multi-source news collection'],
]);

// =====================================================
// FINAL PAGE
// =====================================================
addPage();
doc.y = 200;
doc.fontSize(20).fillColor(C.accent).font('Helvetica-Bold')
  .text('End of Documentation', { align: 'center' });
doc.moveDown(1);
doc.fontSize(12).fillColor(C.textLight).font('Helvetica')
  .text('Dashboard Ultimate v1.0', { align: 'center' });
doc.moveDown(0.3);
doc.text('For support or questions, contact the development team.', { align: 'center' });
doc.moveDown(1);
doc.fontSize(10).fillColor('#999')
  .text('This document was auto-generated from the Dashboard Ultimate codebase.', { align: 'center' });
doc.text(`Generated on ${new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}`, { align: 'center' });

// Finalize
doc.end();
output.on('finish', () => {
  console.log('PDF generated: Dashboard_Ultimate_Documentation.pdf');
  const stats = fs.statSync('Dashboard_Ultimate_Documentation.pdf');
  console.log(`File size: ${(stats.size / 1024).toFixed(0)} KB`);
});
