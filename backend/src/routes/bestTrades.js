const express = require('express');
const { authenticate } = require('../middleware/auth');
const scanner = require('../services/bestTradesScanner');
const { pool } = require('../db');
const router = express.Router();
router.use(authenticate);

// ── Input Validation Helpers ──
function isPositiveInt(val) {
  const n = parseInt(val);
  return Number.isFinite(n) && n > 0;
}
function isAlphanumDash(val) {
  return typeof val === 'string' && /^[A-Za-z0-9_-]+$/.test(val);
}
function isIsoDate(val) {
  return typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val) && !isNaN(Date.parse(val));
}
const VALID_TIMEFRAMES = ['1m','3m','5m','15m','30m','1h','2h','4h','6h','12h','1d','1w'];
const VALID_OUTCOMES = ['win','loss','pending','all'];
const VALID_CONFIDENCES = ['low','medium','high','very_high'];
const VALID_QUALITIES = ['A+','A','B','C','D'];
const VALID_REGIMES = ['trending_up','trending_down','ranging','volatile'];

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
  try {
    res.json(await scanner.getSettings());
  } catch (err) {
    console.error('[BestTrades] Settings fetch error:', err);
    res.status(500).json({ error: err.message });
  }
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
    const results = await scanner.scan({ force: true });
    res.json({ success: true, results: results.slice(0, 20), total: results.length });
  } catch (err) {
    console.error('[BestTrades] Manual scan error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /best-trades/results — last scan results
router.get('/results', (req, res) => {
  if (req.query.limit && !isPositiveInt(req.query.limit)) {
    return res.status(400).json({ error: 'limit must be a positive integer' });
  }
  const limit = parseInt(req.query.limit) || 20;
  res.json({
    results: scanner.getLastResults().slice(0, limit),
    lastScanTime: scanner.getLastScanTime(),
  });
});

// GET /best-trades/stats — win rates broken down by timeframe, confidence, quality, regime + Sharpe
router.get('/stats', async (req, res) => {
  try {
    if (req.query.timeframe && !VALID_TIMEFRAMES.includes(req.query.timeframe)) {
      return res.status(400).json({ error: 'Invalid timeframe' });
    }
    if (req.query.regime && !VALID_REGIMES.includes(req.query.regime)) {
      return res.status(400).json({ error: 'Invalid regime' });
    }
    if (req.query.market_quality && !VALID_QUALITIES.includes(req.query.market_quality)) {
      return res.status(400).json({ error: 'Invalid market_quality' });
    }
    if (req.query.confidence && !VALID_CONFIDENCES.includes(req.query.confidence)) {
      return res.status(400).json({ error: 'Invalid confidence' });
    }
    if (req.query.date_from && !isIsoDate(req.query.date_from)) {
      return res.status(400).json({ error: 'Invalid date_from format (use YYYY-MM-DD)' });
    }
    if (req.query.date_to && !isIsoDate(req.query.date_to)) {
      return res.status(400).json({ error: 'Invalid date_to format (use YYYY-MM-DD)' });
    }
    const filters = {};
    if (req.query.timeframe) filters.timeframe = req.query.timeframe;
    if (req.query.regime) filters.regime = req.query.regime;
    if (req.query.market_quality) filters.market_quality = req.query.market_quality;
    if (req.query.confidence) filters.confidence = req.query.confidence;
    if (req.query.date_from) filters.date_from = req.query.date_from;
    if (req.query.date_to) filters.date_to = req.query.date_to;
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
  try {
    const settings = await scanner.getSettings();
    res.json({ bannedAssets: settings.bannedAssets || [] });
  } catch (err) {
    console.error('[BestTrades] Banned fetch error:', err);
    res.status(500).json({ error: err.message });
  }
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
    if (!isAlphanumDash(req.params.asset)) {
      return res.status(400).json({ error: 'Invalid asset name (alphanumeric only)' });
    }
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
    if (!isAlphanumDash(req.params.asset)) {
      return res.status(400).json({ error: 'Invalid asset name (alphanumeric only)' });
    }
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

// POST /best-trades/log — manually log a trade from the frontend
router.post('/log', async (req, res) => {
  try {
    const { asset, direction, probability, entry_price, target_price, stop_price,
            stop_pct, target_pct, rr_ratio, confidence, market_quality,
            timeframe, regime, leverage, mode, source } = req.body;
    if (!asset || !direction) return res.status(400).json({ error: 'asset and direction required' });
    if (!isAlphanumDash(asset)) return res.status(400).json({ error: 'Invalid asset name' });
    if (!['long', 'short'].includes(direction)) return res.status(400).json({ error: 'direction must be "long" or "short"' });
    if (probability !== undefined && (isNaN(probability) || probability < 0 || probability > 100)) {
      return res.status(400).json({ error: 'probability must be 0-100' });
    }
    const result = await pool.query(
      `INSERT INTO best_trades_log
       (asset, direction, probability, entry_price, target_price, stop_price,
        stop_pct, target_pct, rr_ratio, confidence, market_quality,
        timeframe, regime, engine_source, data_source, scan_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,1)
       RETURNING id`,
      [asset, direction, probability, entry_price, target_price, stop_price,
       stop_pct, target_pct, rr_ratio, confidence, market_quality,
       timeframe, regime, source || 'manual_log', 'manual_log']
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error('[BestTrades] Manual log error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /best-trades/history — scan log from DB (with optional filters)
router.get('/history', async (req, res) => {
  try {
    if (req.query.limit && !isPositiveInt(req.query.limit)) {
      return res.status(400).json({ error: 'limit must be a positive integer' });
    }
    if (req.query.offset && (isNaN(parseInt(req.query.offset)) || parseInt(req.query.offset) < 0)) {
      return res.status(400).json({ error: 'offset must be a non-negative integer' });
    }
    if (req.query.timeframe && !VALID_TIMEFRAMES.includes(req.query.timeframe)) {
      return res.status(400).json({ error: 'Invalid timeframe' });
    }
    if (req.query.outcome && !VALID_OUTCOMES.includes(req.query.outcome)) {
      return res.status(400).json({ error: 'Invalid outcome' });
    }
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
    if (req.query.date_from) { conditions.push(`created_at >= $${idx++}`); params.push(req.query.date_from); }
    if (req.query.date_to) { conditions.push(`created_at <= $${idx++}`); params.push(req.query.date_to); }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(
      `SELECT id, asset, direction, probability, confidence, market_quality, rr_ratio, regime, timeframe,
              outcome, pnl, entry_price, stop_price, target_price, stop_pct, target_pct, executed,
              created_at, resolved_at, last_seen_at, scan_count, signal_snapshot
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

// ── CSV Export Download Routes ──────────────────────────────────

function rowsToCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => {
      let val = row[h];
      if (val === null || val === undefined) return '';
      if (typeof val === 'object') val = JSON.stringify(val);
      val = String(val);
      return (val.includes(',') || val.includes('"') || val.includes('\n'))
        ? `"${val.replace(/"/g, '""')}"` : val;
    }).join(','));
  }
  return lines.join('\n');
}

// GET /best-trades/export/full — download FULL_TRADE_LOG as CSV
router.get('/export/full', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT *,
        CASE WHEN data_source = 'signal_matched' THEN 'REAL+SIGNAL'
             WHEN data_source = 'blofin_only' THEN 'REAL_ONLY'
             ELSE 'PAPER'
        END as trade_type
       FROM best_trades_log ORDER BY created_at DESC`
    );
    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="FULL_TRADE_LOG_${today}.csv"`);
    res.send(rowsToCsv(result.rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /best-trades/export/real — download REAL_TRADES_ONLY as CSV
router.get('/export/real', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT *,
        CASE WHEN data_source = 'signal_matched' THEN 'REAL+SIGNAL'
             WHEN data_source = 'blofin_only' THEN 'REAL_ONLY'
             ELSE 'PAPER'
        END as trade_type
       FROM best_trades_log
       WHERE executed = true
       ORDER BY created_at DESC`
    );
    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="REAL_TRADES_ONLY_${today}.csv"`);
    res.send(rowsToCsv(result.rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /best-trades/export/daily — download DAILY_SNAPSHOT (last 24h) as CSV
router.get('/export/daily', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT *,
        CASE WHEN data_source = 'signal_matched' THEN 'REAL+SIGNAL'
             WHEN data_source = 'blofin_only' THEN 'REAL_ONLY'
             ELSE 'PAPER'
        END as trade_type
       FROM best_trades_log
       WHERE created_at >= NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC`
    );
    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="DAILY_SNAPSHOT_${today}.csv"`);
    res.send(rowsToCsv(result.rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /best-trades/export/daterange — download trades within a date range
// Usage: /best-trades/export/daterange?from=2026-03-18&to=2026-03-21
router.get('/export/daterange', async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to query params required (YYYY-MM-DD)' });
    if (!isIsoDate(from) || !isIsoDate(to)) return res.status(400).json({ error: 'Invalid date format (use YYYY-MM-DD)' });
    const result = await pool.query(
      `SELECT *,
        CASE WHEN data_source = 'signal_matched' THEN 'REAL+SIGNAL'
             WHEN data_source = 'blofin_only' THEN 'REAL_ONLY'
             ELSE 'PAPER'
        END as trade_type
       FROM best_trades_log
       WHERE created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')
       ORDER BY created_at DESC`,
      [from, to]
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="TRADE_LOG_${from}_to_${to}.csv"`);
    res.send(rowsToCsv(result.rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ENGINE 2: Live Strategy Engine Exports ──────────────────────

// GET /best-trades/export/live-strategies — all configured live strategies
router.get('/export/live-strategies', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT *, 'LIVE_STRATEGY_ENGINE' as engine FROM live_strategies ORDER BY created_at DESC`
    );
    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="LIVE_STRATEGIES_${today}.csv"`);
    res.send(rowsToCsv(result.rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /best-trades/export/live-trades — all closed trades from Live Strategy Engine
router.get('/export/live-trades', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT *, 'LIVE_STRATEGY_ENGINE' as engine FROM live_trade_history ORDER BY closed_at DESC`
    );
    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="LIVE_ENGINE_TRADES_${today}.csv"`);
    res.send(rowsToCsv(result.rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /best-trades/export/live-positions — current open positions from Live Strategy Engine
router.get('/export/live-positions', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT *, 'LIVE_STRATEGY_ENGINE' as engine FROM live_positions ORDER BY opened_at DESC`
    );
    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="LIVE_ENGINE_POSITIONS_${today}.csv"`);
    res.send(rowsToCsv(result.rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /best-trades/export/index — list all available exports
router.get('/export/index', (req, res) => {
  res.json({
    engine_1_best_trades_scanner: {
      description: 'AI Probability Scanner — auto-discovers and executes high-probability setups',
      table: 'best_trades_log',
      exports: {
        full: '/best-trades/export/full',
        real_only: '/best-trades/export/real',
        daily_snapshot: '/best-trades/export/daily',
        date_range: '/best-trades/export/daterange?from=YYYY-MM-DD&to=YYYY-MM-DD',
      }
    },
    engine_2_live_strategy: {
      description: 'Live Strategy Engine — executes user-defined strategies from the Backtester',
      tables: ['live_strategies', 'live_trade_history', 'live_positions'],
      exports: {
        strategies: '/best-trades/export/live-strategies',
        trades: '/best-trades/export/live-trades',
        positions: '/best-trades/export/live-positions',
      }
    }
  });
});

module.exports = router;
