const express = require('express');
const { pool } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET /wallet - Get user's encrypted wallet
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT public_key, encrypted_data, backed_up FROM wallets WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1',
      [req.user.id]
    );
    if (result.rows.length === 0) return res.json({ wallet: null });
    res.json({ wallet: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /wallet - Store encrypted wallet
router.post('/', async (req, res) => {
  try {
    const { publicKey, encryptedData, backedUp } = req.body;
    if (!encryptedData) return res.status(400).json({ error: 'Encrypted data required' });
    // Upsert: delete old wallet, insert new
    await pool.query('DELETE FROM wallets WHERE user_id=$1', [req.user.id]);
    await pool.query(
      'INSERT INTO wallets (user_id, public_key, encrypted_data, backed_up) VALUES ($1, $2, $3, $4)',
      [req.user.id, publicKey || null, encryptedData, backedUp || false]
    );
    // Track event
    await pool.query(
      'INSERT INTO usage_stats (user_id, event) VALUES ($1, $2)',
      [req.user.id, 'wallet_save']
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Wallet save error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /wallet
router.delete('/', async (req, res) => {
  try {
    await pool.query('DELETE FROM wallets WHERE user_id=$1', [req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
