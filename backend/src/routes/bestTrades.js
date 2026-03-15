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
    const { enabled, mode, timeframe, minProb, tradeSizeUsd, maxOpen, leverage, tfRules } = req.body;
    const update = {};
    if (enabled !== undefined) update.enabled = !!enabled;
    if (mode && ['confirm', 'auto'].includes(mode)) update.mode = mode;
    if (timeframe) update.timeframe = timeframe;
    if (minProb) update.minProb = parseInt(minProb);
    if (tradeSizeUsd) update.tradeSizeUsd = parseFloat(tradeSizeUsd);
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

// GET /best-trades/stats — win rates broken down by timeframe, confidence, quality, regime
router.get('/stats', async (req, res) => {
  try {
    const stats = await scanner.getStats();
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

// GET /best-trades/history — scan log from DB
router.get('/history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = parseInt(req.query.offset) || 0;
    const result = await pool.query(
      'SELECT * FROM best_trades_log ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    const countResult = await pool.query('SELECT COUNT(*) AS total FROM best_trades_log');
    res.json({
      history: result.rows,
      total: parseInt(countResult.rows[0].total),
      limit, offset,
    });
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
