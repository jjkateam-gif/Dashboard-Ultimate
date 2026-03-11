const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err);
});

async function runMigrations() {
  const fs = require('fs');
  const path = require('path');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_init.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('Database migrations complete');
  } catch (err) {
    console.error('Migration error:', err.message);
  }
}

module.exports = { pool, runMigrations };
