const express = require('express');
const { pool } = require('../db');
const { authenticate } = require('../middleware/auth');
const liveEngine = require('../services/liveEngine');
const safetyGuard = require('../services/safetyGuard');
const blofinClient = require('../services/blofinClient');
const blofinWs = require('../services/blofinWs');
const crypto = require('crypto');

const router = express.Router();
router.use(authenticate);

/* ======================================================
   BLOFIN CREDENTIALS CRUD
   ====================================================== */

// POST /live/credentials - Store encrypted BloFin API credentials
router.post('/credentials', async (req, res) => {
  try {
    const { encryptedData, demo } = req.body;
    if (!encryptedData) {
      return res.status(400).json({ error: 'encryptedData required' });
    }
    // Store demo/live flag in public_key column: 'blofin-demo' or 'blofin-live'
    const publicKey = demo ? 'blofin-demo' : 'blofin-live';
    await pool.query(
      `INSERT INTO trading_wallets (user_id, public_key, encrypted_data)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET public_key=$2, encrypted_data=$3, updated_at=NOW()`,
      [req.user.id, publicKey, JSON.stringify(encryptedData)]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Credential save error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /live/credentials - Check if credentials exist
router.get('/credentials', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT created_at, updated_at, public_key FROM trading_wallets WHERE user_id=$1',
      [req.user.id]
    );
    if (result.rows.length === 0) return res.json({ hasCredentials: false, unlocked: false });
    const unlocked = liveEngine.isUnlocked(req.user.id);
    const demo = result.rows[0].public_key === 'blofin-demo';
    res.json({
      hasCredentials: true,
      unlocked,
      demo,
      createdAt: result.rows[0].created_at,
      updatedAt: result.rows[0].updated_at,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /live/credentials - Remove stored credentials
router.delete('/credentials', async (req, res) => {
  try {
    liveEngine.lockCredentials(req.user.id);
    await pool.query('DELETE FROM trading_wallets WHERE user_id=$1', [req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /live/credentials/unlock - Decrypt credentials into RAM
router.post('/credentials/unlock', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });
    const keyPreview = await liveEngine.unlockCredentials(req.user.id, password);
    res.json({ success: true, keyPreview });
  } catch (err) {
    console.error('Credential unlock error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /live/credentials/lock - Clear credentials from RAM
router.post('/credentials/lock', async (req, res) => {
  try {
    liveEngine.lockCredentials(req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/* ======================================================
   LIVE STRATEGIES
   ====================================================== */

// POST /live/strategies - Create or update a live strategy
router.post('/strategies', async (req, res) => {
  try {
    const { id, config } = req.body;
    if (!id || !config) return res.status(400).json({ error: 'Strategy id and config required' });

    await pool.query(
      `INSERT INTO live_strategies (id, user_id, config, protocol)
       VALUES ($1, $2, $3, 'blofin')
       ON CONFLICT (id) DO UPDATE SET config=$3, protocol='blofin', active=TRUE, updated_at=NOW()`,
      [id, req.user.id, JSON.stringify(config)]
    );

    if (liveEngine.isUnlocked(req.user.id)) {
      liveEngine.addStrategy(id, config, req.user.id);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Live strategy create error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /live/strategies - List user live strategies
router.get('/strategies', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*,
              (SELECT COUNT(*) FROM live_positions p
               WHERE p.strategy_id = s.id AND p.closed_at IS NULL) AS open_positions
       FROM live_strategies s
       WHERE s.user_id=$1
       ORDER BY s.created_at DESC`,
      [req.user.id]
    );
    res.json({ strategies: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /live/strategies/:id - Update strategy config
router.put('/strategies/:id', async (req, res) => {
  try {
    const { config, active } = req.body;
    const sets = [];
    const values = [req.params.id, req.user.id];
    let idx = 3;

    if (config !== undefined) { sets.push(`config=$${idx++}`); values.push(JSON.stringify(config)); }
    if (active !== undefined) { sets.push(`active=$${idx++}`); values.push(active); }
    sets.push('updated_at=NOW()');

    if (sets.length === 1) return res.status(400).json({ error: 'No fields to update' });

    const result = await pool.query(
      `UPDATE live_strategies SET ${sets.join(', ')} WHERE id=$1 AND user_id=$2 RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Strategy not found' });

    const row = result.rows[0];

    if (row.active && liveEngine.isUnlocked(req.user.id)) {
      liveEngine.removeStrategy(req.params.id);
      liveEngine.addStrategy(row.id, row.config, req.user.id);
    } else {
      liveEngine.removeStrategy(req.params.id);
    }

    res.json({ success: true, strategy: row });
  } catch (err) {
    console.error('Live strategy update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /live/strategies/:id - Remove a live strategy
router.delete('/strategies/:id', async (req, res) => {
  try {
    liveEngine.removeStrategy(req.params.id);
    const result = await pool.query(
      'DELETE FROM live_strategies WHERE id=$1 AND user_id=$2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Strategy not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/* ======================================================
   POSITIONS & TRADE HISTORY
   ====================================================== */

// GET /live/positions - Open positions
router.get('/positions', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, s.config AS strategy_config
       FROM live_positions p
       LEFT JOIN live_strategies s ON s.id = p.strategy_id
       WHERE p.user_id=$1 AND p.closed_at IS NULL
       ORDER BY p.opened_at DESC`,
      [req.user.id]
    );

    // Enrich with live mark price + PnL from BloFin if credentials are unlocked
    const creds = liveEngine.getCredentials(req.user.id);
    const demo = liveEngine.isDemo(req.user.id);
    let livePositions = [];
    if (creds) {
      try {
        livePositions = await blofinClient.getPositions(creds, demo);
      } catch {}
    }

    const positions = result.rows.map(p => {
      const live = livePositions.find(lp => lp.instId === p.market && lp.direction === p.direction);
      return {
        ...p,
        markPrice: live ? live.markPrice : null,
        livePnl: live ? live.pnl : null,
        liquidationPrice: live ? live.liquidationPrice : parseFloat(p.liq_price) || null,
      };
    });

    res.json({ positions });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /live/history - Trade history
router.get('/history', async (req, res) => {
  try {
    let limit = parseInt(req.query.limit) || 50;
    if (limit > 500) limit = 500;
    const offset = parseInt(req.query.offset) || 0;

    const [trades, countResult] = await Promise.all([
      pool.query(
        'SELECT * FROM live_trade_history WHERE user_id=$1 ORDER BY closed_at DESC LIMIT $2 OFFSET $3',
        [req.user.id, limit, offset]
      ),
      pool.query(
        'SELECT COUNT(*) AS total FROM live_trade_history WHERE user_id=$1',
        [req.user.id]
      ),
    ]);

    res.json({
      trades: trades.rows,
      total: parseInt(countResult.rows[0].total),
      limit,
      offset,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/* ======================================================
   ORDER EXECUTION (from frontend modal)
   ====================================================== */

// POST /live/order - Execute a trade on BloFin
router.post('/order', async (req, res) => {
  try {
    const creds = liveEngine.getCredentials(req.user.id);
    if (!creds) return res.status(400).json({ error: 'Credentials not unlocked' });

    const demo = liveEngine.isDemo(req.user.id);
    const { instId, side, orderType, size, price, leverage, tpPrice, slPrice, marginMode } = req.body;
    if (!instId || !side || !size) return res.status(400).json({ error: 'instId, side, and size required' });

    const direction = side === 'buy' ? 'long' : 'short';
    const lev = leverage || 1;
    const sizeUsd = parseFloat(size) * (await blofinClient.getMarkPrice(instId, demo) || 0);

    // Safety check
    await safetyGuard.canOpenPosition(req.user.id, sizeUsd / lev, lev);

    const result = await blofinClient.openPosition({
      creds,
      instId,
      direction,
      size,
      leverage: lev,
      orderType: orderType || 'market',
      price,
      tpPrice,
      slPrice,
      marginMode,
      demo,
    });

    res.json({ success: true, orderId: result.orderId });
  } catch (err) {
    console.error('Order execution error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /live/close - Close a position
router.post('/close', async (req, res) => {
  try {
    const creds = liveEngine.getCredentials(req.user.id);
    if (!creds) return res.status(400).json({ error: 'Credentials not unlocked' });

    const demo = liveEngine.isDemo(req.user.id);
    const { instId, direction } = req.body;
    if (!instId || !direction) return res.status(400).json({ error: 'instId and direction required' });

    const result = await blofinClient.closePosition({ creds, instId, direction, demo });
    res.json({ success: true, orderId: result.orderId });
  } catch (err) {
    console.error('Close position error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// GET /live/ticker - Get current ticker for an instrument
router.get('/ticker', async (req, res) => {
  try {
    const { instId } = req.query;
    if (!instId) return res.status(400).json({ error: 'instId required' });
    const demo = liveEngine.isDemo(req.user.id);
    const ticker = await blofinClient.getTicker(instId, demo);
    res.json({ ticker });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /live/candles — BloFin candle data (public endpoint, no creds needed)
router.get('/candles', async (req, res) => {
  try {
    const { instId, bar, limit } = req.query;
    if (!instId || !bar) return res.status(400).json({ error: 'instId and bar required' });
    const raw = await blofinClient.getCandles(instId, bar, limit || '300', false);
    if (!raw || !Array.isArray(raw)) return res.json({ candles: [] });
    // Convert BloFin format [ts, o, h, l, c, vol, volCurrency] to standard
    const candles = raw.map(c => ({
      t: new Date(parseInt(c[0])).toISOString(),
      o: parseFloat(c[1]),
      h: parseFloat(c[2]),
      l: parseFloat(c[3]),
      c: parseFloat(c[4]),
      v: parseFloat(c[5]),
    })).reverse(); // BloFin returns newest first, we want oldest first
    res.json({ candles });
  } catch (err) {
    console.error('[candles] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch candles' });
  }
});

/* ======================================================
   SSE STREAM (real-time updates from BloFin WebSocket)
   ====================================================== */

router.get('/stream', (req, res) => {
  if (!liveEngine.isUnlocked(req.user.id)) {
    return res.status(400).json({ error: 'Credentials not unlocked' });
  }

  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(`event: connected\ndata: {}\n\n`);

  // Register as SSE client
  blofinWs.addSseClient(req.user.id, res);

  // Keep-alive ping every 30s
  const keepAlive = setInterval(() => {
    res.write(`:ping\n\n`);
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
  });
});

/* ======================================================
   SAFETY CONFIG & KILL SWITCH
   ====================================================== */

// GET /live/safety
router.get('/safety', async (req, res) => {
  try {
    const [config, todayPnl] = await Promise.all([
      safetyGuard.getConfig(req.user.id),
      safetyGuard.getTodayPnl(req.user.id),
    ]);
    res.json({ config, todayPnl });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /live/safety
router.put('/safety', async (req, res) => {
  try {
    const { maxPositionUsd, maxLeverage, dailyLossLimitUsd, autoCloseLiqPct } = req.body;
    const config = await safetyGuard.updateConfig(req.user.id, {
      max_position_usd: maxPositionUsd,
      max_leverage: maxLeverage,
      daily_loss_limit_usd: dailyLossLimitUsd,
      auto_close_liq_pct: autoCloseLiqPct,
    });
    res.json({ success: true, config });
  } catch (err) {
    console.error('Safety config update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /live/kill-switch
router.post('/kill-switch', async (req, res) => {
  try {
    await liveEngine.killSwitch(req.user.id);
    res.json({ success: true, message: 'Kill switch activated - all positions closed and strategies deactivated' });
  } catch (err) {
    console.error('Kill switch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /live/kill-switch/deactivate
router.post('/kill-switch/deactivate', async (req, res) => {
  try {
    await safetyGuard.deactivateKillSwitch(req.user.id);
    res.json({ success: true, message: 'Kill switch deactivated - trading can resume' });
  } catch (err) {
    console.error('Kill switch deactivate error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ======================================================
   MARKETS & BALANCE
   ====================================================== */

// GET /live/markets - Available BloFin markets
router.get('/markets', async (req, res) => {
  try {
    const demo = liveEngine.isDemo(req.user.id);
    const markets = await blofinClient.getMarkets(demo);
    res.json({ blofin: markets });
  } catch (err) {
    console.error('Markets fetch error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /live/balance - BloFin USDT balance
router.get('/balance', async (req, res) => {
  try {
    const unlocked = liveEngine.isUnlocked(req.user.id);

    if (!unlocked) {
      return res.json({ balance: { usdt: null, locked: true } });
    }

    const creds = liveEngine.getCredentials(req.user.id);
    const demo = liveEngine.isDemo(req.user.id);
    const balance = await blofinClient.getBalance(creds, demo);
    res.json({ balance: { ...balance, locked: false } });
  } catch (err) {
    console.error('Balance fetch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /live/status - Engine status
router.get('/status', async (req, res) => {
  try {
    const unlocked = liveEngine.isUnlocked(req.user.id);

    let activeStrategies = 0;
    for (const [, entry] of liveEngine.strategies) {
      if (entry.userId === req.user.id) activeStrategies++;
    }

    const posResult = await pool.query(
      'SELECT COUNT(*) AS total FROM live_positions WHERE user_id=$1 AND closed_at IS NULL',
      [req.user.id]
    );
    const openPositions = parseInt(posResult.rows[0].total);

    const safetyConfig = await safetyGuard.getConfig(req.user.id);

    res.json({
      engineRunning: liveEngine.running,
      credentialsUnlocked: unlocked,
      activeStrategies,
      openPositions,
      killSwitchActive: safetyConfig.kill_switch || false,
      demo: liveEngine.isDemo(req.user.id),
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
