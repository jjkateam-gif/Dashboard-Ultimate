require('dotenv').config();
const express = require('express');

// Catch ANY crash and log it
process.on('uncaughtException', (err) => {
  console.error('FATAL uncaughtException:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('FATAL unhandledRejection:', reason);
});
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

console.log('Starting server...');
console.log('PORT:', PORT);
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('DATABASE_URL set:', !!process.env.DATABASE_URL);
console.log('JWT_SECRET set:', !!process.env.JWT_SECRET);
console.log('CORS_ORIGIN:', process.env.CORS_ORIGIN);

// CORS - allow frontend origin
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000')
  .split(',').map(s => s.trim());

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc)
    if (!origin) return callback(null, true);
    const allowed = [
      'https://jjkateam-gif.github.io',
      'http://localhost:3000',
      'http://localhost:5500',
      'http://127.0.0.1:5500'
    ];
    if (allowed.some(a => origin.startsWith(a))) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json({ limit: '5mb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Health check - always works even if DB is down
app.get('/health', (req, res) => res.json({ status: 'ok', version: 'v2.6-market-cycle-accuracy', time: new Date().toISOString() }));
app.get('/', (req, res) => res.json({ status: 'ok', service: 'Crypto Backtester Backend' }));

// Start HTTP server FIRST so Railway sees it's alive
const server = app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});

// Then load routes and DB (async)
async function initDB() {
  try {
    if (!process.env.DATABASE_URL) {
      console.error('WARNING: DATABASE_URL not set. DB features disabled.');
      return;
    }

    const { runMigrations, pool } = require('./db');
    await runMigrations();

    // Seed admin user if none exists
    const bcrypt = require('bcryptjs');
    const adminCheck = await pool.query("SELECT id FROM users WHERE role='admin' LIMIT 1");
    if (adminCheck.rows.length === 0) {
      const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMeImmediately!2024';
      if (!process.env.ADMIN_PASSWORD) {
        console.warn('[SECURITY] Using default admin password. Set ADMIN_PASSWORD env var in production!');
      }
      const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
      await pool.query(
        "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin')",
        ['Josh', hash]
      );
      console.log('Admin user created: Josh');
    }

    // Initialize email service
    try {
      const emailService = require('./services/emailService');
      emailService.init();
    } catch (emailErr) {
      console.warn('Email service init error (registration will work without email):', emailErr.message);
    }

    // Load core routes (these must always work)
    const authRoutes = require('./routes/auth');
    const adminRoutes = require('./routes/admin');
    const walletRoutes = require('./routes/wallet');
    const paperRoutes = require('./routes/paper');
    const statsRoutes = require('./routes/stats');
    const alertRoutes = require('./routes/alerts');

    app.use('/auth', authRoutes);
    app.use('/admin', adminRoutes);
    app.use('/wallet', walletRoutes);
    app.use('/paper', paperRoutes);
    app.use('/stats', statsRoutes);
    app.use('/alerts', alertRoutes);

    console.log('Core routes loaded.');

    // Load live trading routes (separate try/catch so it doesn't break core routes)
    try {
      const liveRoutes = require('./routes/live');
      app.use('/live', liveRoutes);

      const liveEngine = require('./services/liveEngine');
      liveEngine.start();
      console.log('Live trading routes loaded. Engine started.');
    } catch (liveErr) {
      console.error('Live trading init error (core routes still working):', liveErr.message);
      // Debug endpoint removed for security - do not expose stack traces
    }

    // Load news aggregator routes (separate try/catch so it doesn't break core routes)
    try {
      const newsAggregator = require('./services/newsAggregator');
      const newsRoutes = require('./routes/news');
      app.use('/news', newsRoutes);
      newsAggregator.start();
      console.log('News aggregator started.');
    } catch (newsErr) {
      console.error('News aggregator init error (core routes still working):', newsErr.message);
    }

    // Load prediction engine routes (separate try/catch so it doesn't break core routes)
    try {
      const predictionEngine = require('./services/predictionEngine');
      const predictionRoutes = require('./routes/predictions');
      app.use('/predictions', predictionRoutes);
      predictionEngine.start();
      console.log('Prediction engine started.');
    } catch (predErr) {
      console.error('Prediction engine init error (core routes still working):', predErr.message);
    }

    // Load Best Trades server-side scanner (separate try/catch)
    try {
      const bestTradesScanner = require('./services/bestTradesScanner');
      const bestTradesRoutes = require('./routes/bestTrades');
      app.use('/best-trades', bestTradesRoutes);
      bestTradesScanner.start();
      console.log('Best Trades scanner started.');

      // Debug endpoint (no auth) — check scanner health + DB row count
      app.get('/best-trades-debug', async (req, res) => {
        try {
          const { pool: dbPool } = require('./db');
          const countRes = await dbPool.query('SELECT COUNT(*) AS cnt FROM best_trades_log');
          const pendingRes = await dbPool.query("SELECT COUNT(*) AS cnt FROM best_trades_log WHERE outcome IS NULL");
          const lastRow = await dbPool.query('SELECT id, asset, direction, probability, timeframe, created_at FROM best_trades_log ORDER BY created_at DESC LIMIT 3');
          const colCheck = await dbPool.query("SELECT column_name FROM information_schema.columns WHERE table_name='best_trades_log' AND column_name='signal_snapshot'");
          // Show top results per TF for debugging
          const perTfSummary = {};
          for (const [tf, results] of Object.entries(bestTradesScanner.lastResultsByTF || {})) {
            perTfSummary[tf] = {
              total: results.length,
              top3: results.slice(0, 3).map(r => ({ asset: r.asset, dir: r.direction, prob: r.prob, rawProb: r.rawProb, ev: r.ev, mq: r.marketQuality, conf: r.confidence })),
            };
          }
          // Quick live test: try to fetch BTC 15m and score it
          let liveTest = null;
          try {
            const { fetchKlines: fk } = require('./services/binance');
            const btcCandles = await fk('BTCUSDT', '15m', 200);
            liveTest = { candlesReceived: btcCandles ? btcCandles.length : 0, lastCandle: btcCandles ? btcCandles[btcCandles.length - 1] : null };
            if (btcCandles && btcCandles.length > 50) {
              // Import the computeSignals and scoreConfluence from scanner
              const scanModule = require('./services/bestTradesScanner');
              // Can't access private functions directly, but we can do a manual test
              liveTest.note = 'Candles fetched OK. If results are 0, issue is in computeSignals or scoreConfluence.';
            }
          } catch (testErr) {
            liveTest = { error: testErr.message, stack: testErr.stack?.split('\n').slice(0, 3) };
          }
          res.json({
            version: 'v2.6-market-cycle-accuracy',
            scannerRunning: Object.keys(bestTradesScanner.scanTimers || {}).length > 0,
            activeTimers: Object.keys(bestTradesScanner.scanTimers || {}),
            lastResults: (bestTradesScanner.getLastResults() || []).length,
            lastScanTimes: bestTradesScanner.lastScanTimeByTF || {},
            scanDebug: bestTradesScanner.lastScanDebug || {},
            liveTest,
            perTfResults: perTfSummary,
            db: {
              totalRows: parseInt(countRes.rows[0].cnt),
              pendingRows: parseInt(pendingRes.rows[0].cnt),
              migration012: colCheck.rows.length > 0 ? 'PRESENT' : 'MISSING',
              lastEntries: lastRow.rows,
            },
            settings: bestTradesScanner.settings,
            tradeRejections: bestTradesScanner.lastTradeRejections || {},
          });
        } catch (e) {
          res.status(500).json({ error: e.message, stack: e.stack?.split('\n').slice(0, 3) });
        }
      });
    } catch (btErr) {
      console.error('Best Trades scanner init error (core routes still working):', btErr.message);
    }

    // OLD: Recommendation tracker removed — replaced by 24/7 bestTradesScanner
    // The old system only ran when browser was open and used a separate DB table.
    // All prediction logging and calibration now handled by bestTradesScanner.

    // Liquidation Risk endpoint (no auth — public data only)
    try {
      const { calculateLiquidationRisk } = require('./services/liquidationRisk');
      app.get('/liquidation-risk', async (req, res) => {
        try {
          const data = await calculateLiquidationRisk();
          res.json(data);
        } catch (e) {
          res.status(500).json({ error: e.message });
        }
      });
      console.log('Liquidation Risk endpoint loaded.');
    } catch (lrErr) {
      console.error('Liquidation Risk init error:', lrErr.message);
    }

    // Error handler — MUST be registered after all routes
    app.use((err, req, res, next) => {
      console.error('Unhandled error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });

    console.log('Server fully ready.');
  } catch (err) {
    console.error('DB init error (server still running):', err.message);
    // Still register error handler even if init fails
    app.use((errInner, req, res, next) => {
      console.error('Unhandled error:', errInner);
      res.status(500).json({ error: 'Internal server error' });
    });
  }
}

initDB();

// Heartbeat - confirm process stays alive
setInterval(() => {
  console.log("[heartbeat]", new Date().toISOString());
}, 30000);
