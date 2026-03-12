const express = require('express');
const { pool } = require('../db');
const { authenticate } = require('../middleware/auth');
const recommendationTracker = require('../services/recommendationTracker');

const router = express.Router();
router.use(authenticate);

// POST /stats/track
router.post('/track', async (req, res) => {
  try {
    const { event, details } = req.body;
    if (!event) return res.status(400).json({ error: 'Event name required' });
    await pool.query(
      'INSERT INTO usage_stats (user_id, event, details) VALUES ($1, $2, $3)',
      [req.user.id, event, details ? JSON.stringify(details) : null]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /stats/me
router.get('/me', async (req, res) => {
  try {
    const [summary, recent, daily] = await Promise.all([
      pool.query(
        'SELECT event, COUNT(*) as count FROM usage_stats WHERE user_id=$1 GROUP BY event ORDER BY count DESC',
        [req.user.id]
      ),
      pool.query(
        'SELECT event, details, created_at FROM usage_stats WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',
        [req.user.id]
      ),
      pool.query(
        "SELECT DATE(created_at) as day, COUNT(*) as count FROM usage_stats WHERE user_id=$1 AND created_at > NOW() - INTERVAL '30 days' GROUP BY DATE(created_at) ORDER BY day",
        [req.user.id]
      )
    ]);
    res.json({
      summary: summary.rows,
      recent: recent.rows,
      daily: daily.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /stats/recommendations
router.get('/recommendations', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const recommendations = await recommendationTracker.getHistory(req.user.id, limit);
    res.json({ recommendations });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /stats/recommendations/summary
router.get('/recommendations/summary', async (req, res) => {
  try {
    const summary = await recommendationTracker.getSummary(req.user.id);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /stats/recommendations
router.post('/recommendations', async (req, res) => {
  try {
    const rec = req.body;
    if (!rec.symbol || !rec.direction) {
      return res.status(400).json({ error: 'symbol and direction required' });
    }
    const result = await recommendationTracker.saveRecommendation(req.user.id, rec);
    res.json({ success: true, id: result.id });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
