const express = require('express');
const { pool } = require('../db');
const { authenticate } = require('../middleware/auth');
const liveEngine = require('../services/liveEngine');
const safetyGuard = require('../services/safetyGuard');
const jupiterAdapter = require('../services/adapters/jupiterAdapter');

const router = express.Router();
router.use(authenticate);

/* ======================================================
   TRADING WALLET CRUD
   ====================================================== */

// POST /live/wallet - Store encrypted trading wallet
router.post('/wallet', async (req, res) => {
  try {
    const { publicKey, encryptedData } = req.body;
    if (!publicKey || !encryptedData) {
      return res.status(400).json({ error: 'publicKey and encryptedData required' });
    }
    await pool.query(
      `INSERT INTO trading_wallets (user_id, public_key, encrypted_data)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET public_key=$2, encrypted_data=$3, updated_at=NOW()`,
      [req.user.id, publicKey, JSON.stringify(encryptedData)]
    );
    res.json({ success: true, publicKey });
  } catch (err) {
    console.error('Trading wallet save error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /live/wallet - Get trading wallet info
router.get('/wallet', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT public_key, created_at, updated_at FROM trading_wallets WHERE user_id=$1',
      [req.user.id]
    );
    if (result.rows.length === 0) return res.json({ wallet: null });
    const row = result.rows[0];
    const unlocked = liveEngine.isWalletUnlocked(req.user.id);
    res.json({
      wallet: {
        publicKey: row.public_key,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        unlocked,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /live/wallet - Remove trading wallet
router.delete('/wallet', async (req, res) => {
  try {
    liveEngine.lockWallet(req.user.id);
    await pool.query('DELETE FROM trading_wallets WHERE user_id=$1', [req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /live/wallet/unlock - Decrypt wallet key into RAM
router.post('/wallet/unlock', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });
    const publicKey = await liveEngine.unlockWallet(req.user.id, password);
    res.json({ success: true, publicKey });
  } catch (err) {
    console.error('Wallet unlock error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /live/wallet/lock - Clear wallet key from RAM
router.post('/wallet/lock', async (req, res) => {
  try {
    liveEngine.lockWallet(req.user.id);
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
    const { id, config, protocol } = req.body;
    if (!id || !config) return res.status(400).json({ error: 'Strategy id and config required' });
    const proto = (protocol === 'drift') ? 'drift' : 'jupiter';

    await pool.query(
      `INSERT INTO live_strategies (id, user_id, config, protocol)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET config=$3, protocol=$4, active=TRUE, updated_at=NOW()`,
      [id, req.user.id, JSON.stringify(config), proto]
    );

    if (liveEngine.isWalletUnlocked(req.user.id)) {
      liveEngine.addStrategy(id, config, req.user.id, proto);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Live strategy create error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /live/strategies - List user live strategies with open position counts
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
    const { config, protocol, active } = req.body;
    const sets = [];
    const values = [req.params.id, req.user.id];
    let idx = 3;

    if (config !== undefined) { sets.push(`config=$${idx++}`); values.push(JSON.stringify(config)); }
    if (protocol !== undefined) { sets.push(`protocol=$${idx++}`); values.push(protocol); }
    if (active !== undefined) { sets.push(`active=$${idx++}`); values.push(active); }
    sets.push('updated_at=NOW()');

    if (sets.length === 1) return res.status(400).json({ error: 'No fields to update' });

    const result = await pool.query(
      `UPDATE live_strategies SET ${sets.join(', ')} WHERE id=$1 AND user_id=$2 RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Strategy not found' });

    const row = result.rows[0];

    if (row.active && liveEngine.isWalletUnlocked(req.user.id)) {
      liveEngine.removeStrategy(req.params.id);
      liveEngine.addStrategy(row.id, row.config, req.user.id, row.protocol);
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
    res.json({ positions: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /live/history - Trade history with pagination
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
   SAFETY CONFIG & KILL SWITCH
   ====================================================== */

// GET /live/safety - Get safety config
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

// PUT /live/safety - Update safety config
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

// POST /live/kill-switch - Emergency close all positions
router.post('/kill-switch', async (req, res) => {
  try {
    await liveEngine.killSwitch(req.user.id);
    res.json({ success: true, message: 'Kill switch activated - all positions closed and strategies deactivated' });
  } catch (err) {
    console.error('Kill switch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /live/kill-switch/deactivate - Deactivate kill switch
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

// GET /live/markets - Available markets from both protocols
router.get('/markets', async (req, res) => {
  try {
    const driftAdapter = require('../services/adapters/driftAdapter');
    const [jupMarkets, driftMarkets] = await Promise.all([
      jupiterAdapter.getMarkets(),
      driftAdapter.getMarkets(),
    ]);
    res.json({ jupiter: jupMarkets, drift: driftMarkets });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /live/balance - Trading wallet SOL + USDC balance
router.get('/balance', async (req, res) => {
  try {
    const unlocked = liveEngine.isWalletUnlocked(req.user.id);

    if (!unlocked) {
      const result = await pool.query(
        'SELECT public_key FROM trading_wallets WHERE user_id=$1',
        [req.user.id]
      );
      const publicKey = result.rows.length > 0 ? result.rows[0].public_key : null;
      return res.json({ balance: { publicKey, sol: null, usdc: null, locked: true } });
    }

    const publicKey = liveEngine.getWalletPublicKey(req.user.id);
    const { getSolBalance, getTokenBalance, USDC_MINT } = require('../services/solanaRpc');
    const [sol, usdc] = await Promise.all([
      getSolBalance(publicKey),
      getTokenBalance(publicKey, USDC_MINT),
    ]);

    res.json({ balance: { publicKey, sol, usdc, locked: false } });
  } catch (err) {
    console.error('Balance fetch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /live/status - Engine status for this user
router.get('/status', async (req, res) => {
  try {
    const walletUnlocked = liveEngine.isWalletUnlocked(req.user.id);

    // Count active strategies running in the engine for this user
    let activeStrategies = 0;
    for (const [, entry] of liveEngine.strategies) {
      if (entry.userId === req.user.id) activeStrategies++;
    }

    // Count open positions in DB
    const posResult = await pool.query(
      'SELECT COUNT(*) AS total FROM live_positions WHERE user_id=$1 AND closed_at IS NULL',
      [req.user.id]
    );
    const openPositions = parseInt(posResult.rows[0].total);

    // Get kill switch status from safety config
    const safetyConfig = await safetyGuard.getConfig(req.user.id);

    res.json({
      engineRunning: liveEngine.running,
      walletUnlocked,
      activeStrategies,
      openPositions,
      killSwitchActive: safetyConfig.kill_switch || false,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
