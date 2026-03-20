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
  const migrations = ['001_init.sql', '002_live_trading.sql', '003_blofin_migration.sql', '004_recommendations.sql', '005_auth_tokens.sql', '006_trade_log.sql', '008_prediction_state.sql', '009_best_trades.sql', '010_best_trades_timeframe.sql', '011_tf_rules.sql', '012_indicator_snapshots.sql', '013_trade_size_mode.sql', '014_scan_count.sql', '015_sizing_mode.sql', '016_market_context.sql', '017_mae_mfe_liqrisk_calibration.sql', '018_reconciliation.sql'];
  try {
    for (const file of migrations) {
      const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', file), 'utf8');
      await pool.query(sql);
      console.log('Migration ' + file + ' complete');
    }
  } catch (err) {
    console.error('Migration error:', err.message);
    throw err;
  }
}

module.exports = { pool, runMigrations };
