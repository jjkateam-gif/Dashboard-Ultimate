const { pool } = require('../db');
const fetch = require('node-fetch');

let resolveInterval = null;

// CoinGecko ID mapping for price lookups
const COINGECKO_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  SUI: 'sui',
  BNB: 'binancecoin',
  DOGE: 'dogecoin',
  XRP: 'ripple',
  ADA: 'cardano',
  AVAX: 'avalanche-2',
  LINK: 'chainlink',
  DOT: 'polkadot',
  MATIC: 'matic-network',
  NEAR: 'near',
  ARB: 'arbitrum',
  OP: 'optimism',
  APT: 'aptos',
  INJ: 'injective-protocol',
  PEPE: 'pepe',
  BONK: 'bonk',
  WIF: 'dogwifcoin',
  RENDER: 'render-token',
};

// Batch fetch prices from CoinGecko (single API call for all symbols)
async function fetchPricesBatch(symbols) {
  const ids = [...new Set(symbols.map(s => COINGECKO_IDS[s]).filter(Boolean))];
  if (ids.length === 0) return {};
  try {
    const resp = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`);
    if (!resp.ok) return {};
    const data = await resp.json();
    const prices = {};
    for (const [sym, cgId] of Object.entries(COINGECKO_IDS)) {
      if (data[cgId]?.usd) prices[sym] = data[cgId].usd;
    }
    return prices;
  } catch (e) {
    console.error('[RecTracker] Batch price fetch error:', e.message);
    return {};
  }
}

async function saveRecommendation(userId, rec) {
  const { symbol, direction, probability, entryPrice, targetPrice, stopPrice, rrRatio,
          source, timeframe, confidence, leverage, mode } = rec;
  const srcVal = source || 'auto';

  // For auto-saves: skip if same symbol+direction+timeframe was already saved within 1 hour (prevents flooding)
  if (srcVal === 'auto') {
    const { rows: existing } = await pool.query(
      `SELECT id FROM trade_recommendations
       WHERE user_id = $1 AND symbol = $2 AND direction = $3
         AND source = 'auto' AND outcome IS NULL
         AND created_at > NOW() - INTERVAL '1 hour'
       LIMIT 1`,
      [userId, symbol, direction.toUpperCase()]
    );
    if (existing.length > 0) {
      return { id: existing[0].id, deduplicated: true };
    }
  }

  const result = await pool.query(
    `INSERT INTO trade_recommendations (user_id, symbol, direction, probability, entry_price, target_price, stop_price, rr_ratio, source, timeframe, confidence, leverage, mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [userId, symbol, direction.toUpperCase(), probability, entryPrice, targetPrice, stopPrice, rrRatio,
     srcVal, timeframe || null, confidence || null, leverage || 1, mode || 'spot']
  );
  return result.rows[0];
}

async function resolveRecommendations() {
  try {
    const { rows: unresolved } = await pool.query(
      `SELECT id, symbol, direction, entry_price, target_price, stop_price, created_at
       FROM trade_recommendations WHERE outcome IS NULL`
    );

    if (unresolved.length === 0) return;

    // Batch fetch all prices in a single API call
    const symbols = [...new Set(unresolved.map(r => r.symbol.replace(/[-\/]?USDT$/i, '').toUpperCase()))];
    const prices = await fetchPricesBatch(symbols);

    const now = new Date();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

    for (const rec of unresolved) {
      const clean = rec.symbol.replace(/[-\/]?USDT$/i, '').toUpperCase();
      const currentPrice = prices[clean];
      if (currentPrice == null) continue; // skip if we couldn't get price

      const entry = parseFloat(rec.entry_price);
      const target = parseFloat(rec.target_price);
      const stop = parseFloat(rec.stop_price);
      const isLong = rec.direction === 'LONG';
      const age = now - new Date(rec.created_at);

      let outcome = null;
      let pnlPct = null;

      if (isLong) {
        if (currentPrice >= target) {
          outcome = 'win';
          pnlPct = ((target - entry) / entry * 100);
        } else if (currentPrice <= stop) {
          outcome = 'loss';
          pnlPct = ((stop - entry) / entry * 100);
        }
      } else {
        // SHORT
        if (currentPrice <= target) {
          outcome = 'win';
          pnlPct = ((entry - target) / entry * 100);
        } else if (currentPrice >= stop) {
          outcome = 'loss';
          pnlPct = ((entry - stop) / entry * 100); // negative since stop > entry for shorts
        }
      }

      // Expire if older than 24 hours and still unresolved
      if (!outcome && age > TWENTY_FOUR_HOURS) {
        outcome = 'expired';
        pnlPct = ((currentPrice - entry) / entry * 100);
        if (!isLong) pnlPct = -pnlPct;
      }

      if (outcome) {
        await pool.query(
          `UPDATE trade_recommendations SET outcome = $1, resolved_at = NOW(), actual_pnl_pct = $2 WHERE id = $3`,
          [outcome, parseFloat(pnlPct.toFixed(2)), rec.id]
        );
      }
    }

    console.log(`[RecommendationTracker] Resolved check complete. ${unresolved.length} pending recs checked.`);
  } catch (err) {
    console.error('[RecommendationTracker] resolveRecommendations error:', err.message);
  }
}

async function getHistory(userId, limit = 50, source = null) {
  let query = `SELECT id, symbol, direction, probability, entry_price, target_price, stop_price, rr_ratio,
                      created_at, resolved_at, outcome, actual_pnl_pct, source, timeframe, confidence, leverage, mode
               FROM trade_recommendations
               WHERE user_id = $1`;
  const params = [userId];

  if (source) {
    query += ` AND source = $${params.length + 1}`;
    params.push(source);
  }

  query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const { rows } = await pool.query(query, params);
  return rows;
}

async function getSummary(userId, source = null) {
  let whereClause = 'WHERE user_id = $1';
  const params = [userId];

  if (source) {
    whereClause += ` AND source = $${params.length + 1}`;
    params.push(source);
  }

  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE outcome = 'win')::int AS wins,
       COUNT(*) FILTER (WHERE outcome = 'loss')::int AS losses,
       COUNT(*) FILTER (WHERE outcome = 'expired')::int AS expired,
       COUNT(*) FILTER (WHERE outcome IS NULL)::int AS pending,
       ROUND(AVG(actual_pnl_pct) FILTER (WHERE outcome IN ('win','loss')), 2) AS "avgPnl",
       ROUND(
         CASE WHEN COUNT(*) FILTER (WHERE outcome IN ('win','loss')) > 0
              THEN COUNT(*) FILTER (WHERE outcome = 'win')::numeric / COUNT(*) FILTER (WHERE outcome IN ('win','loss')) * 100
              ELSE NULL END, 1
       ) AS "winRate"
     FROM trade_recommendations
     ${whereClause}`,
    params
  );

  const summary = rows[0] || {};

  // Calculate current streak
  let streakQuery = `SELECT outcome FROM trade_recommendations
     WHERE user_id = $1 AND outcome IN ('win','loss')`;
  const streakParams = [userId];

  if (source) {
    streakQuery += ` AND source = $${streakParams.length + 1}`;
    streakParams.push(source);
  }

  streakQuery += ` ORDER BY resolved_at DESC LIMIT 20`;

  const { rows: streakRows } = await pool.query(streakQuery, streakParams);

  let streak = 0;
  let streakType = null;
  for (const r of streakRows) {
    if (streakType === null) {
      streakType = r.outcome;
      streak = 1;
    } else if (r.outcome === streakType) {
      streak++;
    } else {
      break;
    }
  }

  // Timeframe breakdown — win rate + avg P&L per timeframe
  let tfQuery = `SELECT timeframe,
       COUNT(*) FILTER (WHERE outcome IN ('win','loss'))::int AS resolved,
       COUNT(*) FILTER (WHERE outcome = 'win')::int AS wins,
       ROUND(AVG(actual_pnl_pct) FILTER (WHERE outcome IN ('win','loss')), 2) AS "avgPnl",
       ROUND(
         CASE WHEN COUNT(*) FILTER (WHERE outcome IN ('win','loss')) > 0
              THEN COUNT(*) FILTER (WHERE outcome = 'win')::numeric / COUNT(*) FILTER (WHERE outcome IN ('win','loss')) * 100
              ELSE NULL END, 1
       ) AS "winRate"
     FROM trade_recommendations
     ${whereClause} AND timeframe IS NOT NULL
     GROUP BY timeframe
     ORDER BY "winRate" DESC NULLS LAST`;
  const { rows: tfRows } = await pool.query(tfQuery, params);

  // Probability bucket breakdown — calibration data
  let probQuery = `SELECT
       CASE
         WHEN probability < 35 THEN '30-34'
         WHEN probability < 40 THEN '35-39'
         WHEN probability < 45 THEN '40-44'
         WHEN probability < 50 THEN '45-49'
         WHEN probability < 55 THEN '50-54'
         WHEN probability < 60 THEN '55-59'
         WHEN probability < 65 THEN '60-64'
         WHEN probability < 70 THEN '65-69'
         WHEN probability < 75 THEN '70-74'
         WHEN probability < 80 THEN '75-79'
         ELSE '80+'
       END AS bucket,
       CASE
         WHEN probability < 35 THEN 32
         WHEN probability < 40 THEN 37
         WHEN probability < 45 THEN 42
         WHEN probability < 50 THEN 47
         WHEN probability < 55 THEN 52
         WHEN probability < 60 THEN 57
         WHEN probability < 65 THEN 62
         WHEN probability < 70 THEN 67
         WHEN probability < 75 THEN 72
         WHEN probability < 80 THEN 77
         ELSE 82
       END AS "bucketMid",
       COUNT(*) FILTER (WHERE outcome IN ('win','loss'))::int AS total,
       COUNT(*) FILTER (WHERE outcome = 'win')::int AS wins
     FROM trade_recommendations
     ${whereClause} AND probability IS NOT NULL AND outcome IN ('win','loss')
     GROUP BY bucket, "bucketMid"
     ORDER BY "bucketMid" ASC`;
  const { rows: probRows } = await pool.query(probQuery, params);

  // Win rate by timeframe for resolved trades (for calibration filtering)
  let tfCalQuery = `SELECT timeframe,
       COUNT(*) FILTER (WHERE outcome IN ('win','loss'))::int AS total,
       COUNT(*) FILTER (WHERE outcome = 'win')::int AS wins,
       ROUND(
         CASE WHEN COUNT(*) FILTER (WHERE outcome IN ('win','loss')) > 0
              THEN COUNT(*) FILTER (WHERE outcome = 'win')::numeric / COUNT(*) FILTER (WHERE outcome IN ('win','loss')) * 100
              ELSE NULL END, 1
       ) AS "winRate"
     FROM trade_recommendations
     ${whereClause} AND timeframe IS NOT NULL AND outcome IN ('win','loss')
     GROUP BY timeframe
     ORDER BY total DESC`;
  const { rows: tfCalRows } = await pool.query(tfCalQuery, params);

  // Distribution: wins by probability bucket (for the WINS filter view)
  const bucketCaseSQL = `CASE
         WHEN probability < 35 THEN '30-34%'
         WHEN probability < 40 THEN '35-39%'
         WHEN probability < 45 THEN '40-44%'
         WHEN probability < 50 THEN '45-49%'
         WHEN probability < 55 THEN '50-54%'
         WHEN probability < 60 THEN '55-59%'
         WHEN probability < 65 THEN '60-64%'
         WHEN probability < 70 THEN '65-69%'
         WHEN probability < 75 THEN '70-74%'
         WHEN probability < 80 THEN '75-79%'
         ELSE '80+%'
       END`;
  const midCaseSQL = `CASE
         WHEN probability < 35 THEN 32 WHEN probability < 40 THEN 37
         WHEN probability < 45 THEN 42 WHEN probability < 50 THEN 47
         WHEN probability < 55 THEN 52 WHEN probability < 60 THEN 57
         WHEN probability < 65 THEN 62 WHEN probability < 70 THEN 67
         WHEN probability < 75 THEN 72 WHEN probability < 80 THEN 77
         ELSE 82
       END`;

  // Wins distribution by prob bucket
  const winsDistQuery = `SELECT ${bucketCaseSQL} AS bucket, ${midCaseSQL} AS mid, COUNT(*)::int AS count
     FROM trade_recommendations
     ${whereClause} AND probability IS NOT NULL AND outcome = 'win'
     GROUP BY bucket, mid ORDER BY mid ASC`;
  const { rows: winsDistRows } = await pool.query(winsDistQuery, params);

  // Losses distribution by prob bucket
  const lossDistQuery = `SELECT ${bucketCaseSQL} AS bucket, ${midCaseSQL} AS mid, COUNT(*)::int AS count
     FROM trade_recommendations
     ${whereClause} AND probability IS NOT NULL AND outcome = 'loss'
     GROUP BY bucket, mid ORDER BY mid ASC`;
  const { rows: lossDistRows } = await pool.query(lossDistQuery, params);

  // Wins distribution by timeframe
  const winsTFQuery = `SELECT timeframe AS tf, COUNT(*)::int AS count
     FROM trade_recommendations
     ${whereClause} AND timeframe IS NOT NULL AND outcome = 'win'
     GROUP BY tf ORDER BY count DESC`;
  const { rows: winsTFRows } = await pool.query(winsTFQuery, params);

  // Losses distribution by timeframe
  const lossTFQuery = `SELECT timeframe AS tf, COUNT(*)::int AS count
     FROM trade_recommendations
     ${whereClause} AND timeframe IS NOT NULL AND outcome = 'loss'
     GROUP BY tf ORDER BY count DESC`;
  const { rows: lossTFRows } = await pool.query(lossTFQuery, params);

  return {
    total: summary.total || 0,
    wins: summary.wins || 0,
    losses: summary.losses || 0,
    expired: summary.expired || 0,
    pending: summary.pending || 0,
    avgPnl: summary.avgPnl != null ? parseFloat(summary.avgPnl) : null,
    winRate: summary.winRate != null ? parseFloat(summary.winRate) : null,
    streak: streakType ? `${streak}${streakType === 'win' ? 'W' : 'L'}` : null,
    timeframes: tfRows.map(t => ({
      tf: t.timeframe,
      resolved: t.resolved,
      wins: t.wins,
      avgPnl: t.avgPnl != null ? parseFloat(t.avgPnl) : null,
      winRate: t.winRate != null ? parseFloat(t.winRate) : null,
    })),
    byProbBucket: probRows.map(b => ({
      bucket: b.bucket,
      bucketMid: parseInt(b.bucketMid),
      total: b.total,
      wins: b.wins,
      winRate: b.total > 0 ? parseFloat((b.wins / b.total * 100).toFixed(1)) : 0,
    })),
    byTimeframeCal: tfCalRows.map(t => ({
      timeframe: t.timeframe,
      total: t.total,
      wins: t.wins,
      winRate: t.winRate != null ? parseFloat(t.winRate) : 0,
    })),
    winsDistByProb: winsDistRows.map(r => ({ bucket: r.bucket, mid: parseInt(r.mid), count: r.count })),
    lossDistByProb: lossDistRows.map(r => ({ bucket: r.bucket, mid: parseInt(r.mid), count: r.count })),
    winsDistByTF: winsTFRows.map(r => ({ tf: r.tf, count: r.count })),
    lossDistByTF: lossTFRows.map(r => ({ tf: r.tf, count: r.count })),
  };
}

function start() {
  if (resolveInterval) return;
  console.log('[RecommendationTracker] Started — resolving every 5 minutes.');
  resolveInterval = setInterval(resolveRecommendations, 5 * 60 * 1000);
  // Run once immediately on start
  resolveRecommendations();
}

function stop() {
  if (resolveInterval) {
    clearInterval(resolveInterval);
    resolveInterval = null;
    console.log('[RecommendationTracker] Stopped.');
  }
}

module.exports = { saveRecommendation, resolveRecommendations, getHistory, getSummary, start, stop };
