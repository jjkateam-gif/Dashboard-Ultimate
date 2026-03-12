const express = require('express');
const { authenticate } = require('../middleware/auth');
const newsAggregator = require('../services/newsAggregator');

const router = express.Router();
router.use(authenticate);

// GET /news/feed — paginated article list
router.get('/feed', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const category = req.query.category || 'all';
    const articles = newsAggregator.getArticles(limit, category);
    res.json({ articles, total: articles.length });
  } catch (err) {
    console.error('News feed error:', err);
    res.status(500).json({ error: 'Failed to fetch news feed' });
  }
});

// GET /news/stream — SSE real-time news stream
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write('event: connected\ndata: {}\n\n');

  newsAggregator.addSseClient(res);

  const keepAlive = setInterval(() => {
    res.write(':ping\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
    newsAggregator.removeSseClient(res);
  });
});

// GET /news/sentiment — rolling sentiment for 1h, 4h, 24h
router.get('/sentiment', (req, res) => {
  try {
    res.json({
      h1: newsAggregator.getSentimentRolling(1),
      h4: newsAggregator.getSentimentRolling(4),
      h24: newsAggregator.getSentimentRolling(24),
    });
  } catch (err) {
    console.error('Sentiment error:', err);
    res.status(500).json({ error: 'Failed to fetch sentiment' });
  }
});

module.exports = router;
