const express = require('express');
const { authenticate } = require('../middleware/auth');
const scanner = require('../services/commodityScanner');
const { pool } = require('../db');
const router = express.Router();
router.use(authenticate);

// GET /commodity-trades/status — scanner status
router.get('/status', (req, res) => {
  res.json(scanner.getStatus());
});

// GET /commodity-trades/settings — current settings
router.get('/settings', async (req, res) => {
  res.json(await scanner.getSettings());
});

// POST /commodity-trades/settings — update settings
router.post('/settings', async (req, res) => {
  try {
    const { enabled, timeframe, minProb, tfRules } = req.body;
    const update = {};
    if (enabled !== undefined) update.enabled = !!enabled;
    if (timeframe) update.timeframe = timeframe;
    if (minProb) update.minProb = parseInt(minProb);
    if (tfRules && typeof tfRules === 'object') update.tfRules = tfRules;
    if (req.body.bannedAssets && Array.isArray(req.body.bannedAssets)) update.bannedAssets = req.body.bannedAssets;

    const settings = await scanner.updateSettings(update);
    res.json({ success: true, settings });
  } catch (err) {
    console.error('[CommodityTrades] Settings update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /commodity-trades/results — last scan results
router.get('/results', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json({
    results: scanner.getLastResults().slice(0, limit),
    lastScanTime: scanner.getLastScanTime(),
  });
});

// GET /commodity-trades/stats — win rates with filters
router.get('/stats', async (req, res) => {
  try {
    const filters = {};
    if (req.query.timeframe) filters.timeframe = req.query.timeframe;
    if (req.query.regime) filters.regime = req.query.regime;
    if (req.query.market_quality) filters.market_quality = req.query.market_quality;
    if (req.query.confidence) filters.confidence = req.query.confidence;
    if (req.query.date_from) filters.date_from = req.query.date_from;
    if (req.query.date_to) filters.date_to = req.query.date_to;
    const stats = await scanner.getStats(filters);
    const status = scanner.getStatus();
    stats.scannerHeartbeat = {
      running: status.scannerRunning,
      activeTimers: Object.keys(scanner.scanTimers || {}),
      lastScanTimes: scanner.lastScanTimeByTF || {},
      heartbeat: scanner.heartbeat || {},
    };
    res.json(stats);
  } catch (err) {
    console.error('[CommodityTrades] Stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /commodity-trades/history-all — fetch ALL history with filters
router.get('/history-all', async (req, res) => {
  try {
    const conditions = [];
    const params = [];
    let idx = 1;
    if (req.query.outcome === 'pending') { conditions.push('outcome IS NULL'); }
    else if (req.query.outcome === 'win' || req.query.outcome === 'loss') { conditions.push(`outcome = $${idx++}`); params.push(req.query.outcome); }
    else if (req.query.outcome === 'all') { /* no filter */ }
    if (req.query.timeframe) { conditions.push(`timeframe = $${idx++}`); params.push(req.query.timeframe); }
    if (req.query.regime) { conditions.push(`regime = $${idx++}`); params.push(req.query.regime); }
    if (req.query.market_quality) { conditions.push(`market_quality = $${idx++}`); params.push(req.query.market_quality); }
    if (req.query.confidence) { conditions.push(`confidence = $${idx++}`); params.push(req.query.confidence); }
    if (req.query.date_from) { conditions.push(`created_at >= $${idx++}`); params.push(req.query.date_from); }
    if (req.query.date_to) { conditions.push(`created_at <= $${idx++}`); params.push(req.query.date_to); }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(
      `SELECT id, asset, direction, probability, confidence, market_quality, rr_ratio, regime, timeframe,
              outcome, pnl, entry_price, stop_price, target_price, stop_pct, target_pct, executed,
              created_at, resolved_at, last_seen_at, scan_count, signal_snapshot
       FROM commodity_trades_log ${where}
       ORDER BY COALESCE(last_seen_at, created_at) DESC LIMIT 5000`,
      params
    );
    res.json({ history: result.rows, total: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Asset Ban Management ──

// GET /commodity-trades/banned — get banned assets list
router.get('/banned', async (req, res) => {
  const settings = await scanner.getSettings();
  res.json({ bannedAssets: settings.bannedAssets || [] });
});

// POST /commodity-trades/ban/:asset — ban a single asset
router.post('/ban/:asset', async (req, res) => {
  try {
    const asset = req.params.asset.toUpperCase().trim();
    const settings = await scanner.getSettings();
    const banned = new Set(settings.bannedAssets || []);
    banned.add(asset);
    await scanner.updateSettings({ bannedAssets: [...banned] });
    console.log(`[CommodityTrades] BANNED: ${asset}`);
    res.json({ success: true, bannedAssets: [...banned] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /commodity-trades/unban/:asset — unban a single asset
router.post('/unban/:asset', async (req, res) => {
  try {
    const asset = req.params.asset.toUpperCase().trim();
    const settings = await scanner.getSettings();
    const banned = new Set(settings.bannedAssets || []);
    banned.delete(asset);
    await scanner.updateSettings({ bannedAssets: [...banned] });
    console.log(`[CommodityTrades] UNBANNED: ${asset}`);
    res.json({ success: true, bannedAssets: [...banned] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /commodity-trades/stream — SSE for real-time updates
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

// POST /commodity-trades/scan — manual trigger
router.post('/scan', async (req, res) => {
  try {
    const results = await scanner.scan();
    res.json({ success: true, results: results.slice(0, 20), total: results.length });
  } catch (err) {
    console.error('[CommodityTrades] Manual scan error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
