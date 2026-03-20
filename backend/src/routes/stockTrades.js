const express = require('express');
const { authenticate } = require('../middleware/auth');
const stockScanner = require('../services/stockScanner');
const { pool } = require('../db');
const router = express.Router();
router.use(authenticate);

// GET /stock-trades/status — scanner status
router.get('/status', (req, res) => {
  res.json(stockScanner.getStatus());
});

// GET /stock-trades/settings — current settings
router.get('/settings', async (req, res) => {
  res.json(await stockScanner.getSettings());
});

// POST /stock-trades/settings — update settings
router.post('/settings', async (req, res) => {
  try {
    const { enabled, minProb, bannedAssets } = req.body;
    const update = {};
    if (enabled !== undefined) update.enabled = !!enabled;
    if (minProb) update.minProb = parseInt(minProb);
    if (bannedAssets && Array.isArray(bannedAssets)) update.bannedAssets = bannedAssets;

    const settings = await stockScanner.updateSettings(update);
    res.json({ success: true, settings });
  } catch (err) {
    console.error('[StockTrades] Settings update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /stock-trades/results — last scan results
router.get('/results', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json({
    results: stockScanner.getLastResults().slice(0, limit),
    lastScanTime: stockScanner.getLastScanTime(),
  });
});

// GET /stock-trades/stats — win rates broken down by timeframe, confidence, quality, regime
router.get('/stats', async (req, res) => {
  try {
    const filters = {};
    if (req.query.timeframe) filters.timeframe = req.query.timeframe;
    if (req.query.regime) filters.regime = req.query.regime;
    if (req.query.market_quality) filters.market_quality = req.query.market_quality;
    if (req.query.confidence) filters.confidence = req.query.confidence;
    if (req.query.date_from) filters.date_from = req.query.date_from;
    if (req.query.date_to) filters.date_to = req.query.date_to;
    const stats = await stockScanner.getStats(filters);
    const status = stockScanner.getStatus();
    stats.scannerHeartbeat = {
      running: status.running,
      activeTimers: Object.keys(stockScanner.scanTimers || {}),
      lastScanTimes: stockScanner.lastScanTimeByTF || {},
      heartbeat: stockScanner.heartbeat || {},
    };
    res.json(stats);
  } catch (err) {
    console.error('[StockTrades] Stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /stock-trades/history-all — fetch ALL history with filters
router.get('/history-all', async (req, res) => {
  try {
    const conditions = [];
    const params = [];
    let idx = 1;
    if (req.query.outcome === 'pending') { conditions.push('outcome IS NULL'); }
    else if (req.query.outcome === 'win' || req.query.outcome === 'loss') { conditions.push(`outcome = $${idx++}`); params.push(req.query.outcome); }
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
              created_at, resolved_at, last_seen_at, scan_count, signal_snapshot, session_info, market_type
       FROM stock_trades_log ${where}
       ORDER BY COALESCE(last_seen_at, created_at) DESC LIMIT 5000`,
      params
    );
    res.json({ history: result.rows, total: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Asset Ban Management ──

// GET /stock-trades/banned — get banned assets list
router.get('/banned', async (req, res) => {
  const settings = await stockScanner.getSettings();
  res.json({ bannedAssets: settings.bannedAssets || [] });
});

// POST /stock-trades/ban/:asset — ban a single asset
router.post('/ban/:asset', async (req, res) => {
  try {
    const asset = req.params.asset.toUpperCase().trim();
    const settings = await stockScanner.getSettings();
    const banned = new Set(settings.bannedAssets || []);
    banned.add(asset);
    await stockScanner.updateSettings({ bannedAssets: [...banned] });
    console.log(`[StockTrades] BANNED: ${asset}`);
    res.json({ success: true, bannedAssets: [...banned] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /stock-trades/unban/:asset — unban a single asset
router.post('/unban/:asset', async (req, res) => {
  try {
    const asset = req.params.asset.toUpperCase().trim();
    const settings = await stockScanner.getSettings();
    const banned = new Set(settings.bannedAssets || []);
    banned.delete(asset);
    await stockScanner.updateSettings({ bannedAssets: [...banned] });
    console.log(`[StockTrades] UNBANNED: ${asset}`);
    res.json({ success: true, bannedAssets: [...banned] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /stock-trades/stream — SSE for real-time updates
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('event: connected\ndata: {}\n\n');
  stockScanner.addSseClient(res);
  const keepAlive = setInterval(() => { try { res.write(':ping\n\n'); } catch {} }, 30000);
  req.on('close', () => { clearInterval(keepAlive); stockScanner.removeSseClient(res); });
});

// POST /stock-trades/scan — trigger manual scan
router.post('/scan', async (req, res) => {
  try {
    const results = await stockScanner.scan();
    res.json({ success: true, results: results.slice(0, 20), total: results.length });
  } catch (err) {
    console.error('[StockTrades] Manual scan error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
