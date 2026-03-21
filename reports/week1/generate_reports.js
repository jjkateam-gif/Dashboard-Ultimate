const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { Pool } = require(path.join(__dirname, '..', '..', 'backend', 'node_modules', 'pg'));

const DIR = __dirname;

// ─── CLI args: --from YYYY-MM-DD --to YYYY-MM-DD (defaults to last 7 days) ───
const args = process.argv.slice(2);
function getArg(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}
const DATE_TO = getArg('--to', new Date().toISOString().slice(0, 10));
const DATE_FROM = getArg('--from', new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
const DB_URL = getArg('--db', process.env.DATABASE_URL || '');

if (!DB_URL) {
  console.error('No database URL. Pass --db <url> or set DATABASE_URL env var.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DB_URL,
  ssl: DB_URL.includes('railway') ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
});

console.log(`Report range: ${DATE_FROM} to ${DATE_TO}`);

async function runQuery(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows;
}

// ─── Helper: parse CSV (still available for optional local CSV overrides) ───
function parseCSV(filename) {
  const filepath = path.join(DIR, filename);
  if (!fs.existsSync(filepath)) return [];
  const raw = fs.readFileSync(filepath, 'utf-8').trim();
  const lines = raw.split('\n').filter(l => l.trim());
  if (!lines.length) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const vals = line.split(',');
    const obj = {};
    headers.forEach((h, i) => obj[h.trim()] = (vals[i] || '').trim());
    return obj;
  });
}

// ─── Query DB for scan count distribution (replaces hardcoded scanData) ───
async function fetchScanData() {
  return await runQuery(`
    SELECT scan_count as sc,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE outcome = 'win') as wins,
      COUNT(*) FILTER (WHERE outcome IS NOT NULL) as resolved,
      ROUND(100.0 * COUNT(*) FILTER (WHERE outcome = 'win') /
        NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as wr,
      ROUND(AVG(CASE WHEN outcome IS NOT NULL THEN pnl END)::numeric, 4) as avgpnl
    FROM best_trades_log
    WHERE created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')
    GROUP BY scan_count ORDER BY scan_count
  `, [DATE_FROM, DATE_TO]);
}

// ─── Query DB for daily performance summary ───
async function fetchDailyPerformance() {
  return await runQuery(`
    SELECT DATE(created_at) as date,
      COUNT(*) as total_signals,
      COUNT(*) FILTER (WHERE outcome IS NOT NULL) as resolved,
      COUNT(*) FILTER (WHERE outcome = 'win') as wins,
      COUNT(*) FILTER (WHERE outcome = 'loss') as losses,
      ROUND(100.0 * COUNT(*) FILTER (WHERE outcome = 'win') /
        NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as win_rate_pct,
      ROUND(AVG(CASE WHEN outcome IS NOT NULL THEN pnl END)::numeric, 4) as avg_pnl,
      COUNT(*) FILTER (WHERE executed = true) as real_count,
      COUNT(*) FILTER (WHERE executed = true AND outcome = 'win') as real_wins,
      COUNT(*) FILTER (WHERE executed = true AND outcome = 'loss') as real_losses,
      ROUND(AVG(CASE WHEN executed = true AND outcome IS NOT NULL THEN pnl END)::numeric, 4) as real_avg_pnl
    FROM best_trades_log
    WHERE created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')
    GROUP BY DATE(created_at) ORDER BY date
  `, [DATE_FROM, DATE_TO]);
}

// ─── Query DB for asset performance ───
async function fetchAssetPerformance() {
  return await runQuery(`
    SELECT asset,
      COUNT(*) FILTER (WHERE outcome IS NOT NULL) as resolved,
      COUNT(*) FILTER (WHERE outcome = 'win') as wins,
      COUNT(*) FILTER (WHERE outcome = 'loss') as losses,
      COUNT(*) FILTER (WHERE outcome IS NULL) as pending,
      ROUND(100.0 * COUNT(*) FILTER (WHERE outcome = 'win') /
        NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as wr,
      ROUND(AVG(CASE WHEN outcome IS NOT NULL THEN pnl END)::numeric, 4) as avg_pnl,
      COUNT(*) FILTER (WHERE executed = true) as real_count,
      COUNT(*) FILTER (WHERE executed = true AND outcome = 'win') as real_wins,
      ROUND(100.0 * COUNT(*) FILTER (WHERE executed = true AND outcome = 'win') /
        NULLIF(COUNT(*) FILTER (WHERE executed = true AND outcome IS NOT NULL), 0), 1) as real_wr,
      ROUND(AVG(CASE WHEN executed = true AND outcome IS NOT NULL THEN pnl END)::numeric, 4) as real_avg_pnl
    FROM best_trades_log
    WHERE created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')
    GROUP BY asset ORDER BY wr DESC NULLS LAST
  `, [DATE_FROM, DATE_TO]);
}

// ─── Query DB for real (executed) trades ───
async function fetchRealTrades() {
  return await runQuery(`
    SELECT id, asset, direction, timeframe, probability, pnl, outcome,
      blofin_pnl_usd, data_source, exit_reason, created_at
    FROM best_trades_log
    WHERE executed = true
      AND created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')
    ORDER BY created_at DESC
  `, [DATE_FROM, DATE_TO]);
}

// ─── Query DB for overall stats (for cover page) ───
async function fetchOverallStats() {
  const rows = await runQuery(`
    SELECT
      COUNT(*) as total_signals,
      COUNT(*) FILTER (WHERE executed = true) as real_trades,
      ROUND(100.0 * COUNT(*) FILTER (WHERE outcome = 'win') /
        NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as paper_wr,
      ROUND(SUM(CASE WHEN executed = true THEN COALESCE(blofin_pnl_usd, pnl, 0) ELSE 0 END)::numeric, 2) as net_real_pnl,
      COUNT(*) FILTER (WHERE outcome IS NULL) as pending
    FROM best_trades_log
    WHERE created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')
  `, [DATE_FROM, DATE_TO]);
  return rows[0] || {};
}

// ═══════════════════════════════════════════════
// EXCEL WORKBOOK
// ═══════════════════════════════════════════════
async function generateExcel() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Ultimate Crypto Backtester Pro';
  wb.created = new Date();

  const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a1a2e' } };
  const headerFont = { bold: true, color: { argb: 'FFe0e0e0' }, size: 11 };
  const winFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a3a1a' } };
  const lossFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3a1a1a' } };
  const warnFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3a3a1a' } };

  function styleHeaders(ws) {
    ws.getRow(1).eachCell(c => { c.fill = headerFill; c.font = headerFont; c.alignment = { horizontal: 'center' }; });
    ws.getRow(1).height = 22;
  }

  // ─── Fetch data from DB ───
  const daily = await fetchDailyPerformance();
  const assetPerf = await fetchAssetPerformance();
  const realTrades = await fetchRealTrades();
  const scanData = await fetchScanData();
  const overallStats = await fetchOverallStats();

  const outName = `WEEKLY_AUDIT_${DATE_FROM}_to_${DATE_TO}`;

  // Sheet 1: Daily Performance
  const ws1 = wb.addWorksheet('Daily Performance');
  ws1.columns = [
    { header: 'Date', key: 'date', width: 14 },
    { header: 'Total Signals', key: 'total_signals', width: 14 },
    { header: 'Resolved', key: 'resolved', width: 12 },
    { header: 'Wins', key: 'wins', width: 8 },
    { header: 'Losses', key: 'losses', width: 8 },
    { header: 'Win Rate %', key: 'win_rate_pct', width: 12 },
    { header: 'Avg PnL', key: 'avg_pnl', width: 10 },
    { header: 'Real Count', key: 'real_count', width: 12 },
    { header: 'Real Wins', key: 'real_wins', width: 10 },
    { header: 'Real Losses', key: 'real_losses', width: 12 },
    { header: 'Real Avg PnL', key: 'real_avg_pnl', width: 13 },
  ];
  daily.forEach(r => {
    r.date = r.date ? new Date(r.date).toISOString().slice(0, 10) : '';
    ws1.addRow(r);
  });
  styleHeaders(ws1);
  ws1.eachRow((row, i) => {
    if (i <= 1) return;
    const wr = parseFloat(row.getCell('win_rate_pct').value);
    if (wr >= 60) row.eachCell(c => c.fill = winFill);
    else if (wr < 30) row.eachCell(c => c.fill = lossFill);
  });

  // Sheet 2: Asset Performance (from DB)
  const ws2 = wb.addWorksheet('Asset Performance');
  ws2.columns = [
    { header: 'Asset', key: 'asset', width: 10 },
    { header: 'Resolved', key: 'resolved', width: 12 },
    { header: 'Wins', key: 'wins', width: 8 },
    { header: 'Losses', key: 'losses', width: 8 },
    { header: 'Pending', key: 'pending', width: 8 },
    { header: 'WR%', key: 'wr', width: 10 },
    { header: 'Avg PnL', key: 'avg_pnl', width: 10 },
    { header: 'Real Count', key: 'real_count', width: 12 },
    { header: 'Real Wins', key: 'real_wins', width: 10 },
    { header: 'Real WR%', key: 'real_wr', width: 10 },
    { header: 'Real Avg PnL', key: 'real_avg_pnl', width: 13 },
  ];
  assetPerf.forEach(r => ws2.addRow(r));
  styleHeaders(ws2);
  ws2.eachRow((row, i) => {
    if (i <= 1) return;
    const wr = parseFloat(row.getCell('wr').value);
    if (wr >= 60) row.eachCell(c => c.fill = winFill);
    else if (wr < 35) row.eachCell(c => c.fill = lossFill);
  });

  // Sheet 3: Real Trades (from DB)
  const ws3 = wb.addWorksheet('Real Trades');
  ws3.columns = [
    { header: 'ID', key: 'id', width: 8 },
    { header: 'Asset', key: 'asset', width: 8 },
    { header: 'Dir', key: 'direction', width: 7 },
    { header: 'TF', key: 'timeframe', width: 6 },
    { header: 'Prob', key: 'probability', width: 6 },
    { header: 'PnL', key: 'pnl', width: 10 },
    { header: 'Outcome', key: 'outcome', width: 12 },
    { header: 'BloFin PnL', key: 'blofin_pnl_usd', width: 12 },
    { header: 'Source', key: 'data_source', width: 16 },
    { header: 'Exit', key: 'exit_reason', width: 10 },
    { header: 'Created', key: 'created_at', width: 20 },
  ];
  realTrades.forEach(r => {
    r.created_at = r.created_at ? new Date(r.created_at).toISOString() : '';
    ws3.addRow(r);
  });
  styleHeaders(ws3);
  ws3.eachRow((row, i) => {
    if (i <= 1) return;
    const outcome = String(row.getCell('outcome').value);
    if (outcome === 'win') row.eachCell(c => c.fill = winFill);
    else if (outcome === 'loss') row.eachCell(c => c.fill = lossFill);
  });

  // Sheet 4: Gate Performance (from CSV if available, optional)
  const gates = parseCSV('GATE_PERFORMANCE_WEEK1.csv').filter(r => r.gate_name);
  if (gates.length > 0) {
    const ws4 = wb.addWorksheet('Gate Performance');
    ws4.columns = [
      { header: 'Gate', key: 'gate_name', width: 30 },
      { header: 'Type', key: 'gate_type', width: 12 },
      { header: 'Active', key: 'active', width: 25 },
      { header: 'Deployed', key: 'deployed_date', width: 14 },
      { header: 'Description', key: 'description', width: 55 },
      { header: 'Notes', key: 'notes', width: 60 },
    ];
    gates.forEach(r => ws4.addRow(r));
    styleHeaders(ws4);
  }

  // Sheet 5: Scan Count Distribution (from DB)
  const ws5 = wb.addWorksheet('Scan Count Analysis');
  ws5.columns = [
    { header: 'Scan Count', key: 'sc', width: 14 },
    { header: 'Total', key: 'total', width: 10 },
    { header: 'Wins', key: 'wins', width: 10 },
    { header: 'Resolved', key: 'resolved', width: 10 },
    { header: 'Win Rate %', key: 'wr', width: 12 },
    { header: 'Avg PnL', key: 'avgpnl', width: 10 },
  ];
  scanData.forEach(r => ws5.addRow(r));
  styleHeaders(ws5);
  ws5.eachRow((row, i) => {
    if (i <= 1) return;
    const wr = parseFloat(row.getCell('wr').value);
    if (wr >= 60) row.eachCell(c => c.fill = winFill);
    else if (wr < 40) row.eachCell(c => c.fill = lossFill);
  });

  // Sheet 6: Upgrades Impact (from CSV if available, optional)
  const upgrades = parseCSV('UPGRADES_IMPACT_SUMMARY.csv');
  if (upgrades.length > 0) {
    const ws6 = wb.addWorksheet('Upgrades Impact');
    ws6.columns = [
      { header: 'Upgrade', key: 'upgrade_name', width: 50 },
      { header: 'Date', key: 'deployed_date', width: 14 },
      { header: 'Category', key: 'category', width: 18 },
      { header: 'Before', key: 'before_value', width: 20 },
      { header: 'After', key: 'after_value', width: 20 },
      { header: 'Improvement', key: 'improvement', width: 18 },
      { header: 'Confidence', key: 'confidence', width: 12 },
      { header: 'Notes', key: 'notes', width: 60 },
    ];
    upgrades.forEach(r => ws6.addRow(r));
    styleHeaders(ws6);
  }

  // Sheet 7: Risk Metrics (computed from DB data)
  const ws9 = wb.addWorksheet('Risk Metrics');
  ws9.columns = [
    { header: 'Metric', key: 'metric', width: 30 },
    { header: 'Value', key: 'value', width: 18 },
    { header: 'Assessment', key: 'assess', width: 50 },
  ];
  const stats = overallStats;
  const totalWins = parseInt(realTrades.filter(r => r.outcome === 'win').length) || 0;
  const totalLosses = parseInt(realTrades.filter(r => r.outcome === 'loss').length) || 0;
  const avgWinPnl = realTrades.filter(r => r.outcome === 'win').reduce((s, r) => s + parseFloat(r.pnl || 0), 0) / (totalWins || 1);
  const avgLossPnl = realTrades.filter(r => r.outcome === 'loss').reduce((s, r) => s + parseFloat(r.pnl || 0), 0) / (totalLosses || 1);
  const wlRatio = totalLosses > 0 ? Math.abs(avgWinPnl / avgLossPnl).toFixed(2) : 'N/A';
  const expectancy = totalWins + totalLosses > 0
    ? ((totalWins * avgWinPnl + totalLosses * avgLossPnl) / (totalWins + totalLosses)).toFixed(4)
    : 'N/A';
  const riskData = [
    { metric: 'Total Signals', value: String(stats.total_signals || 0), assess: `${DATE_FROM} to ${DATE_TO}` },
    { metric: 'Real Trades', value: String(stats.real_trades || 0), assess: '' },
    { metric: 'Paper Win Rate', value: (stats.paper_wr || 0) + '%', assess: '' },
    { metric: 'Net Real PnL', value: '$' + (stats.net_real_pnl || 0), assess: '' },
    { metric: 'Win/Loss Ratio', value: wlRatio + 'x', assess: '' },
    { metric: 'Avg Win PnL', value: '$' + avgWinPnl.toFixed(4), assess: '' },
    { metric: 'Avg Loss PnL', value: '$' + avgLossPnl.toFixed(4), assess: '' },
    { metric: 'Expectancy/Trade', value: '$' + expectancy, assess: '' },
    { metric: 'Pending Signals', value: String(stats.pending || 0), assess: '' },
  ];
  riskData.forEach(r => ws9.addRow(r));
  styleHeaders(ws9);

  // Sheet 8: Indicator Performance (from CSV if available, optional)
  const indicators = parseCSV('INDICATOR_PERFORMANCE_WEEK1.csv');
  if (indicators.length > 0) {
    const ws10 = wb.addWorksheet('Indicators');
    ws10.columns = [
      { header: 'Indicator', key: 'indicator', width: 12 },
      { header: 'Direction', key: 'direction', width: 10 },
      { header: 'Signal', key: 'current_signal', width: 14 },
      { header: 'Value', key: 'signal_value', width: 12 },
      { header: 'Weight', key: 'weight', width: 8 },
      { header: 'WR When Active', key: 'wr_when_active', width: 16 },
      { header: 'Notes', key: 'notes', width: 70 },
    ];
    indicators.forEach(r => ws10.addRow(r));
    styleHeaders(ws10);
  }

  await wb.xlsx.writeFile(path.join(DIR, outName + '.xlsx'));
  console.log('Excel saved: ' + outName + '.xlsx');
}

// ═══════════════════════════════════════════════
// PDF REPORT
// ═══════════════════════════════════════════════
async function generatePDF() {
  const overallStats = await fetchOverallStats();
  const daily = await fetchDailyPerformance();
  const assetPerf = await fetchAssetPerformance();
  const scanData = await fetchScanData();
  const realTrades = await fetchRealTrades();

  const outName = `WEEKLY_AUDIT_${DATE_FROM}_to_${DATE_TO}`;
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  const out = fs.createWriteStream(path.join(DIR, outName + '.pdf'));
  doc.pipe(out);

  const DARK = '#0d1117'; const ACCENT = '#58a6ff'; const GREEN = '#3fb950'; const RED = '#f85149';
  const YELLOW = '#d29922'; const WHITE = '#e6edf3'; const GRAY = '#8b949e';

  function title(text) { doc.fontSize(20).fillColor(ACCENT).text(text, { align: 'center' }); doc.moveDown(0.5); }
  function h2(text) { doc.fontSize(14).fillColor(ACCENT).text(text); doc.moveDown(0.3); }
  function h3(text) { doc.fontSize(11).fillColor(YELLOW).text(text); doc.moveDown(0.2); }
  function body(text) { doc.fontSize(9).fillColor('#c9d1d9').text(text, { lineGap: 2 }); doc.moveDown(0.3); }
  function metric(label, value, color) {
    doc.fontSize(9).fillColor(GRAY).text(label, { continued: true });
    doc.fillColor(color || WHITE).text('  ' + value);
  }
  function sep() { doc.moveDown(0.3); doc.strokeColor('#30363d').lineWidth(0.5).moveTo(40, doc.y).lineTo(555, doc.y).stroke(); doc.moveDown(0.3); }

  function simpleTable(headers, rows, colWidths) {
    const startX = 40;
    let y = doc.y;
    // Header
    doc.fontSize(8).fillColor(ACCENT);
    let x = startX;
    headers.forEach((h, i) => { doc.text(h, x, y, { width: colWidths[i], align: 'left' }); x += colWidths[i]; });
    y = doc.y + 4;
    doc.strokeColor('#30363d').lineWidth(0.5).moveTo(startX, y).lineTo(555, y).stroke();
    y += 4;
    // Rows
    rows.forEach(row => {
      if (y > 760) { doc.addPage(); y = 40; }
      x = startX;
      doc.fontSize(7.5).fillColor('#c9d1d9');
      row.forEach((cell, i) => {
        const val = String(cell || '');
        // Color coding
        if (val === 'win') doc.fillColor(GREEN);
        else if (val === 'loss') doc.fillColor(RED);
        else if (val.includes('BANNED') || val.includes('Critical')) doc.fillColor(RED);
        else if (val.includes('YES') || val.includes('watchlist')) doc.fillColor(YELLOW);
        else doc.fillColor('#c9d1d9');
        doc.text(val, x, y, { width: colWidths[i], align: 'left' });
        x += colWidths[i];
      });
      y = doc.y + 2;
    });
    doc.y = y + 4;
  }

  // ─── PAGE 1: COVER ───
  doc.rect(0, 0, 595, 842).fill(DARK);
  doc.moveDown(6);
  doc.fontSize(28).fillColor(ACCENT).text('ULTIMATE CRYPTO BACKTESTER PRO', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(22).fillColor(WHITE).text('End-of-Week Audit Report', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(14).fillColor(GRAY).text(`${DATE_FROM} to ${DATE_TO}`, { align: 'center' });
  doc.moveDown(2);

  // Key stats box (dynamic from DB)
  doc.fontSize(11).fillColor(WHITE);
  const coverStats = [
    ['Total Signals', String(overallStats.total_signals || 0)],
    ['Real Trades', String(overallStats.real_trades || 0)],
    ['Paper Win Rate', (overallStats.paper_wr || 0) + '%'],
    ['Net Real PnL', (parseFloat(overallStats.net_real_pnl || 0) >= 0 ? '+' : '') + '$' + (overallStats.net_real_pnl || 0)],
    ['Pending Signals', String(overallStats.pending || 0)],
  ];
  coverStats.forEach(([k, v]) => {
    metric(k + ':', v, v.includes('+') ? GREEN : WHITE);
  });

  // ─── PAGE 2: DAILY PERFORMANCE ───
  doc.addPage(); doc.rect(0, 0, 595, 842).fill(DARK); doc.y = 40;
  title('Daily Performance Summary');
  simpleTable(
    ['Date', 'Signals', 'Wins', 'Losses', 'WR%', 'Avg PnL', 'Real', 'Real Wins'],
    daily.map(r => [
      r.date ? new Date(r.date).toISOString().slice(0, 10) : '',
      r.total_signals, r.wins, r.losses,
      (r.win_rate_pct || 0) + '%', r.avg_pnl || '0',
      r.real_count || 0, r.real_wins || 0
    ]),
    [70, 55, 45, 50, 45, 55, 55, 55]
  );

  // ─── PAGE 3: ASSET PERFORMANCE ───
  doc.addPage(); doc.rect(0, 0, 595, 842).fill(DARK); doc.y = 40;
  title('Asset Performance');
  simpleTable(
    ['Asset', 'Resolved', 'Wins', 'WR%', 'Avg PnL', 'Real', 'Real Wins', 'Real WR%', 'Real PnL'],
    assetPerf.map(r => [
      r.asset, r.resolved, r.wins, (r.wr || 0) + '%', r.avg_pnl || '0',
      r.real_count || 0, r.real_wins || 0, (r.real_wr || 0) + '%', r.real_avg_pnl || '0'
    ]),
    [50, 50, 40, 45, 50, 40, 50, 50, 50]
  );

  // ─── PAGE 4: SCAN COUNT + GATES ───
  doc.addPage(); doc.rect(0, 0, 595, 842).fill(DARK); doc.y = 40;
  title('Signal Building & Scan Count Analysis');
  h2('Scan Count Distribution');
  simpleTable(
    ['Scans', 'Total', 'Wins', 'Resolved', 'WR%', 'Avg PnL', 'Assessment'],
    scanData.map(r => {
      const wr = parseFloat(r.wr || 0);
      return [r.sc, r.total, r.wins, r.resolved, wr + '%',
        parseFloat(r.avgpnl || 0).toFixed(4),
        wr >= 60 ? 'STRONG' : wr >= 50 ? 'OK' : wr < 40 ? 'WEAK' : 'MARGINAL'];
    }),
    [45, 45, 45, 50, 45, 55, 230]
  );

  // ─── PAGE 5: RISK METRICS + MONTE CARLO ───
  doc.addPage(); doc.rect(0, 0, 595, 842).fill(DARK); doc.y = 40;
  title('Risk Metrics');
  h2('Real Trade Risk Metrics');

  const rtWins = realTrades.filter(r => r.outcome === 'win');
  const rtLosses = realTrades.filter(r => r.outcome === 'loss');
  const rtAvgWin = rtWins.length > 0 ? rtWins.reduce((s, r) => s + parseFloat(r.pnl || 0), 0) / rtWins.length : 0;
  const rtAvgLoss = rtLosses.length > 0 ? rtLosses.reduce((s, r) => s + parseFloat(r.pnl || 0), 0) / rtLosses.length : 0;
  const rtWLRatio = rtLosses.length > 0 && rtAvgLoss !== 0 ? Math.abs(rtAvgWin / rtAvgLoss).toFixed(2) : 'N/A';
  const rtWR = (rtWins.length + rtLosses.length) > 0
    ? (100 * rtWins.length / (rtWins.length + rtLosses.length)).toFixed(1) : '0';
  const rtNetPnl = realTrades.reduce((s, r) => s + parseFloat(r.pnl || 0), 0).toFixed(2);
  const rtExpectancy = (rtWins.length + rtLosses.length) > 0
    ? ((rtWins.length * rtAvgWin + rtLosses.length * rtAvgLoss) / (rtWins.length + rtLosses.length)).toFixed(4) : '0';

  const riskItems = [
    ['Win Rate', rtWR + '%', `${rtWins.length}W / ${rtLosses.length}L`],
    ['Win/Loss Ratio', rtWLRatio + 'x', ''],
    ['Avg Win PnL', '$' + rtAvgWin.toFixed(4), ''],
    ['Avg Loss PnL', '$' + rtAvgLoss.toFixed(4), ''],
    ['Expectancy/Trade', '$' + rtExpectancy, ''],
    ['Net Real PnL', '$' + rtNetPnl, `${realTrades.length} trades`],
    ['Paper Win Rate', (overallStats.paper_wr || 0) + '%', `${overallStats.total_signals || 0} signals`],
  ];
  riskItems.forEach(([m, v, a]) => {
    const label = a ? v + '  (' + a + ')' : v;
    metric(m + ':', label, v.includes('-') ? RED : GREEN);
  });

  // ─── PAGE 6: OPEN POSITIONS ALERT ───
  doc.addPage(); doc.rect(0, 0, 595, 842).fill(DARK); doc.y = 40;
  doc.fontSize(20).fillColor(YELLOW).text('Open Position Review', { align: 'center' });
  doc.moveDown(1);
  // Dynamically show open positions from CSV if available
  const positions2 = parseCSV('TONIGHT_POSITIONS_RESOLUTION.csv').filter(r => r.id);
  if (positions2.length > 0) {
    h2(`Open Positions (${positions2.length})`);
    simpleTable(
      ['ID', 'Asset', 'TF', 'Prob', 'Entry', 'Stop', 'Target', 'PnL%'],
      positions2.map(r => [r.id, r.asset || '', r.timeframe, (r.probability || '') + '%',
        r.entry_price, r.stop_price, r.target_price, (r.unrealised_pnl_pct || '') + '%']),
      [35, 45, 30, 35, 55, 55, 55, 50]
    );
  } else {
    body('No open position CSV found for this period.');
  }

  // ─── PAGE 7: BUG AUDIT ───
  doc.addPage(); doc.rect(0, 0, 595, 842).fill(DARK); doc.y = 40;
  title('Report Summary');
  h2('Period Overview');
  body(`Report period: ${DATE_FROM} to ${DATE_TO}`);
  body(`Total signals: ${overallStats.total_signals || 0}`);
  body(`Real trades: ${overallStats.real_trades || 0}`);
  body(`Paper WR: ${overallStats.paper_wr || 0}%`);
  body(`Net real PnL: $${overallStats.net_real_pnl || 0}`);

  // ─── PAGE 8: UPGRADES IMPACT ───
  doc.addPage(); doc.rect(0, 0, 595, 842).fill(DARK); doc.y = 40;
  title('Upgrades & Fixes Impact');
  const upgrades2 = parseCSV('UPGRADES_IMPACT_SUMMARY.csv');
  if (upgrades2.length > 0) {
    simpleTable(
      ['Upgrade', 'Date', 'Impact', 'Confidence'],
      upgrades2.map(r => [r.upgrade_name, r.deployed_date, r.improvement, r.confidence]),
      [220, 80, 110, 105]
    );
  } else {
    body('No upgrades impact CSV found for this period.');
  }

  // Finalize
  doc.end();
  return new Promise(resolve => out.on('finish', () => { console.log('PDF saved: ' + outName + '.pdf'); resolve(); }));
}

// ─── RUN ───
// Usage: node generate_reports.js --from 2026-03-14 --to 2026-03-21 --db postgresql://...
// Defaults to last 7 days if --from/--to not provided.
(async () => {
  try {
    await generateExcel();
    await generatePDF();
    console.log('\nDone! Files saved to:', DIR);
  } catch (err) {
    console.error('Report generation failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
