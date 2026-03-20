/**
 * BACKDATE BLOFIN TRADES — One-time reconciliation script
 *
 * Pulls complete BloFin trade history and matches against best_trades_log.
 * Updates matched records with real fill data. Creates records for unmatched trades.
 * Generates REAL_TRADES_ONLY.csv for performance analysis.
 */

const { Pool } = require('pg');
const fs = require('fs');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:wRSDXXNuuEvJMttNrQaKDbWURHnVbckX@shortline.proxy.rlwy.net:43088/railway';
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : false,
});

// Parse the BloFin trade data pasted by user (manual fallback)
const MANUAL_BLOFIN_TRADES = [
  // Page 1 — Mar 14-16
  { asset: 'PEPE', dir: 'short', avgPrice: 0.000003331, exitPrice: 0.000003439, pnl: -0.33, closedPnl: -0.32, fee: 0.01218600, lev: 2, openedAt: '2026-03-14T19:53:11Z', closedAt: '2026-03-16T08:52:44Z' },
  { asset: 'ETH', dir: 'long', avgPrice: 2095.19, exitPrice: 2183.66, pnl: 0.42, closedPnl: 0.44, fee: 0.01283655, lev: 1, openedAt: '2026-03-14T13:23:35Z', closedAt: '2026-03-16T08:50:38Z' },
  { asset: 'SOL', dir: 'long', avgPrice: 88.08, exitPrice: 91.32, pnl: 4.53, closedPnl: 4.69, fee: 0.15609048, lev: 3, openedAt: '2026-03-14T10:26:17Z', closedAt: '2026-03-16T08:41:57Z' },
  { asset: 'NEAR', dir: 'long', avgPrice: 1.338, exitPrice: 1.301, pnl: -0.38, closedPnl: -0.37, fee: 0.01583400, lev: 1, openedAt: '2026-03-14T09:57:44Z', closedAt: '2026-03-14T23:40:05Z' },
  { asset: 'OP', dir: 'long', avgPrice: 0.122, exitPrice: 0.1234, pnl: 0.10, closedPnl: 0.11, fee: 0.01207368, lev: 3, openedAt: '2026-03-14T16:42:35Z', closedAt: '2026-03-14T21:45:21Z' },
  { asset: 'LINK', dir: 'long', avgPrice: 8.968, exitPrice: 8.914, pnl: -0.07, closedPnl: -0.05, fee: 0.01180212, lev: 3, openedAt: '2026-03-14T16:42:35Z', closedAt: '2026-03-14T19:48:04Z' },
  { asset: 'ARB', dir: 'long', avgPrice: 0.1024, exitPrice: 0.1011, pnl: -0.13, closedPnl: -0.12, fee: 0.01196580, lev: 1, openedAt: '2026-03-14T11:44:42Z', closedAt: '2026-03-14T16:24:01Z' },
  { asset: 'ADA', dir: 'long', avgPrice: 0.2643, exitPrice: 0.2626, pnl: -0.20, closedPnl: -0.17, fee: 0.03161400, lev: 1, openedAt: '2026-03-14T10:21:27Z', closedAt: '2026-03-14T11:38:28Z' },
  { asset: 'DOT', dir: 'short', avgPrice: 1.457, exitPrice: 1.445, pnl: 0.07, closedPnl: 0.08, fee: 0.01218840, lev: 1, openedAt: '2026-03-14T10:06:22Z', closedAt: '2026-03-14T11:36:19Z' },
  { asset: 'SUI', dir: 'long', avgPrice: 0.9938, exitPrice: 0.9941, pnl: -0.00, closedPnl: 0.00, fee: 0.01192740, lev: 3, openedAt: '2026-03-14T09:38:40Z', closedAt: null },
  // Page 2 — Mar 16-19
  { asset: 'BTC', dir: 'short', avgPrice: 71015.2, exitPrice: 71819.3, pnl: -0.17, closedPnl: -0.16, fee: 0.01714014, lev: 1, openedAt: '2026-03-19T01:14:09Z', closedAt: '2026-03-19T04:00:22Z' },
  { asset: 'INJ', dir: 'short', avgPrice: 3.037, exitPrice: 3.075, pnl: -0.16, closedPnl: -0.15, fee: 0.01466880, lev: 3, openedAt: '2026-03-19T03:04:08Z', closedAt: '2026-03-19T04:00:21Z' },
  { asset: 'DOGE', dir: 'short', avgPrice: 0.09576, exitPrice: 0.09328, pnl: 0.30, closedPnl: 0.32, fee: 0.01474512, lev: 1, openedAt: '2026-03-18T23:44:09Z', closedAt: '2026-03-19T03:06:18Z' },
  { asset: 'RENDER', dir: 'short', avgPrice: 1.749, exitPrice: 1.696, pnl: 0.69, closedPnl: 0.72, fee: 0.02832582, lev: 3, openedAt: '2026-03-18T22:34:08Z', closedAt: '2026-03-19T02:35:06Z' },
  { asset: 'OP', dir: 'short', avgPrice: 0.1298, exitPrice: 0.1268, pnl: 0.77, closedPnl: 0.81, fee: 0.04250952, lev: 3, openedAt: '2026-03-18T22:34:08Z', closedAt: '2026-03-19T00:53:42Z' },
  { asset: 'SOL', dir: 'long', avgPrice: 93.99, exitPrice: 91.04, pnl: -0.64, closedPnl: -0.61, fee: 0.02331378, lev: 2, openedAt: '2026-03-16T15:27:56Z', closedAt: '2026-03-18T22:31:27Z' },
  { asset: 'SUI', dir: 'long', avgPrice: 1.036, exitPrice: 1.0485, pnl: 0.11, closedPnl: 0.12, fee: 0.01250700, lev: 1, openedAt: '2026-03-18T14:42:26Z', closedAt: '2026-03-18T15:12:21Z' },
  { asset: 'DOT', dir: 'long', avgPrice: 1.619, exitPrice: 1.592, pnl: -0.41, closedPnl: -0.39, fee: 0.02736774, lev: 1, openedAt: '2026-03-17T11:03:03Z', closedAt: '2026-03-17T22:37:01Z' },
  { asset: 'PEPE', dir: 'long', avgPrice: 0.000003928, exitPrice: 0.000003845, pnl: -0.13, closedPnl: -0.12, fee: 0.00699570, lev: 2, openedAt: '2026-03-16T21:41:23Z', closedAt: '2026-03-17T14:33:53Z' },
  { asset: 'INJ', dir: 'long', avgPrice: 3.293, exitPrice: 3.252, pnl: -0.06, closedPnl: -0.06, fee: 0.00589050, lev: 1, openedAt: '2026-03-17T11:43:03Z', closedAt: '2026-03-17T13:36:07Z' },
  { asset: 'RENDER', dir: 'long', avgPrice: 1.924, exitPrice: 1.88, pnl: -0.12, closedPnl: -0.11, fee: 0.00593424, lev: 1, openedAt: '2026-03-17T11:53:04Z', closedAt: '2026-03-17T13:35:43Z' },
  { asset: 'OP', dir: 'long', avgPrice: 0.1363, exitPrice: 0.1344, pnl: -0.07, closedPnl: -0.07, fee: 0.00600954, lev: 1, openedAt: '2026-03-17T11:43:03Z', closedAt: '2026-03-17T13:34:29Z' },
  { asset: 'DOT', dir: 'long', avgPrice: 1.582, exitPrice: 1.578, pnl: -0.04, closedPnl: -0.03, fee: 0.01555644, lev: 1, openedAt: '2026-03-16T23:53:27Z', closedAt: '2026-03-17T04:09:43Z' },
  { asset: 'ARB', dir: 'long', avgPrice: 0.1071, exitPrice: 0.1093, pnl: 0.15, closedPnl: 0.16, fee: 0.00973800, lev: 1, openedAt: '2026-03-17T00:43:28Z', closedAt: '2026-03-17T04:09:22Z' },
  { asset: 'ETH', dir: 'long', avgPrice: 2280.35, exitPrice: 2285.79, pnl: 0.01, closedPnl: 0.02, fee: 0.01095874, lev: 1, openedAt: '2026-03-16T22:52:31Z', closedAt: '2026-03-17T03:46:29Z' },
  { asset: 'ADA', dir: 'long', avgPrice: 0.2851, exitPrice: 0.2851, pnl: -0.01, closedPnl: 0.00, fee: 0.01095096, lev: 1, openedAt: '2026-03-16T21:41:23Z', closedAt: '2026-03-17T00:30:38Z' },
  { asset: 'INJ', dir: 'long', avgPrice: 3.171, exitPrice: 3.211, pnl: 0.11, closedPnl: 0.12, fee: 0.01225440, lev: 1, openedAt: '2026-03-16T20:40:49Z', closedAt: '2026-03-16T23:40:13Z' },
  { asset: 'SUI', dir: 'long', avgPrice: 0.9941, exitPrice: 1.0632, pnl: 0.67, closedPnl: 0.69, fee: 0.01234380, lev: 3, openedAt: '2026-03-14T09:38:40Z', closedAt: '2026-03-16T15:47:07Z' },
  { asset: 'APT', dir: 'short', avgPrice: 0.9265, exitPrice: 0.9480, pnl: -0.49, closedPnl: -0.46, fee: 0.02451972, lev: 1, openedAt: '2026-03-14T10:26:17Z', closedAt: '2026-03-16T13:34:14Z' },
  { asset: 'BTC', dir: 'long', avgPrice: 70929, exitPrice: 73198.5, pnl: 0.21, closedPnl: 0.22, fee: 0.00864765, lev: 1, openedAt: '2026-03-14T10:26:17Z', closedAt: null },
  // Page 3 — Mar 19-20
  { asset: 'LINK', dir: 'short', avgPrice: 8.947, exitPrice: 9.043, pnl: -0.27, closedPnl: -0.25, fee: 0.02806512, lev: 3, openedAt: '2026-03-19T22:51:06Z', closedAt: '2026-03-20T05:06:38Z' },
  { asset: 'APT', dir: 'short', avgPrice: 0.923, exitPrice: 0.941, pnl: -0.24, closedPnl: -0.23, fee: 0.01453920, lev: 3, openedAt: '2026-03-20T01:21:06Z', closedAt: '2026-03-20T03:20:11Z' },
  { asset: 'SUI', dir: 'short', avgPrice: 0.9659, exitPrice: 0.9584, pnl: 0.43, closedPnl: 0.51, fee: 0.07851372, lev: 1, openedAt: '2026-03-18T22:44:09Z', closedAt: '2026-03-20T00:01:00Z' },
  { asset: 'ADA', dir: 'short', avgPrice: 0.2637, exitPrice: 0.2668, pnl: -0.15, closedPnl: -0.13, fee: 0.01432350, lev: 1, openedAt: '2026-03-19T23:41:07Z', closedAt: '2026-03-19T23:49:58Z' },
  { asset: 'OP', dir: 'short', avgPrice: 0.1224, exitPrice: 0.1201, pnl: 0.21, closedPnl: 0.22, fee: 0.01425900, lev: 3, openedAt: '2026-03-19T20:11:07Z', closedAt: '2026-03-19T23:13:24Z' },
  { asset: 'ARB', dir: 'short', avgPrice: 0.0996, exitPrice: 0.0986, pnl: 0.14, closedPnl: 0.16, fee: 0.01916490, lev: 1, openedAt: '2026-03-19T22:11:07Z', closedAt: '2026-03-19T23:13:15Z' },
  { asset: 'NEAR', dir: 'short', avgPrice: 1.345, exitPrice: 1.333, pnl: 0.09, closedPnl: 0.10, fee: 0.01446120, lev: 1, openedAt: '2026-03-19T22:41:06Z', closedAt: '2026-03-19T23:02:18Z' },
  { asset: 'ADA', dir: 'short', avgPrice: 0.2691, exitPrice: 0.265, pnl: 0.17, closedPnl: 0.18, fee: 0.01442070, lev: 1, openedAt: '2026-03-19T17:12:09Z', closedAt: '2026-03-19T22:52:50Z' },
  { asset: 'WIF', dir: 'short', avgPrice: 0.1762, exitPrice: 0.1723, pnl: 0.16, closedPnl: 0.17, fee: 0.00940950, lev: 1, openedAt: '2026-03-19T17:12:09Z', closedAt: '2026-03-19T22:51:34Z' },
  { asset: 'PEPE', dir: 'short', avgPrice: 0.000003392, exitPrice: 0.000003356, pnl: 0.07, closedPnl: 0.08, fee: 0.00971712, lev: 1, openedAt: '2026-03-19T22:11:07Z', closedAt: '2026-03-19T22:11:23Z' },
  { asset: 'PEPE', dir: 'short', avgPrice: 0.000003550, exitPrice: 0.000003447, pnl: 1.61, closedPnl: 1.68, fee: 0.06844056, lev: 3, openedAt: '2026-03-18T21:33:48Z', closedAt: '2026-03-19T22:10:19Z' },
  { asset: 'RENDER', dir: 'short', avgPrice: 1.687, exitPrice: 1.661, pnl: 0.22, closedPnl: 0.24, fee: 0.01888272, lev: 1, openedAt: '2026-03-19T17:22:09Z', closedAt: '2026-03-19T21:37:30Z' },
  { asset: 'INJ', dir: 'short', avgPrice: 3.01, exitPrice: 3.033, pnl: -0.10, closedPnl: -0.09, fee: 0.01450320, lev: 3, openedAt: '2026-03-19T17:12:09Z', closedAt: '2026-03-19T19:40:53Z' },
  { asset: 'BTC', dir: 'short', avgPrice: 70147.5, exitPrice: 69535.4, pnl: 0.05, closedPnl: 0.06, fee: 0.00838097, lev: 1, openedAt: '2026-03-19T17:12:10Z', closedAt: '2026-03-19T17:22:55Z' },
  { asset: 'ARB', dir: 'short', avgPrice: 0.1023, exitPrice: 0.1029, pnl: -0.13, closedPnl: -0.11, fee: 0.02167542, lev: 1, openedAt: '2026-03-19T06:43:45Z', closedAt: '2026-03-19T17:11:26Z' },
  { asset: 'INJ', dir: 'short', avgPrice: 3.048, exitPrice: 3.069, pnl: -0.06, closedPnl: -0.05, fee: 0.00954252, lev: 1, openedAt: '2026-03-19T12:12:07Z', closedAt: '2026-03-19T13:17:40Z' },
  { asset: 'OP', dir: 'short', avgPrice: 0.125, exitPrice: 0.126, pnl: -0.07, closedPnl: -0.06, fee: 0.00963840, lev: 1, openedAt: '2026-03-19T12:02:08Z', closedAt: '2026-03-19T13:15:29Z' },
  { asset: 'WIF', dir: 'short', avgPrice: 0.1778, exitPrice: 0.1787, pnl: -0.21, closedPnl: -0.16, fee: 0.04321872, lev: 3, openedAt: '2026-03-18T21:43:47Z', closedAt: '2026-03-19T07:55:12Z' },
  { asset: 'DOGE', dir: 'short', avgPrice: 0.09432, exitPrice: 0.09559, pnl: -0.06, closedPnl: -0.06, fee: 0.00569730, lev: 1, openedAt: '2026-03-19T06:13:44Z', closedAt: '2026-03-19T07:40:43Z' },
  { asset: 'OP', dir: 'short', avgPrice: 0.1254, exitPrice: 0.1273, pnl: -0.19, closedPnl: -0.18, fee: 0.01455552, lev: 3, openedAt: '2026-03-18T22:34:08Z', closedAt: null },
  // Page 4 — Mar 20-21
  { asset: 'PEPE', dir: 'short', avgPrice: 0.000003417, exitPrice: 0.000003422, pnl: -0.04, closedPnl: -0.02, fee: 0.02215548, lev: 1, openedAt: '2026-03-20T20:37:33Z', closedAt: null },
  { asset: 'ARB', dir: 'short', avgPrice: 0.0996, exitPrice: 0.0997, pnl: -0.03, closedPnl: -0.01, fee: 0.01926246, lev: 1, openedAt: '2026-03-20T23:51:06Z', closedAt: '2026-03-21T08:04:49Z' },
  { asset: 'LINK', dir: 'short', avgPrice: 9.031, exitPrice: 9.139, pnl: -0.21, closedPnl: -0.19, fee: 0.01962414, lev: 3, openedAt: '2026-03-20T23:41:06Z', closedAt: '2026-03-21T08:04:46Z' },
  { asset: 'DOGE', dir: 'short', avgPrice: 0.09330, exitPrice: 0.09437, pnl: -0.21, closedPnl: -0.19, fee: 0.02026944, lev: 1, openedAt: '2026-03-20T23:41:06Z', closedAt: '2026-03-21T08:02:53Z' },
  { asset: 'AVAX', dir: 'short', avgPrice: 9.463, exitPrice: 9.562, pnl: -0.08, closedPnl: -0.07, fee: 0.00913200, lev: 3, openedAt: '2026-03-20T23:41:06Z', closedAt: '2026-03-21T07:18:57Z' },
  { asset: 'XRP', dir: 'short', avgPrice: 1.43, exitPrice: 1.4445, pnl: -0.09, closedPnl: -0.08, fee: 0.01034820, lev: 1, openedAt: '2026-03-21T01:11:05Z', closedAt: '2026-03-21T07:18:49Z' },
  { asset: 'ADA', dir: 'short', avgPrice: 0.2625, exitPrice: 0.2652, pnl: -0.13, closedPnl: -0.12, fee: 0.01456452, lev: 3, openedAt: '2026-03-21T05:41:05Z', closedAt: '2026-03-21T07:18:47Z' },
  { asset: 'SUI', dir: 'short', avgPrice: 0.9525, exitPrice: 0.9618, pnl: -0.08, closedPnl: -0.07, fee: 0.00918864, lev: 1, openedAt: '2026-03-21T05:41:05Z', closedAt: '2026-03-21T07:18:28Z' },
  { asset: 'ADA', dir: 'short', avgPrice: 0.2662, exitPrice: 0.2632, pnl: 0.08, closedPnl: 0.09, fee: 0.00952920, lev: 1, openedAt: '2026-03-20T23:41:06Z', closedAt: '2026-03-21T04:37:34Z' },
  { asset: 'APT', dir: 'long', avgPrice: 1.018, exitPrice: 0.993, pnl: -0.30, closedPnl: -0.29, fee: 0.01423788, lev: 3, openedAt: '2026-03-21T00:11:06Z', closedAt: '2026-03-21T00:50:32Z' },
  { asset: 'INJ', dir: 'long', avgPrice: 3.205, exitPrice: 3.145, pnl: -0.23, closedPnl: -0.22, fee: 0.01409700, lev: 3, openedAt: '2026-03-20T14:11:44Z', closedAt: '2026-03-20T16:59:57Z' },
  { asset: 'PEPE', dir: 'short', avgPrice: 0.000003404, exitPrice: 0.00000347, pnl: -0.16, closedPnl: -0.15, fee: 0.00989856, lev: 1, openedAt: '2026-03-19T22:41:06Z', closedAt: '2026-03-20T15:20:07Z' },
  { asset: 'WIF', dir: 'short', avgPrice: 0.1726, exitPrice: 0.1768, pnl: -0.20, closedPnl: -0.19, fee: 0.00964344, lev: 1, openedAt: '2026-03-20T00:41:06Z', closedAt: '2026-03-20T15:03:09Z' },
  { asset: 'INJ', dir: 'long', avgPrice: 3.124, exitPrice: 3.172, pnl: 0.11, closedPnl: 0.12, fee: 0.00982176, lev: 1, openedAt: '2026-03-20T12:17:06Z', closedAt: '2026-03-20T13:10:35Z' },
  { asset: 'DOGE', dir: 'short', avgPrice: 0.09292, exitPrice: 0.09418, pnl: -0.12, closedPnl: -0.11, fee: 0.01010340, lev: 1, openedAt: '2026-03-20T00:41:06Z', closedAt: '2026-03-20T11:01:37Z' },
  { asset: 'OP', dir: 'short', avgPrice: 0.1204, exitPrice: 0.122, pnl: -0.17, closedPnl: -0.16, fee: 0.01454400, lev: 3, openedAt: '2026-03-20T00:11:06Z', closedAt: '2026-03-20T10:50:06Z' },
  { asset: 'BNB', dir: 'short', avgPrice: 635.98, exitPrice: 642.62, pnl: -0.07, closedPnl: -0.06, fee: 0.00767160, lev: 1, openedAt: '2026-03-20T01:21:06Z', closedAt: '2026-03-20T06:40:11Z' },
  { asset: 'DOT', dir: 'short', avgPrice: 1.515, exitPrice: 1.534, pnl: -0.16, closedPnl: -0.15, fee: 0.01445226, lev: 3, openedAt: '2026-03-19T23:11:07Z', closedAt: '2026-03-20T05:19:59Z' },
  { asset: 'AVAX', dir: 'short', avgPrice: 9.415, exitPrice: 9.526, pnl: -0.51, closedPnl: -0.46, fee: 0.04773402, lev: 3, openedAt: '2026-03-19T23:11:07Z', closedAt: '2026-03-20T05:12:01Z' },
  { asset: 'NEAR', dir: 'short', avgPrice: 1.329, exitPrice: 1.343, pnl: -0.14, closedPnl: -0.12, fee: 0.01442880, lev: 3, openedAt: '2026-03-19T23:11:07Z', closedAt: null },
];

async function main() {
  console.log('=== BLOFIN TRADE RECONCILIATION ===\n');

  // Step 1: Ensure columns exist
  console.log('Step 1: Adding reconciliation columns...');
  const alterStatements = [
    `ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS entry_price_real DECIMAL`,
    `ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS exit_price_real DECIMAL`,
    `ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS trading_fee_real DECIMAL`,
    `ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS blofin_pnl_usd DECIMAL`,
    `ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS engine_source VARCHAR(30)`,
    `ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS data_source VARCHAR(20) DEFAULT 'signal_log'`,
    `ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS exit_reason VARCHAR(20)`,
  ];
  for (const sql of alterStatements) {
    try { await pool.query(sql); } catch (e) { /* column may already exist */ }
  }
  console.log('  Columns ready.\n');

  // Step 2: Process each BloFin trade
  console.log('Step 2: Matching BloFin trades to DB records...\n');

  let matched = 0, created = 0, noMatch = 0;
  const results = [];

  for (const trade of MANUAL_BLOFIN_TRADES) {
    const openedAt = new Date(trade.openedAt);
    const closedAt = trade.closedAt ? new Date(trade.closedAt) : null;
    const realOutcome = trade.closedPnl > 0 ? 'win' : trade.closedPnl < 0 ? 'loss' : 'breakeven';
    const hoursOpen = closedAt ? ((closedAt - openedAt) / 3600000).toFixed(2) : null;

    // Calculate real PnL %
    const priceDiffPct = trade.dir === 'long'
      ? ((trade.exitPrice - trade.avgPrice) / trade.avgPrice) * 100
      : ((trade.avgPrice - trade.exitPrice) / trade.avgPrice) * 100;
    const leveragedPnlPct = priceDiffPct * trade.lev;

    // Try to match: asset + direction + opened within ±30 min window
    const matchResult = await pool.query(
      `SELECT id, asset, direction, entry_price, outcome, pnl, created_at, executed
       FROM best_trades_log
       WHERE asset = $1 AND direction = $2
       AND ABS(EXTRACT(EPOCH FROM (created_at - $3::timestamp))) < 1800
       ORDER BY ABS(EXTRACT(EPOCH FROM (created_at - $3::timestamp))) ASC
       LIMIT 1`,
      [trade.asset, trade.dir, openedAt]
    );

    if (matchResult.rows.length > 0) {
      const row = matchResult.rows[0];
      const slippagePct = row.entry_price ?
        (Math.abs(trade.avgPrice - parseFloat(row.entry_price)) / parseFloat(row.entry_price) * 100).toFixed(4) : null;

      // Update with real data
      await pool.query(
        `UPDATE best_trades_log SET
          executed = true,
          entry_price_real = $2,
          exit_price_real = $3,
          trading_fee_real = $4,
          blofin_pnl_usd = $5,
          data_source = 'signal_matched',
          engine_source = COALESCE(engine_source, 'best_trades_auto')
         WHERE id = $1`,
        [row.id, trade.avgPrice, trade.exitPrice, trade.fee, trade.pnl]
      );

      // If paper outcome differs from real, log it
      const paperOutcome = row.outcome;
      const divergent = paperOutcome && paperOutcome !== realOutcome && realOutcome !== 'breakeven';

      results.push({
        id: row.id,
        asset: trade.asset,
        direction: trade.dir,
        leverage: trade.lev,
        signalPrice: parseFloat(row.entry_price),
        realEntryPrice: trade.avgPrice,
        realExitPrice: trade.exitPrice,
        slippagePct,
        paperOutcome,
        realOutcome,
        divergent: divergent ? 'YES' : '',
        paperPnlPct: row.pnl ? parseFloat(row.pnl) : null,
        realPnlPct: parseFloat(leveragedPnlPct.toFixed(4)),
        realPnlUsd: trade.pnl,
        closedPnlUsd: trade.closedPnl,
        feeUsd: trade.fee,
        hoursOpen,
        openedAt: trade.openedAt,
        closedAt: trade.closedAt,
        matchType: 'signal_matched',
      });

      matched++;
      console.log(`  ✅ MATCHED: ${trade.asset} ${trade.dir} @ ${trade.openedAt} → DB #${row.id} | Paper: ${paperOutcome || 'pending'} | Real: ${realOutcome} ${divergent ? '⚠️ DIVERGENT' : ''} | Slippage: ${slippagePct}%`);
    } else {
      // No match — create new record
      try {
        const insertResult = await pool.query(
          `INSERT INTO best_trades_log
           (asset, direction, probability, entry_price, entry_price_real, exit_price_real,
            trading_fee_real, blofin_pnl_usd, executed, outcome, pnl,
            data_source, engine_source, created_at, resolved_at,
            hours_to_resolution, exit_reason, regime, timeframe)
           VALUES ($1, $2, 0, $3, $3, $4, $5, $6, true, $7, $8,
                   'blofin_only', 'unknown', $9, $10, $11, $12, 'unknown', '15m')
           RETURNING id`,
          [trade.asset, trade.dir, trade.avgPrice, trade.exitPrice,
           trade.fee, trade.pnl, realOutcome, parseFloat(leveragedPnlPct.toFixed(4)),
           openedAt, closedAt, hoursOpen,
           realOutcome === 'win' ? 'tp_hit' : 'sl_hit']
        );

        results.push({
          id: insertResult.rows[0]?.id || 'new',
          asset: trade.asset,
          direction: trade.dir,
          leverage: trade.lev,
          signalPrice: null,
          realEntryPrice: trade.avgPrice,
          realExitPrice: trade.exitPrice,
          slippagePct: 'N/A',
          paperOutcome: 'N/A',
          realOutcome,
          divergent: '',
          paperPnlPct: null,
          realPnlPct: parseFloat(leveragedPnlPct.toFixed(4)),
          realPnlUsd: trade.pnl,
          closedPnlUsd: trade.closedPnl,
          feeUsd: trade.fee,
          hoursOpen,
          openedAt: trade.openedAt,
          closedAt: trade.closedAt,
          matchType: 'blofin_only',
        });

        created++;
        console.log(`  ➕ CREATED: ${trade.asset} ${trade.dir} @ ${trade.openedAt} — no DB signal found (${realOutcome}, $${trade.pnl})`);
      } catch (e) {
        noMatch++;
        console.log(`  ❌ FAILED: ${trade.asset} ${trade.dir} @ ${trade.openedAt} — ${e.message}`);
      }
    }
  }

  console.log(`\n=== RECONCILIATION SUMMARY ===`);
  console.log(`Total BloFin trades: ${MANUAL_BLOFIN_TRADES.length}`);
  console.log(`Matched to DB signals: ${matched}`);
  console.log(`Created (no DB match): ${created}`);
  console.log(`Failed: ${noMatch}`);

  // Divergence analysis
  const divergent = results.filter(r => r.divergent === 'YES');
  console.log(`\nPaper vs Real Divergence: ${divergent.length} trades`);
  for (const d of divergent) {
    console.log(`  ${d.asset} ${d.direction}: Paper=${d.paperOutcome} Real=${d.realOutcome} | Signal=$${d.signalPrice} Fill=$${d.realEntryPrice} Slip=${d.slippagePct}%`);
  }

  // Real performance summary
  const closedResults = results.filter(r => r.closedAt);
  const wins = closedResults.filter(r => r.realOutcome === 'win');
  const losses = closedResults.filter(r => r.realOutcome === 'loss');
  const totalPnl = closedResults.reduce((s, r) => s + (r.realPnlUsd || 0), 0);
  const totalFees = closedResults.reduce((s, r) => s + (r.feeUsd || 0), 0);

  console.log(`\n=== REAL PERFORMANCE ===`);
  console.log(`Trades: ${closedResults.length} (${wins.length}W / ${losses.length}L)`);
  console.log(`Win Rate: ${(wins.length / closedResults.length * 100).toFixed(1)}%`);
  console.log(`Total PnL: $${totalPnl.toFixed(2)}`);
  console.log(`Total Fees: $${totalFees.toFixed(4)}`);
  console.log(`Net PnL: $${(totalPnl - totalFees).toFixed(2)}`);

  // Avg slippage
  const slippages = results.filter(r => r.slippagePct && r.slippagePct !== 'N/A').map(r => parseFloat(r.slippagePct));
  if (slippages.length > 0) {
    const avgSlip = slippages.reduce((s, v) => s + v, 0) / slippages.length;
    console.log(`\nAvg Entry Slippage: ${avgSlip.toFixed(4)}% (${slippages.length} matched trades)`);
  }

  // Step 3: Export REAL_TRADES_ONLY.csv
  console.log('\nStep 3: Exporting REAL_TRADES_ONLY.csv...');
  const headers = ['db_id','asset','direction','leverage','match_type','signal_price','real_entry_price','real_exit_price',
    'slippage_pct','paper_outcome','real_outcome','divergent','paper_pnl_pct','real_pnl_pct','real_pnl_usd','closed_pnl_usd',
    'fee_usd','hours_open','opened_at','closed_at'];
  const csvRows = [headers.join(',')];
  for (const r of results) {
    csvRows.push(headers.map(h => {
      const key = h.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      const val = r[key] ?? r[h] ?? '';
      return typeof val === 'string' && val.includes(',') ? `"${val}"` : val;
    }).join(','));
  }
  fs.writeFileSync('REAL_TRADES_ONLY.csv', csvRows.join('\n'));
  console.log(`  Saved ${results.length} trades to REAL_TRADES_ONLY.csv`);

  // Step 4: Re-export full trade log
  console.log('\nStep 4: Exporting updated FULL_TRADE_LOG.csv...');
  const allTrades = await pool.query(
    `SELECT *,
      CASE WHEN data_source = 'signal_matched' THEN 'REAL+SIGNAL'
           WHEN data_source = 'blofin_only' THEN 'REAL_ONLY'
           ELSE 'PAPER'
      END as trade_type
     FROM best_trades_log ORDER BY created_at DESC`
  );

  if (allTrades.rows.length > 0) {
    const allHeaders = Object.keys(allTrades.rows[0]);
    const allCsv = [allHeaders.join(',')];
    for (const row of allTrades.rows) {
      allCsv.push(allHeaders.map(h => {
        let val = row[h];
        if (val === null || val === undefined) return '';
        if (typeof val === 'object') val = JSON.stringify(val);
        val = String(val);
        return val.includes(',') || val.includes('"') || val.includes('\n') ? `"${val.replace(/"/g, '""')}"` : val;
      }).join(','));
    }
    fs.writeFileSync('FULL_TRADE_LOG.csv', allCsv.join('\n'));
    console.log(`  Saved ${allTrades.rows.length} trades to FULL_TRADE_LOG.csv`);
  }

  console.log('\nDone.');
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
