const express = require('express');
const { authenticate } = require('../middleware/auth');
const predictionEngine = require('../services/predictionEngine');
const router = express.Router();
router.use(authenticate);

// GET /predictions/markets
router.get('/markets', (req, res) => {
  res.json({ markets: predictionEngine.getMarkets(), total: predictionEngine.getMarkets().length });
});

// GET /predictions/signals
router.get('/signals', (req, res) => {
  res.json({ signals: predictionEngine.getSignals() });
});

// GET /predictions/performance
router.get('/performance', (req, res) => {
  res.json({ performance: predictionEngine.getPerformance(), config: predictionEngine.getConfig() });
});

// GET /predictions/stream — SSE
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('event: connected\ndata: {}\n\n');
  predictionEngine.addSseClient(res);
  const keepAlive = setInterval(() => { try { res.write(':ping\n\n'); } catch {} }, 30000);
  req.on('close', () => { clearInterval(keepAlive); predictionEngine.removeSseClient(res); });
});

// POST /predictions/config
router.post('/config', (req, res) => {
  predictionEngine.setConfig(req.body);
  res.json({ success: true, config: predictionEngine.getConfig() });
});

// POST /predictions/start
router.post('/start', (req, res) => {
  predictionEngine.startBot();
  res.json({ success: true, running: true });
});

// POST /predictions/stop
router.post('/stop', (req, res) => {
  predictionEngine.stopBot();
  res.json({ success: true, running: false });
});

// POST /predictions/price — update price cache (called from frontend or BloFin WS)
router.post('/price', (req, res) => {
  const { symbol, price } = req.body;
  if (symbol && price) predictionEngine.updatePrice(symbol, price);
  res.json({ success: true });
});

module.exports = router;
