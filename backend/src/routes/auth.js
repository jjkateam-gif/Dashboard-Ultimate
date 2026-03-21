const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../db');
const { authenticate, hashToken } = require('../middleware/auth');
const emailService = require('../services/emailService');

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
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
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

// POST /auth/register
router.post('/register', loginRateLimit, async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (username.length < 3 || username.length > 50) {
      return res.status(400).json({ error: 'Username must be 3-50 characters' });
    }

    // Check uniqueness
    const existing = await pool.query(
      'SELECT id FROM users WHERE username=$1 OR email=$2',
      [username, email.toLowerCase()]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Username or email already taken' });
    }

    // Create user
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, role, email_verified)
       VALUES ($1, $2, $3, 'user', FALSE) RETURNING id, username, email, role`,
      [username, email.toLowerCase(), hash]
    );
    const user = result.rows[0];

    // Create JWT + session
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    const expiresAt = new Date(Date.now() + 86400000);
    await pool.query(
      'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, hashToken(token), expiresAt]
    );

    // Send welcome email (async, don't block)
    emailService.sendWelcome(email, username).catch(() => {});

    // Track registration
    await pool.query(
      'INSERT INTO usage_stats (user_id, event, details) VALUES ($1, $2, $3)',
      [user.id, 'register', JSON.stringify({ ip: req.ip })]
    ).catch(() => {});

    res.status(201).json({ token, user });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /auth/forgot-password
router.post('/forgot-password', loginRateLimit, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    // Always return success (don't reveal if email exists)
    const result = await pool.query(
      'SELECT id, username FROM users WHERE email=$1',
      [email.toLowerCase()]
    );

    if (result.rows.length > 0) {
      const user = result.rows[0];
      // Generate reset token
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      // Invalidate any existing reset tokens for this user
      await pool.query(
        'UPDATE password_reset_tokens SET used=TRUE WHERE user_id=$1 AND used=FALSE',
        [user.id]
      );

      // Store new token
      await pool.query(
        'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
        [user.id, tokenHash, expiresAt]
      );

      // Send reset email
      const appUrl = process.env.APP_URL || 'https://jjkateam-gif.github.io/Dashboard-Ultimate';
      const resetUrl = `${appUrl}#reset=${rawToken}`;
      await emailService.sendPasswordReset(email, user.username, resetUrl);
    }

    res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ error: 'Token and new password required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await pool.query(
      `SELECT rt.id, rt.user_id, u.username FROM password_reset_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash=$1 AND rt.used=FALSE AND rt.expires_at > NOW()`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
    }

    const { id: tokenId, user_id: userId } = result.rows[0];

    // Update password
    const hash = await bcrypt.hash(password, 12);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, userId]);

    // Mark token as used
    await pool.query('UPDATE password_reset_tokens SET used=TRUE WHERE id=$1', [tokenId]);

    // Invalidate all existing sessions (force re-login)
    await pool.query('DELETE FROM sessions WHERE user_id=$1', [userId]);

    res.json({ success: true, message: 'Password reset successfully. Please log in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
