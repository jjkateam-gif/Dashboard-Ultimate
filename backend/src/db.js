const { Pool } = require('pg');

const dbUrl = process.env.DATABASE_URL;
console.log('DB URL prefix:', dbUrl ? dbUrl.substring(0, 30) + '...' : 'NOT SET');

const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl && dbUrl.includes('railway') ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err.message);
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
    throw err;
  }
}

module.exports = { pool, runMigrations };
