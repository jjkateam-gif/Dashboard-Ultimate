const express = require('express');
const { pool } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET /alerts
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, config, enabled, created_at FROM alerts WHERE user_id=$1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json({ alerts: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /alerts
router.post('/', async (req, res) => {
  try {
    const { config } = req.body;
    if (!config) return res.status(400).json({ error: 'Alert config required' });
    const result = await pool.query(
      'INSERT INTO alerts (user_id, config) VALUES ($1, $2) RETURNING id, config, enabled, created_at',
      [req.user.id, JSON.stringify(config)]
    );
    res.status(201).json({ alert: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /alerts/:id
router.put('/:id', async (req, res) => {
  try {
    const { config, enabled } = req.body;
    const updates = [];
    const values = [];
    let idx = 1;
    if (config !== undefined) { updates.push(`config=$${idx++}`); values.push(JSON.stringify(config)); }
    if (enabled !== undefined) { updates.push(`enabled=$${idx++}`); values.push(enabled); }
    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    values.push(req.params.id, req.user.id);
    const result = await pool.query(
      `UPDATE alerts SET ${updates.join(', ')} WHERE id=$${idx++} AND user_id=$${idx} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Alert not found' });
    res.json({ alert: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /alerts/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM alerts WHERE id=$1 AND user_id=$2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Alert not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /alerts/telegram - Save Telegram creds
router.post('/telegram', async (req, res) => {
  try {
    const { token, chatId } = req.body;
    if (!token || !chatId) return res.status(400).json({ error: 'Token and chatId required' });
    await pool.query(
      'INSERT INTO telegram_creds (user_id, token_encrypted, chat_id) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET token_encrypted=$2, chat_id=$3',
      [req.user.id, token, chatId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /alerts/telegram
router.get('/telegram', async (req, res) => {
  try {
    const result = await pool.query('SELECT token_encrypted, chat_id FROM telegram_creds WHERE user_id=$1', [req.user.id]);
    if (result.rows.length === 0) return res.json({ telegram: null });
    res.json({ telegram: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
