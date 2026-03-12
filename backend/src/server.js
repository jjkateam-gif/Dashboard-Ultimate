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
app.get('/health', (req, res) => res.json({ status: 'ok', version: 'v2-live', time: new Date().toISOString() }));
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

    // Start recommendation tracker (resolves pending recs every 5 min)
    try {
      const recommendationTracker = require('./services/recommendationTracker');
      recommendationTracker.start();
      console.log('Recommendation tracker started.');
    } catch (recErr) {
      console.error('Recommendation tracker init error (core routes still working):', recErr.message);
    }

    console.log('Server fully ready.');
  } catch (err) {
    console.error('DB init error (server still running):', err.message);
  }
}

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

initDB();

// Heartbeat - confirm process stays alive
setInterval(() => {
  console.log("[heartbeat]", new Date().toISOString());
}, 30000);
