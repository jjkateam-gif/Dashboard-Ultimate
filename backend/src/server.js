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
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // In production, also allow the Railway domain itself
    callback(null, true); // permissive for now during setup
  },
  credentials: true
}));

app.use(express.json({ limit: '5mb' }));

// Health check - always works even if DB is down
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/', (req, res) => res.json({ status: 'ok', service: 'Crypto Backtester Backend' }));

// Start HTTP server FIRST so Railway sees it's alive
const server = app.listen(PORT, '0.0.0.0', () => {
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
      const hash = await bcrypt.hash('Todayi$Monday', 12);
      await pool.query(
        "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin')",
        ['Josh', hash]
      );
      console.log('Admin user created: Josh');
    }

    // Load routes only after DB is ready
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

    console.log('All routes loaded. Server fully ready.');
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
