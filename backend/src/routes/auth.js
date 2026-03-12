const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../db');
const { authenticate, hashToken } = require('../middleware/auth');

const router = express.Router();

// Rate limiting for login attempts
const loginAttempts = new Map();
const LOGIN_WINDOW = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 10;

function loginRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const attempts = loginAttempts.get(ip) || [];
  const recent = attempts.filter(t => now - t < LOGIN_WINDOW);
  if (recent.length >= MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
  }
  recent.push(now);
  loginAttempts.set(ip, recent);
  // Clean up old entries periodically
  if (loginAttempts.size > 1000) {
    for (const [key, val] of loginAttempts) {
      if (val.filter(t => now - t < LOGIN_WINDOW).length === 0) loginAttempts.delete(key);
    }
  }
  next();
}

// POST /auth/login
router.post('/login', loginRateLimit, async (req, res) => {
  try {
    const { username, password, remember } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const result = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    // Create JWT
    const expiresIn = remember ? '30d' : '24h';
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn }
    );
    // Store session
    const expiresAt = new Date(Date.now() + (remember ? 30*86400000 : 86400000));
    await pool.query(
      'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, hashToken(token), expiresAt]
    );
    // Update last login
    await pool.query('UPDATE users SET last_login=NOW() WHERE id=$1', [user.id]);
    // Track login event
    await pool.query(
      'INSERT INTO usage_stats (user_id, event, details) VALUES ($1, $2, $3)',
      [user.id, 'login', JSON.stringify({ ip: req.ip })]
    );

    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role, email: user.email }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /auth/logout
router.post('/logout', authenticate, async (req, res) => {
  try {
    await pool.query('DELETE FROM sessions WHERE token_hash=$1', [req.tokenHash]);
    res.json({ success: true });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /auth/me
router.get('/me', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, role, created_at, last_login FROM users WHERE id=$1',
      [req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /auth/change-password
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    const result = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' });

    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.id]);
    // Invalidate all other sessions
    await pool.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash!=$2', [req.user.id, req.tokenHash]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
