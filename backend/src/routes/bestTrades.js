const express = require('express');
const { authenticate } = require('../middleware/auth');
const scanner = require('../services/bestTradesScanner');
const { pool } = require('../db');
const router = express.Router();
router.use(authenticate);

// GET /best-trades/status — scanner status
router.get('/status', (req, res) => {
  res.json(scanner.getStatus());
});

// GET /best-trades/settings — current settings
router.get('/settings', async (req, res) => {
  res.json(await scanner.getSettings());
});

// POST /best-trades/settings — update settings (syncs from frontend)
router.post('/settings', async (req, res) => {
  try {
    const { enabled, mode, timeframe, minProb, tradeSizeUsd, tradeSizeMode, maxOpen, leverage, tfRules } = req.body;
    const update = {};
    if (enabled !== undefined) update.enabled = !!enabled;
    if (mode && ['confirm', 'auto'].includes(mode)) update.mode = mode;
    if (timeframe) update.timeframe = timeframe;
    if (minProb) update.minProb = parseInt(minProb);
    if (tradeSizeUsd) update.tradeSizeUsd = parseFloat(tradeSizeUsd);
    if (tradeSizeMode && ['fixed', 'percent'].includes(tradeSizeMode)) update.tradeSizeMode = tradeSizeMode;
    if (maxOpen) update.maxOpen = parseInt(maxOpen);
    if (leverage) update.leverage = parseInt(leverage);
    if (tfRules && typeof tfRules === 'object') update.tfRules = tfRules;

    const settings = await scanner.updateSettings(update);
    res.json({ success: true, settings });
  } catch (err) {
    console.error('[BestTrades] Settings update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /best-trades/scan — trigger manual scan
router.post('/scan', async (req, res) => {
  try {
    // Temporarily enable for one scan if not enabled
    const wasEnabled = scanner.settings.enabled;
    if (!wasEnabled) scanner.settings.enabled = true;
    const results = await scanner.scan();
    if (!wasEnabled) scanner.settings.enabled = false;
    res.json({ success: true, results: results.slice(0, 20), total: results.length });
  } catch (err) {
    console.error('[BestTrades] Manual scan error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /best-trades/results — last scan results
router.get('/results', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json({
    results: scanner.getLastResults().slice(0, limit),
    lastScanTime: scanner.getLastScanTime(),
  });
});

// GET /best-trades/stats — win rates broken down by timeframe, confidence, quality, regime + Sharpe
router.get('/stats', async (req, res) => {
  try {
    const filters = {};
    if (req.query.timeframe) filters.timeframe = req.query.timeframe;
    if (req.query.regime) filters.regime = req.query.regime;
    if (req.query.market_quality) filters.market_quality = req.query.market_quality;
    if (req.query.confidence) filters.confidence = req.query.confidence;
    const stats = await scanner.getStats(filters);
    // Attach leverage risk / Sharpe data from scanner status
    const status = scanner.getStatus();
    stats.leverageRisk = status.leverageRisk || {};
    res.json(stats);
  } catch (err) {
    console.error('[BestTrades] Stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /best-trades/resolve — trigger manual resolution check
router.post('/resolve', async (req, res) => {
  try {
    await scanner._resolveOpenPredictions();
    res.json({ success: true });
  } catch (err) {
    console.error('[BestTrades] Manual resolve error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /best-trades/history — scan log from DB (with optional filters)
router.get('/history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = parseInt(req.query.offset) || 0;
    const conditions = [];
    const params = [];
    let idx = 1;
    if (req.query.timeframe) { conditions.push(`timeframe = $${idx++}`); params.push(req.query.timeframe); }
    if (req.query.regime) { conditions.push(`regime = $${idx++}`); params.push(req.query.regime); }
    if (req.query.market_quality) { conditions.push(`market_quality = $${idx++}`); params.push(req.query.market_quality); }
    if (req.query.confidence) { conditions.push(`confidence = $${idx++}`); params.push(req.query.confidence); }
    if (req.query.outcome === 'pending') { conditions.push('outcome IS NULL'); }
    else if (req.query.outcome) { conditions.push(`outcome = $${idx++}`); params.push(req.query.outcome); }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(
      `SELECT * FROM best_trades_log ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    );
    const countResult = await pool.query(`SELECT COUNT(*) AS total FROM best_trades_log ${where}`, params);
    res.json({
      history: result.rows,
      total: parseInt(countResult.rows[0].total),
      limit, offset,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /best-trades/history-all — fetch ALL history for distribution chart (#25 fix)
// Returns only outcome/probability/pnl for lightweight full-dataset queries
router.get('/history-all', async (req, res) => {
  try {
    const conditions = [];
    const params = [];
    let idx = 1;
    if (req.query.outcome === 'pending') { conditions.push('outcome IS NULL'); }
    else if (req.query.outcome === 'win' || req.query.outcome === 'loss') { conditions.push(`outcome = $${idx++}`); params.push(req.query.outcome); }
    else if (req.query.outcome === 'all') { /* no filter */ }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(
      `SELECT id, asset, direction, probability, confidence, market_quality, rr_ratio, regime, timeframe,
              outcome, pnl, entry_price, stop_price, target_price, stop_pct, target_pct, executed, created_at, resolved_at
       FROM best_trades_log ${where}
       ORDER BY created_at DESC LIMIT 5000`,
      params
    );
    res.json({ history: result.rows, total: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /best-trades/stream — SSE for real-time updates
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('event: connected\ndata: {}\n\n');
  scanner.addSseClient(res);
  const keepAlive = setInterval(() => { try { res.write(':ping\n\n'); } catch {} }, 30000);
  req.on('close', () => { clearInterval(keepAlive); scanner.removeSseClient(res); });
});

module.exports = router;
