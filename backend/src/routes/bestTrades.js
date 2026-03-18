const express = require('express');
const { authenticate } = require('../middleware/auth');
const scanner = require('../services/bestTradesScanner');
const { pool } = require('../db');
const router = express.Router();
router.use(authenticate);

// GET /best-trades/watchlist — current watchlist candidates
router.get('/watchlist', async (req, res) => {
  try {
    const candidates = scanner.getWatchlistCandidates();
    res.json({ candidates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    const { enabled, mode, timeframe, minProb, tradeSizeUsd, tradeSizeMode, sizingMode, maxOpen, leverage, tfRules } = req.body;
    const update = {};
    if (enabled !== undefined) update.enabled = !!enabled;
    if (mode && ['confirm', 'auto'].includes(mode)) update.mode = mode;
    if (timeframe) update.timeframe = timeframe;
    if (minProb) update.minProb = parseInt(minProb);
    if (tradeSizeUsd) update.tradeSizeUsd = parseFloat(tradeSizeUsd);
    if (tradeSizeMode && ['fixed', 'percent'].includes(tradeSizeMode)) update.tradeSizeMode = tradeSizeMode;
    if (sizingMode && ['kelly', 'fixed'].includes(sizingMode)) update.sizingMode = sizingMode;
    if (maxOpen) update.maxOpen = parseInt(maxOpen);
    if (leverage) update.leverage = parseInt(leverage);
    if (tfRules && typeof tfRules === 'object') update.tfRules = tfRules;
    if (req.body.bannedAssets && Array.isArray(req.body.bannedAssets)) update.bannedAssets = req.body.bannedAssets;
    if (req.body.assetOverrides && typeof req.body.assetOverrides === 'object') update.assetOverrides = req.body.assetOverrides;

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
    // Scanner heartbeat — so frontend knows scanner is alive even when nothing qualifies
    stats.scannerHeartbeat = {
      running: status.scannerRunning,
      activeTimers: Object.keys(scanner.scanTimers || {}),
      lastScanTimes: scanner.lastScanTimeByTF || {},
      lastLogAttempt: Object.fromEntries(
        Object.entries(scanner.lastLogAttempt || {}).map(([tf, v]) => [tf, {
          candidates: v.candidates, inserted: v.inserted, updated: v.updated,
          fromResults: v.fromResults,
          topSignal: v.rawTop5?.[0] ? `${v.rawTop5[0].a} ${v.rawTop5[0].d} ${v.rawTop5[0].prob?.toFixed(0)}%` : null,
        }])
      ),
    };
    res.json(stats);
  } catch (err) {
    console.error('[BestTrades] Stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Asset Ban Management ──

// GET /best-trades/banned — get banned assets list
router.get('/banned', async (req, res) => {
  const settings = await scanner.getSettings();
  res.json({ bannedAssets: settings.bannedAssets || [] });
});

// POST /best-trades/banned — update banned assets list
router.post('/banned', async (req, res) => {
  try {
    const { bannedAssets } = req.body;
    if (!Array.isArray(bannedAssets)) return res.status(400).json({ error: 'bannedAssets must be an array' });
    const cleaned = bannedAssets.map(a => String(a).toUpperCase().trim()).filter(Boolean);
    await scanner.updateSettings({ bannedAssets: cleaned });
    console.log(`[BestTrades] Banned assets updated: ${cleaned.length ? cleaned.join(', ') : 'NONE'}`);
    res.json({ success: true, bannedAssets: cleaned });
  } catch (err) {
    console.error('[BestTrades] Ban update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /best-trades/ban/:asset — ban a single asset
router.post('/ban/:asset', async (req, res) => {
  try {
    const asset = req.params.asset.toUpperCase().trim();
    const settings = await scanner.getSettings();
    const banned = new Set(settings.bannedAssets || []);
    banned.add(asset);
    await scanner.updateSettings({ bannedAssets: [...banned] });
    console.log(`[BestTrades] BANNED: ${asset} — will continue scanning but NO live trades`);
    res.json({ success: true, bannedAssets: [...banned] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /best-trades/unban/:asset — unban a single asset
router.post('/unban/:asset', async (req, res) => {
  try {
    const asset = req.params.asset.toUpperCase().trim();
    const settings = await scanner.getSettings();
    const banned = new Set(settings.bannedAssets || []);
    banned.delete(asset);
    await scanner.updateSettings({ bannedAssets: [...banned] });
    console.log(`[BestTrades] UNBANNED: ${asset} — now eligible for live trading`);
    res.json({ success: true, bannedAssets: [...banned] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /best-trades/asset-stats — per-asset win rates + dual WR (all vs tradeable)
router.get('/asset-stats', async (req, res) => {
  try {
    const settings = await scanner.getSettings();
    const bannedSet = new Set((settings.bannedAssets || []).map(a => a.toUpperCase()));

    const result = await pool.query(`
      SELECT
        asset,
        COUNT(*) FILTER (WHERE outcome IS NOT NULL) AS resolved,
        COUNT(*) FILTER (WHERE outcome = 'win') AS wins,
        COUNT(*) FILTER (WHERE outcome = 'loss') AS losses,
        COUNT(*) FILTER (WHERE outcome IS NULL) AS pending,
        ROUND(AVG(CASE WHEN pnl IS NOT NULL THEN pnl END)::numeric, 2) AS avg_pnl,
        ROUND(100.0 * COUNT(*) FILTER (WHERE outcome = 'win') / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) AS win_rate
      FROM best_trades_log
      GROUP BY asset
      ORDER BY resolved DESC
    `);

    const assets = result.rows.map(r => ({
      asset: r.asset,
      resolved: parseInt(r.resolved),
      wins: parseInt(r.wins),
      losses: parseInt(r.losses),
      pending: parseInt(r.pending),
      avgPnl: parseFloat(r.avg_pnl) || 0,
      winRate: parseFloat(r.win_rate) || 0,
      banned: bannedSet.has(r.asset.toUpperCase()),
    }));

    // Calculate dual win rates
    const allResolved = assets.reduce((s, a) => s + a.resolved, 0);
    const allWins = assets.reduce((s, a) => s + a.wins, 0);
    const tradeableAssets = assets.filter(a => !a.banned);
    const tradeableResolved = tradeableAssets.reduce((s, a) => s + a.resolved, 0);
    const tradeableWins = tradeableAssets.reduce((s, a) => s + a.wins, 0);

    // Auto-ban suggestions: WR < 40% after 20+ resolved trades
    const banSuggestions = assets
      .filter(a => !a.banned && a.resolved >= 20 && a.winRate < 40)
      .map(a => ({ asset: a.asset, winRate: a.winRate, resolved: a.resolved, reason: `${a.winRate}% WR on ${a.resolved} trades (< 40% threshold)` }));

    res.json({
      assets,
      bannedAssets: [...bannedSet],
      dualWinRate: {
        all: { resolved: allResolved, wins: allWins, winRate: allResolved > 0 ? parseFloat((allWins / allResolved * 100).toFixed(1)) : 0 },
        tradeable: { resolved: tradeableResolved, wins: tradeableWins, winRate: tradeableResolved > 0 ? parseFloat((tradeableWins / tradeableResolved * 100).toFixed(1)) : 0 },
      },
      banSuggestions,
    });
  } catch (err) {
    console.error('[BestTrades] Asset stats error:', err);
    res.status(500).json({ error: err.message });
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
      `SELECT * FROM best_trades_log ${where} ORDER BY COALESCE(last_seen_at, created_at) DESC LIMIT $${idx} OFFSET $${idx + 1}`,
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

// GET /best-trades/history-all — fetch ALL history (full dataset)
// Supports all filters: outcome, timeframe, regime, market_quality, confidence
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
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(
      `SELECT id, asset, direction, probability, confidence, market_quality, rr_ratio, regime, timeframe,
              outcome, pnl, entry_price, stop_price, target_price, stop_pct, target_pct, executed,
              created_at, resolved_at, last_seen_at, scan_count
       FROM best_trades_log ${where}
       ORDER BY COALESCE(last_seen_at, created_at) DESC LIMIT 5000`,
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

// GET /best-trades/comparison — pre-fix vs post-fix stats
router.get('/comparison', async (req, res) => {
  try {
    const FIX_DATE = '2026-03-18T00:00:00Z';

    // Pre-fix stats (trades created before March 18)
    const preRes = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE outcome IS NOT NULL) as resolved,
        COUNT(*) FILTER (WHERE outcome='win') as wins,
        COUNT(*) FILTER (WHERE outcome='loss') as losses,
        COUNT(*) FILTER (WHERE outcome IS NULL) as pending,
        ROUND(100.0 * COUNT(*) FILTER (WHERE outcome='win') / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as wr,
        ROUND(AVG(CASE WHEN pnl IS NOT NULL THEN pnl END)::numeric, 2) as avg_pnl,
        ROUND(AVG(CASE WHEN outcome='win' THEN pnl END)::numeric, 2) as avg_win,
        ROUND(AVG(CASE WHEN outcome='loss' THEN pnl END)::numeric, 2) as avg_loss
      FROM best_trades_log WHERE created_at < $1
    `, [FIX_DATE]);

    // Post-fix stats (trades created after March 18)
    const postRes = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE outcome IS NOT NULL) as resolved,
        COUNT(*) FILTER (WHERE outcome='win') as wins,
        COUNT(*) FILTER (WHERE outcome='loss') as losses,
        COUNT(*) FILTER (WHERE outcome IS NULL) as pending,
        ROUND(100.0 * COUNT(*) FILTER (WHERE outcome='win') / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as wr,
        ROUND(AVG(CASE WHEN pnl IS NOT NULL THEN pnl END)::numeric, 2) as avg_pnl,
        ROUND(AVG(CASE WHEN outcome='win' THEN pnl END)::numeric, 2) as avg_win,
        ROUND(AVG(CASE WHEN outcome='loss' THEN pnl END)::numeric, 2) as avg_loss
      FROM best_trades_log WHERE created_at >= $1
    `, [FIX_DATE]);

    // Pre-fix per-asset (excluding banned)
    const preAssetRes = await pool.query(`
      SELECT asset,
        COUNT(*) FILTER (WHERE outcome IS NOT NULL) as resolved,
        COUNT(*) FILTER (WHERE outcome='win') as wins,
        COUNT(*) FILTER (WHERE outcome='loss') as losses,
        ROUND(100.0 * COUNT(*) FILTER (WHERE outcome='win') / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as wr
      FROM best_trades_log WHERE created_at < $1 AND outcome IS NOT NULL
      GROUP BY asset ORDER BY wr DESC
    `, [FIX_DATE]);

    // Post-fix per-asset
    const postAssetRes = await pool.query(`
      SELECT asset,
        COUNT(*) FILTER (WHERE outcome IS NOT NULL) as resolved,
        COUNT(*) FILTER (WHERE outcome='win') as wins,
        COUNT(*) FILTER (WHERE outcome='loss') as losses,
        ROUND(100.0 * COUNT(*) FILTER (WHERE outcome='win') / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as wr
      FROM best_trades_log WHERE created_at >= $1 AND outcome IS NOT NULL
      GROUP BY asset ORDER BY wr DESC
    `, [FIX_DATE]);

    // Pre-fix per-TF
    const preTfRes = await pool.query(`
      SELECT timeframe,
        COUNT(*) FILTER (WHERE outcome IS NOT NULL) as resolved,
        ROUND(100.0 * COUNT(*) FILTER (WHERE outcome='win') / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as wr
      FROM best_trades_log WHERE created_at < $1 AND outcome IS NOT NULL
      GROUP BY timeframe ORDER BY timeframe
    `, [FIX_DATE]);

    // Post-fix per-TF
    const postTfRes = await pool.query(`
      SELECT timeframe,
        COUNT(*) FILTER (WHERE outcome IS NOT NULL) as resolved,
        ROUND(100.0 * COUNT(*) FILTER (WHERE outcome='win') / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as wr
      FROM best_trades_log WHERE created_at >= $1 AND outcome IS NOT NULL
      GROUP BY timeframe ORDER BY timeframe
    `, [FIX_DATE]);

    // Pre-fix by quality grade
    const preQualRes = await pool.query(`
      SELECT market_quality,
        COUNT(*) FILTER (WHERE outcome IS NOT NULL) as resolved,
        ROUND(100.0 * COUNT(*) FILTER (WHERE outcome='win') / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as wr
      FROM best_trades_log WHERE created_at < $1 AND outcome IS NOT NULL
      GROUP BY market_quality ORDER BY wr DESC
    `, [FIX_DATE]);

    // Post-fix by quality grade
    const postQualRes = await pool.query(`
      SELECT market_quality,
        COUNT(*) FILTER (WHERE outcome IS NOT NULL) as resolved,
        ROUND(100.0 * COUNT(*) FILTER (WHERE outcome='win') / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as wr
      FROM best_trades_log WHERE created_at >= $1 AND outcome IS NOT NULL
      GROUP BY market_quality ORDER BY wr DESC
    `, [FIX_DATE]);

    res.json({
      fixDate: FIX_DATE,
      pre: { stats: preRes.rows[0], assets: preAssetRes.rows, timeframes: preTfRes.rows, quality: preQualRes.rows },
      post: { stats: postRes.rows[0], assets: postAssetRes.rows, timeframes: postTfRes.rows, quality: postQualRes.rows },
      baseline: { wr: 55.41, backtestTarget: 72.6 }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
