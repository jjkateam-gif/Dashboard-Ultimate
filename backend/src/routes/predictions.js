const express = require('express');
const { authenticate } = require('../middleware/auth');
const predictionEngine = require('../services/predictionEngine');
const router = express.Router();
router.use(authenticate);

// GET /predictions/markets
router.get('/markets', (req, res) => {
  const markets = predictionEngine.getMarkets();
  res.json({ markets, total: markets.length });
});

// GET /predictions/signals
router.get('/signals', (req, res) => {
  res.json({ signals: predictionEngine.getSignals() });
});

// GET /predictions/performance
router.get('/performance', (req, res) => {
  res.json(predictionEngine.getAllPerformance());
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

// POST /predictions/mode — switch paper/real
router.post('/mode', (req, res) => {
  const { mode } = req.body;
  if (!mode || !['paper', 'real'].includes(mode)) {
    return res.status(400).json({ error: 'Mode must be "paper" or "real"' });
  }
  predictionEngine.setConfig({ mode });
  res.json({ success: true, mode: predictionEngine.getMode() });
});

// POST /predictions/start
router.post('/start', (req, res) => {
  predictionEngine.startBot();
  res.json({ success: true, running: true, mode: predictionEngine.getMode() });
});

// POST /predictions/stop
router.post('/stop', (req, res) => {
  predictionEngine.stopBot();
  res.json({ success: true, running: false });
});

// POST /predictions/price — update price cache
router.post('/price', (req, res) => {
  const { symbol, price } = req.body;
  if (symbol && price) predictionEngine.updatePrice(symbol, price);
  res.json({ success: true });
});

// GET /predictions/status — full status snapshot
router.get('/status', (req, res) => {
  res.json({
    running: predictionEngine.isRunning(),
    mode: predictionEngine.getMode(),
    config: predictionEngine.getConfig(),
    marketsCount: predictionEngine.getMarkets().length,
    signalsCount: predictionEngine.getSignals().length,
    stats: predictionEngine.getAllPerformance(),
  });
});

// ─── AI Engine Endpoints ───

// GET /predictions/ai/status — AI engine status, model info, pipeline readiness
router.get('/ai/status', (req, res) => {
  res.json(predictionEngine.getAIStatus());
});

// GET /predictions/ai/features/:asset — live features for an asset (btc, eth, sol, xrp)
router.get('/ai/features/:asset', (req, res) => {
  res.json(predictionEngine.getAIFeatures(req.params.asset));
});

// GET /predictions/ai/importance — feature importance stats from logged predictions
router.get('/ai/importance', (req, res) => {
  res.json(predictionEngine.getFeatureImportance());
});

module.exports = router;
