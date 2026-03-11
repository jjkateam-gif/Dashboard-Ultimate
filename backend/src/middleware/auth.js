const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const crypto = require('crypto');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Check session is still valid (not logged out)
    const hash = hashToken(token);
    const sess = await pool.query(
      'SELECT id FROM sessions WHERE token_hash=$1 AND expires_at > NOW()',
      [hash]
    );
    if (sess.rows.length === 0) {
      return res.status(401).json({ error: 'Session expired or logged out' });
    }
    req.user = decoded;
    req.tokenHash = hash;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { authenticate, requireAdmin, hashToken };
