const express = require('express');
const { pool } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET /paper/strategies
router.get('/strategies', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.config, s.active, s.created_at, p.state, p.updated_at
       FROM paper_strategies s
       LEFT JOIN paper_state p ON p.strategy_id = s.id
       WHERE s.user_id=$1 ORDER BY s.created_at DESC`,
      [req.user.id]
    );
    res.json({ strategies: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /paper/strategies
router.post('/strategies', async (req, res) => {
  try {
    const { id, config, state } = req.body;
    if (!id || !config) return res.status(400).json({ error: 'Strategy id and config required' });
    await pool.query(
      'INSERT INTO paper_strategies (id, user_id, config) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET config=$3, active=TRUE',
      [id, req.user.id, JSON.stringify(config)]
    );
    if (state) {
      await pool.query(
        'INSERT INTO paper_state (strategy_id, state) VALUES ($1, $2) ON CONFLICT (strategy_id) DO UPDATE SET state=$2, updated_at=NOW()',
        [id, JSON.stringify(state)]
      );
    }
    await pool.query(
      'INSERT INTO usage_stats (user_id, event, details) VALUES ($1, $2, $3)',
      [req.user.id, 'paper_start', JSON.stringify({ strategy_id: id })]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Paper create error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /paper/strategies/:id/state
router.get('/strategies/:id/state', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT p.state, p.updated_at FROM paper_state p JOIN paper_strategies s ON s.id=p.strategy_id WHERE p.strategy_id=$1 AND s.user_id=$2',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.json({ state: null });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /paper/strategies/:id/state - Update state (from frontend polling or engine)
router.put('/strategies/:id/state', async (req, res) => {
  try {
    const { state } = req.body;
    await pool.query(
      'INSERT INTO paper_state (strategy_id, state) VALUES ($1, $2) ON CONFLICT (strategy_id) DO UPDATE SET state=$2, updated_at=NOW()',
      [req.params.id, JSON.stringify(state)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /paper/strategies/:id
router.delete('/strategies/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM paper_strategies WHERE id=$1 AND user_id=$2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Strategy not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
