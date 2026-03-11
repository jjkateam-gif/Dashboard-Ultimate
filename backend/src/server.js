require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { runMigrations } = require('./db');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const walletRoutes = require('./routes/wallet');
const paperRoutes = require('./routes/paper');
const statsRoutes = require('./routes/stats');
const alertRoutes = require('./routes/alerts');

const app = express();
const PORT = process.env.PORT || 3001;

// CORS - allow frontend origin
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000')
  .split(',').map(s => s.trim());

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (curl, mobile apps)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json({ limit: '5mb' }));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Routes
app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);
app.use('/wallet', walletRoutes);
app.use('/paper', paperRoutes);
app.use('/stats', statsRoutes);
app.use('/alerts', alertRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  await runMigrations();

  // Seed admin user if none exists
  const { pool } = require('./db');
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

  app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
