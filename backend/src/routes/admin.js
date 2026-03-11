const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);
router.use(requireAdmin);

// GET /admin/users
router.get('/users', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.email, u.role, u.created_at, u.last_login,
              (SELECT COUNT(*) FROM usage_stats WHERE user_id=u.id) as total_events,
              (SELECT COUNT(*) FROM usage_stats WHERE user_id=u.id AND event='login') as login_count,
              (SELECT COUNT(*) FROM paper_strategies WHERE user_id=u.id) as strategy_count
       FROM users u ORDER BY u.created_at DESC`
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error('Admin list users error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /admin/users - Create new user
router.post('/users', async (req, res) => {
  try {
    const { username, password, email, role } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users (username, password_hash, email, role) VALUES ($1, $2, $3, $4) RETURNING id, username, email, role, created_at',
      [username, hash, email || null, role || 'user']
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    console.error('Admin create user error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /admin/users/:id
router.put('/users/:id', async (req, res) => {
  try {
    const { username, password, email, role } = req.body;
    const updates = [];
    const values = [];
    let idx = 1;
    if (username) { updates.push(`username=$${idx++}`); values.push(username); }
    if (email !== undefined) { updates.push(`email=$${idx++}`); values.push(email || null); }
    if (role) { updates.push(`role=$${idx++}`); values.push(role); }
    if (password) {
      const hash = await bcrypt.hash(password, 12);
      updates.push(`password_hash=$${idx++}`);
      values.push(hash);
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id=$${idx} RETURNING id, username, email, role`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username or email already taken' });
    console.error('Admin update user error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /admin/users/:id
router.delete('/users/:id', async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    const result = await pool.query('DELETE FROM users WHERE id=$1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Admin delete user error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /admin/stats - Aggregate usage stats
router.get('/stats', async (req, res) => {
  try {
    const [totalUsers, activeToday, events, recentLogins] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM users'),
      pool.query("SELECT COUNT(DISTINCT user_id) as count FROM usage_stats WHERE event='login' AND created_at > NOW() - INTERVAL '24 hours'"),
      pool.query("SELECT event, COUNT(*) as count FROM usage_stats GROUP BY event ORDER BY count DESC"),
      pool.query("SELECT u.username, s.created_at FROM usage_stats s JOIN users u ON u.id=s.user_id WHERE s.event='login' ORDER BY s.created_at DESC LIMIT 20")
    ]);
    res.json({
      totalUsers: parseInt(totalUsers.rows[0].count),
      activeToday: parseInt(activeToday.rows[0].count),
      eventBreakdown: events.rows,
      recentLogins: recentLogins.rows
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
