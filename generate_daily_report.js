const { Pool } = require('./backend/node_modules/pg');
const fs = require('fs');
const path = require('path');

const DATABASE_URL = 'postgresql://postgres:wRSDXXNuuEvJMttNrQaKDbWURHnVbckX@shortline.proxy.rlwy.net:43088/railway';
const REPORT_DATE = '2026-03-20';
const FIX_DATE = '2026-03-18';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function runQuery(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows;
}

async function generateReport() {
  console.log('Connecting to database...');

  // ============================================================
  // SECTION 2: DAILY SNAPSHOT
  // ============================================================
  const todayResolved = await runQuery(`
    SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE outcome='win') as wins,
      COUNT(*) FILTER (WHERE outcome='loss') as losses
    FROM best_trades_log WHERE resolved_at::date = $1::date
  `, [REPORT_DATE]);

  const yesterdayResolved = await runQuery(`
    SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE outcome='win') as wins,
      COUNT(*) FILTER (WHERE outcome='loss') as losses,
      ROUND(100.0 * COUNT(*) FILTER (WHERE outcome='win') / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as wr
    FROM best_trades_log WHERE resolved_at::date = ($1::date - INTERVAL '1 day')
  `, [REPORT_DATE]);

  const overall = await runQuery(`
    SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE outcome='win') as wins,
      COUNT(*) FILTER (WHERE outcome='loss') as losses,
      COUNT(*) FILTER (WHERE outcome IS NULL) as pending,
      ROUND(100.0 * COUNT(*) FILTER (WHERE outcome='win') / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as wr
    FROM best_trades_log
  `);

  const overallYesterday = await runQuery(`
    SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE outcome='win') /
      NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL AND resolved_at::date <= ($1::date - INTERVAL '1 day')), 0), 1) as wr
    FROM best_trades_log WHERE resolved_at::date <= ($1::date - INTERVAL '1 day')
  `, [REPORT_DATE]);

  const postFix = await runQuery(`
    SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE outcome='win') as wins,
      COUNT(*) FILTER (WHERE outcome='loss') as losses,
      COUNT(*) FILTER (WHERE outcome IS NULL) as pending,
      ROUND(100.0 * COUNT(*) FILTER (WHERE outcome='win') / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as wr
    FROM best_trades_log WHERE created_at > $1
  `, [FIX_DATE]);

  const postFixYesterday = await runQuery(`
    SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE outcome='win') /
      NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL AND resolved_at::date <= ($2::date - INTERVAL '1 day')), 0), 1) as wr
    FROM best_trades_log WHERE created_at > $1 AND resolved_at::date <= ($2::date - INTERVAL '1 day')
  `, [FIX_DATE, REPORT_DATE]);

  // ============================================================
  // SECTION 3: PER-ASSET TABLE
  // ============================================================
  const assetStats = await runQuery(`
    SELECT asset,
      COUNT(*) FILTER (WHERE outcome IS NOT NULL) as resolved,
      COUNT(*) FILTER (WHERE outcome='win') as wins,
      COUNT(*) FILTER (WHERE outcome='loss') as losses,
      COUNT(*) FILTER (WHERE outcome IS NULL) as pending,
      ROUND(100.0 * COUNT(*) FILTER (WHERE outcome='win') / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as wr,
      ROUND(AVG(CASE WHEN pnl IS NOT NULL THEN pnl END)::numeric, 4) as avg_pnl
    FROM best_trades_log GROUP BY asset ORDER BY wr DESC NULLS LAST
  `);

  // Rolling 10-trade WR per asset
  const rolling10 = await runQuery(`
    WITH ranked AS (
      SELECT asset, outcome, resolved_at,
        ROW_NUMBER() OVER (PARTITION BY asset ORDER BY resolved_at DESC) as rn
      FROM best_trades_log WHERE outcome IS NOT NULL
    )
    SELECT asset,
      COUNT(*) FILTER (WHERE rn <= 10) as last10_total,
      COUNT(*) FILTER (WHERE rn <= 10 AND outcome='win') as last10_wins,
      ROUND(100.0 * COUNT(*) FILTER (WHERE rn <= 10 AND outcome='win') / NULLIF(COUNT(*) FILTER (WHERE rn <= 10), 0), 1) as rolling10_wr
    FROM ranked GROUP BY asset
  `);
  const rolling10Map = {};
  rolling10.forEach(r => rolling10Map[r.asset] = r);

  // Current streak per asset
  const streakData = await runQuery(`
    WITH ranked AS (
      SELECT asset, outcome, resolved_at,
        ROW_NUMBER() OVER (PARTITION BY asset ORDER BY resolved_at DESC) as rn
      FROM best_trades_log WHERE outcome IS NOT NULL
    ),
    with_lag AS (
      SELECT asset, outcome, rn,
        LAG(outcome) OVER (PARTITION BY asset ORDER BY rn) as prev_outcome
      FROM ranked
    ),
    with_group AS (
      SELECT asset, outcome, rn,
        SUM(CASE WHEN outcome != prev_outcome THEN 1 ELSE 0 END) OVER (PARTITION BY asset ORDER BY rn) as streak_group
      FROM with_lag
    ),
    min_groups AS (
      SELECT asset, MIN(streak_group) as min_group FROM with_group GROUP BY asset
    )
    SELECT wg.asset, wg.outcome, COUNT(*) as streak_len
    FROM with_group wg JOIN min_groups mg ON wg.asset = mg.asset AND wg.streak_group = mg.min_group
    GROUP BY wg.asset, wg.outcome
    ORDER BY wg.asset
  `);
  const streakMap = {};
  streakData.forEach(r => streakMap[r.asset] = { outcome: r.outcome, len: parseInt(r.streak_len) });

  // Post-fix WR per asset
  const postFixAsset = await runQuery(`
    SELECT asset,
      COUNT(*) FILTER (WHERE outcome IS NOT NULL) as resolved,
      COUNT(*) FILTER (WHERE outcome='win') as wins,
      ROUND(100.0 * COUNT(*) FILTER (WHERE outcome='win') / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as wr
    FROM best_trades_log WHERE created_at > $1
    GROUP BY asset
  `, [FIX_DATE]);
  const postFixAssetMap = {};
  postFixAsset.forEach(r => postFixAssetMap[r.asset] = r);

  // ============================================================
  // SECTION 4: INDICATOR EDGE CHECK (post-fix)
  // ============================================================
  const indicators = ['EMA', 'Ichimoku', 'MACD', 'Volume', 'RSI', 'StochRSI', 'BB'];
  const indicatorEdge = [];

  for (const ind of indicators) {
    const field = ind === 'Volume' ? 'Volume' : ind;
    const rows = await runQuery(`
      SELECT
        COUNT(*) FILTER (WHERE (signal_snapshot->'${field}'->>'bull')::boolean = true) as fired,
        COUNT(*) FILTER (WHERE (signal_snapshot->'${field}'->>'bull')::boolean = true AND outcome='win') as fired_wins,
        COUNT(*) FILTER (WHERE (signal_snapshot->'${field}'->>'bull')::boolean = false OR (signal_snapshot->'${field}'->>'bull') IS NULL) as not_fired,
        COUNT(*) FILTER (WHERE ((signal_snapshot->'${field}'->>'bull')::boolean = false OR (signal_snapshot->'${field}'->>'bull') IS NULL) AND outcome='win') as not_fired_wins,
        COUNT(*) FILTER (WHERE outcome IS NOT NULL) as total_resolved
      FROM best_trades_log
      WHERE outcome IS NOT NULL AND created_at > $1
    `, [FIX_DATE]);

    const r = rows[0];
    const firedWR = r.fired > 0 ? Math.round(100 * r.fired_wins / r.fired * 10) / 10 : null;
    const notFiredWR = r.not_fired > 0 ? Math.round(100 * r.not_fired_wins / r.not_fired * 10) / 10 : null;
    const edge = (firedWR !== null && notFiredWR !== null) ? Math.round((firedWR - notFiredWR) * 10) / 10 : null;
    indicatorEdge.push({ indicator: ind, fired: parseInt(r.fired), firedWR, notFiredWR, edge });
  }

  // Bear direction indicator check (for shorts)
  const bearIndicatorEdge = [];
  for (const ind of indicators) {
    const rows = await runQuery(`
      SELECT
        COUNT(*) FILTER (WHERE (signal_snapshot->'${ind}'->>'bear')::boolean = true) as fired,
        COUNT(*) FILTER (WHERE (signal_snapshot->'${ind}'->>'bear')::boolean = true AND outcome='win') as fired_wins
      FROM best_trades_log
      WHERE outcome IS NOT NULL AND created_at > $1 AND direction = 'short'
    `, [FIX_DATE]);
    const r = rows[0];
    const firedWR = r.fired > 0 ? Math.round(100 * r.fired_wins / r.fired * 10) / 10 : null;
    bearIndicatorEdge.push({ indicator: ind, fired: parseInt(r.fired), firedWR });
  }

  // Hits list analysis (winning trades)
  const hitsAnalysis = await runQuery(`
    SELECT
      COUNT(*) FILTER (WHERE outcome='win') as total_wins,
      COUNT(*) FILTER (WHERE outcome='win' AND hits::text LIKE '%EMA%') as ema_in_wins,
      COUNT(*) FILTER (WHERE outcome='win' AND hits::text LIKE '%Ichimoku%') as ichimoku_in_wins,
      COUNT(*) FILTER (WHERE outcome='win' AND hits::text LIKE '%MACD%') as macd_in_wins
    FROM best_trades_log WHERE outcome IS NOT NULL AND created_at > $1
  `, [FIX_DATE]);

  // Regression check: disabled signals appearing in HITS_LIST (not signal_snapshot) on long trades post-fix
  // signal_snapshot stores raw indicator state for analysis — disabled signals appear there by design.
  // hits_list shows what actually CONTRIBUTED to scoring. Only flag if disabled signals are in hits_list.
  const regressionCheck = await runQuery(`
    SELECT id, asset, direction, created_at, hits::text as hits_text
    FROM best_trades_log
    WHERE created_at > $1
      AND direction = 'long'
      AND (
        hits::text ILIKE '%RSI%'
        OR hits::text ILIKE '%BB%'
        OR hits::text ILIKE '%StochRSI%'
      )
      AND hits::text NOT ILIKE '%BB_Squeeze%'
    ORDER BY created_at DESC LIMIT 10
  `, [FIX_DATE]);

  // ============================================================
  // SECTION 4B: CROSS-TF ALIGNMENT
  // ============================================================
  const tfAlignment = await runQuery(`
    SELECT tf_alignment_score, COUNT(*) as n,
      ROUND(100.0 * COUNT(*) FILTER (WHERE outcome='win') / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as wr,
      COUNT(*) FILTER (WHERE outcome IS NOT NULL) as resolved
    FROM best_trades_log
    WHERE created_at > $1 AND tf_alignment_score IS NOT NULL AND outcome IS NOT NULL
    GROUP BY tf_alignment_score ORDER BY tf_alignment_score DESC
  `, [FIX_DATE]);

  const tfAlignmentAll = await runQuery(`
    SELECT COUNT(*) as total_with_tf,
      COUNT(*) FILTER (WHERE outcome IS NOT NULL) as resolved_with_tf
    FROM best_trades_log
    WHERE created_at > $1 AND tf_alignment_score IS NOT NULL
  `, [FIX_DATE]);

  const fourHConflict = await runQuery(`
    SELECT
      CASE WHEN highest_tf_conflict = '4h' THEN '4h Opposing' ELSE '4h Aligned/Neutral' END as conflict,
      COUNT(*) as n,
      ROUND(100.0 * COUNT(*) FILTER (WHERE outcome='win') / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as wr,
      COUNT(*) FILTER (WHERE outcome IS NOT NULL) as resolved
    FROM best_trades_log
    WHERE created_at > $1 AND tf_alignment_score IS NOT NULL AND outcome IS NOT NULL
    GROUP BY CASE WHEN highest_tf_conflict = '4h' THEN '4h Opposing' ELSE '4h Aligned/Neutral' END
  `, [FIX_DATE]);

  const tfBearCount = await runQuery(`
    SELECT tf_bear_count, COUNT(*) as n,
      ROUND(100.0 * COUNT(*) FILTER (WHERE outcome='win') / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as wr,
      COUNT(*) FILTER (WHERE outcome IS NOT NULL) as resolved
    FROM best_trades_log
    WHERE created_at > $1 AND tf_bear_count IS NOT NULL AND outcome IS NOT NULL AND direction = 'short'
    GROUP BY tf_bear_count ORDER BY tf_bear_count
  `, [FIX_DATE]);

  const tfBullCount = await runQuery(`
    SELECT tf_bull_count, COUNT(*) as n,
      ROUND(100.0 * COUNT(*) FILTER (WHERE outcome='win') / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as wr,
      COUNT(*) FILTER (WHERE outcome IS NOT NULL) as resolved
    FROM best_trades_log
    WHERE created_at > $1 AND tf_bull_count IS NOT NULL AND outcome IS NOT NULL AND direction = 'long'
    GROUP BY tf_bull_count ORDER BY tf_bull_count
  `, [FIX_DATE]);

  // ============================================================
  // SECTION 4C: EXPERIMENTAL DATA (market structure + funding)
  // ============================================================
  const marketStructure = await runQuery(`
    SELECT
      signal_snapshot->'market_structure'->>'structure' as structure,
      direction,
      COUNT(*) as n,
      COUNT(*) FILTER (WHERE outcome IS NOT NULL) as resolved,
      ROUND(100.0 * COUNT(*) FILTER (WHERE outcome='win') / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as wr
    FROM best_trades_log
    WHERE created_at > $1 AND signal_snapshot->'market_structure' IS NOT NULL
    GROUP BY signal_snapshot->'market_structure'->>'structure', direction
    ORDER BY structure, direction
  `, [FIX_DATE]);

  const fundingRateData = await runQuery(`
    SELECT
      signal_snapshot->'funding_rate_score'->>'signal' as signal,
      direction,
      COUNT(*) as n,
      COUNT(*) FILTER (WHERE outcome IS NOT NULL) as resolved,
      ROUND(100.0 * COUNT(*) FILTER (WHERE outcome='win') / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as wr,
      ROUND(AVG((signal_snapshot->'funding_rate_score'->>'hypothetical_prob_adj')::numeric)::numeric, 2) as avg_hyp_adj
    FROM best_trades_log
    WHERE created_at > $1 AND signal_snapshot->'funding_rate_score' IS NOT NULL
    GROUP BY signal_snapshot->'funding_rate_score'->>'signal', direction
    ORDER BY signal, direction
  `, [FIX_DATE]);

  const expDataCount = await runQuery(`
    SELECT
      COUNT(*) FILTER (WHERE signal_snapshot->'market_structure' IS NOT NULL) as ms_count,
      COUNT(*) FILTER (WHERE signal_snapshot->'funding_rate_score' IS NOT NULL) as fr_count
    FROM best_trades_log WHERE created_at > $1
  `, [FIX_DATE]);

  // ============================================================
  // SECTION 5: CALIBRATION HEALTH
  // ============================================================
  const calibration = await runQuery(`
    SELECT
      ROUND(AVG(probability)::numeric, 1) as avg_calibrated,
      ROUND(AVG(raw_probability)::numeric, 1) as avg_raw,
      ROUND(AVG(probability - raw_probability)::numeric, 1) as avg_inflation,
      COUNT(*) as n
    FROM best_trades_log WHERE created_at > $1
  `, [FIX_DATE]);

  const calibrationYesterday = await runQuery(`
    SELECT ROUND(AVG(probability - raw_probability)::numeric, 1) as avg_inflation
    FROM best_trades_log WHERE created_at > $1 AND created_at::date <= ($2::date - INTERVAL '1 day')
  `, [FIX_DATE, REPORT_DATE]);

  // Calibration by bucket
  const calibBuckets = await runQuery(`
    SELECT
      CASE
        WHEN probability BETWEEN 50 AND 54.99 THEN '50-55%'
        WHEN probability BETWEEN 55 AND 59.99 THEN '55-60%'
        WHEN probability BETWEEN 60 AND 64.99 THEN '60-65%'
        WHEN probability >= 65 THEN '65%+'
        ELSE '<50%'
      END as bucket,
      COUNT(*) as n,
      COUNT(*) FILTER (WHERE outcome IS NOT NULL) as resolved,
      ROUND(100.0 * COUNT(*) FILTER (WHERE outcome='win') / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as actual_wr,
      ROUND(AVG(probability)::numeric, 1) as avg_prob
    FROM best_trades_log WHERE created_at > $1 AND outcome IS NOT NULL
    GROUP BY bucket ORDER BY bucket
  `, [FIX_DATE]);

  // Confidence level WR
  const confidenceWR = await runQuery(`
    SELECT confidence,
      COUNT(*) FILTER (WHERE outcome IS NOT NULL) as resolved,
      COUNT(*) FILTER (WHERE outcome='win') as wins,
      ROUND(100.0 * COUNT(*) FILTER (WHERE outcome='win') / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) as wr
    FROM best_trades_log WHERE created_at > $1
    GROUP BY confidence ORDER BY CASE confidence WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 WHEN 'Low' THEN 3 END
  `, [FIX_DATE]);

  // ============================================================
  // SECTION 6: SCANNER HEALTH
  // ============================================================
  const scannerErrors = await runQuery(`
    SELECT timeframe,
      COUNT(*) FILTER (WHERE outcome IS NULL) as pending_today,
      COUNT(*) as total_created_today
    FROM best_trades_log
    WHERE created_at::date = $1::date
    GROUP BY timeframe ORDER BY timeframe
  `, [REPORT_DATE]);

  const recentTrades = await runQuery(`
    SELECT id, asset, direction, timeframe, probability, confidence, market_quality,
      outcome, created_at, resolved_at
    FROM best_trades_log
    WHERE created_at > $1
    ORDER BY created_at DESC LIMIT 20
  `, [FIX_DATE]);

  // ============================================================
  // SECTION 7: COMPOUND TRACKER
  // ============================================================
  const dailyPnl = await runQuery(`
    SELECT DATE(resolved_at) as day,
      SUM(CASE WHEN outcome='win' THEN COALESCE(pnl, 0) ELSE COALESCE(pnl, 0) END) as daily_pnl,
      COUNT(*) FILTER (WHERE outcome='win') as wins,
      COUNT(*) FILTER (WHERE outcome='loss') as losses,
      COUNT(*) as trades
    FROM best_trades_log
    WHERE resolved_at IS NOT NULL AND resolved_at > $1 AND outcome IS NOT NULL
    GROUP BY DATE(resolved_at) ORDER BY day
  `, [FIX_DATE]);

  // ============================================================
  // PROCESS DATA AND BUILD FLAGS
  // ============================================================
  const overallData = overall[0];
  const todayData = todayResolved[0];
  const postFixData = postFix[0];
  const calData = calibration[0];

  // Calculate today's WR
  const todayWR = todayData.total > 0 && (parseInt(todayData.wins) + parseInt(todayData.losses)) > 0
    ? Math.round(100 * parseInt(todayData.wins) / (parseInt(todayData.wins) + parseInt(todayData.losses)) * 10) / 10
    : null;
  const yesterdayWR = yesterdayResolved[0]?.wr ? parseFloat(yesterdayResolved[0].wr) : null;

  // Check for 7+ consecutive losses per asset
  const criticalLossStreaks = [];
  const warningLossStreaks = [];
  for (const [asset, streak] of Object.entries(streakMap)) {
    if (streak.outcome === 'loss') {
      if (streak.len >= 7) criticalLossStreaks.push({ asset, len: streak.len });
      else if (streak.len >= 4) warningLossStreaks.push({ asset, len: streak.len });
    }
  }

  // Check rolling 10 WR warnings
  const lowRolling10 = [];
  const criticalRolling10 = [];
  for (const [asset, r10] of Object.entries(rolling10Map)) {
    if (r10.last10_total >= 5) {
      const wr = parseFloat(r10.rolling10_wr || 0);
      if (wr < 35) criticalRolling10.push({ asset, wr, n: r10.last10_total });
      else if (wr < 42) lowRolling10.push({ asset, wr, n: r10.last10_total });
    }
  }

  // Check calibration inflation
  const inflation = parseFloat(calData.avg_inflation || 0);
  const inflationYesterday = parseFloat(calibrationYesterday[0]?.avg_inflation || 0);

  // Confidence inversion check
  const highConf = confidenceWR.find(r => r.confidence === 'High');
  const medConf = confidenceWR.find(r => r.confidence === 'Medium');
  const lowConf = confidenceWR.find(r => r.confidence === 'Low');
  const confInversion = medConf && lowConf && parseFloat(medConf.wr || 0) < parseFloat(lowConf.wr || 0);

  // Regression check: disabled signals in long trades
  const regressionBugs = regressionCheck.length;

  // 4h conflict
  const fourHOpp = fourHConflict.find(r => r.conflict === '4h Opposing');
  const fourHAligned = fourHConflict.find(r => r.conflict === '4h Aligned/Neutral');

  // Build compound balance
  let balance = 1000;
  let positiveStreak = 0, negativeStreak = 0, currentPosStreak = 0, currentNegStreak = 0;
  let compoundRows = [];
  for (const d of dailyPnl) {
    const pnl = parseFloat(d.daily_pnl || 0);
    balance += pnl;
    const dailyReturn = pnl / (balance - pnl) * 100;
    const hitTarget = dailyReturn >= 1;
    if (pnl > 0) { currentPosStreak++; currentNegStreak = 0; }
    else if (pnl < 0) { currentNegStreak++; currentPosStreak = 0; }
    compoundRows.push({ day: d.day, pnl: Math.round(pnl * 100) / 100, balance: Math.round(balance * 100) / 100, wins: d.wins, losses: d.losses, hitTarget, dailyReturn: Math.round(dailyReturn * 100) / 100 });
  }

  // ============================================================
  // GENERATE FULL TRADE LOG CSV
  // ============================================================
  console.log('Generating FULL_TRADE_LOG.csv...');
  const allTrades = await runQuery(`
    SELECT id, asset, direction, timeframe,
      probability, raw_probability,
      confidence, market_quality, regime,
      outcome, pnl,
      entry_price, stop_price, target_price,
      stop_pct, target_pct, rr_ratio,
      ev, optimal_lev, atr_value,
      volume_ratio, confluence_score,
      executed, order_id,
      created_at, resolved_at, last_seen_at,
      scan_count,
      signal_snapshot,
      tf_alignment_score, tf_bear_count, tf_bull_count, highest_tf_conflict,
      hits, misses
    FROM best_trades_log ORDER BY created_at DESC
  `);

  const csvHeaders = [
    'id', 'asset', 'direction', 'timeframe',
    'probability', 'raw_probability',
    'confidence', 'market_quality', 'regime',
    'outcome', 'pnl',
    'entry_price', 'stop_price', 'target_price',
    'stop_pct', 'target_pct', 'rr_ratio',
    'ev', 'optimal_lev', 'atr_value',
    'volume_ratio', 'confluence_score',
    'executed', 'order_id',
    'created_at', 'resolved_at', 'last_seen_at',
    'scan_count',
    'rsi_value', 'rsi_bull', 'rsi_bear',
    'ema_bull', 'ema_bear',
    'macd_bull', 'macd_bear',
    'stochrsi_bull', 'stochrsi_bear',
    'bb_bull', 'bb_bear',
    'ichimoku_bull', 'ichimoku_bear',
    'volume_bull', 'volume_bear',
    'funding_rate',
    'pattern_adj', 'pattern_composite',
    'chart_patterns',
    'tf_alignment_score', 'tf_bear_count', 'tf_bull_count', 'highest_tf_conflict',
    'market_structure', 'funding_rate_signal', 'funding_hyp_adj',
    'hits_list', 'misses_list'
  ];

  function escapeCSV(val) {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) return '"' + str.replace(/"/g, '""') + '"';
    return str;
  }

  function formatPatterns(patterns) {
    if (!patterns || !Array.isArray(patterns)) return '';
    return patterns.map(p => `${p.name}(${p.direction}/${p.stage}:${p.score})`).join(' | ');
  }

  const csvRows = [csvHeaders.join(',')];
  for (const row of allTrades) {
    const snap = row.signal_snapshot || {};
    const values = [
      row.id, row.asset, row.direction, row.timeframe,
      row.probability, row.raw_probability,
      row.confidence, row.market_quality, row.regime,
      row.outcome, row.pnl,
      row.entry_price, row.stop_price, row.target_price,
      row.stop_pct, row.target_pct, row.rr_ratio,
      row.ev, row.optimal_lev, row.atr_value,
      row.volume_ratio, row.confluence_score,
      row.executed, row.order_id,
      row.created_at ? new Date(row.created_at).toISOString() : '',
      row.resolved_at ? new Date(row.resolved_at).toISOString() : '',
      row.last_seen_at ? new Date(row.last_seen_at).toISOString() : '',
      row.scan_count,
      snap.RSI?.value, snap.RSI?.bull, snap.RSI?.bear,
      snap.EMA?.bull, snap.EMA?.bear,
      snap.MACD?.bull, snap.MACD?.bear,
      snap.StochRSI?.bull, snap.StochRSI?.bear,
      snap.BB?.bull, snap.BB?.bear,
      snap.Ichimoku?.bull, snap.Ichimoku?.bear,
      snap.Volume?.bull, snap.Volume?.bear,
      snap.fundingRate,
      snap.patternAdj, snap.patternComposite,
      formatPatterns(snap.chartPatterns),
      row.tf_alignment_score, row.tf_bear_count, row.tf_bull_count, row.highest_tf_conflict,
      snap.market_structure?.structure || '',
      snap.funding_rate_score?.signal || '',
      snap.funding_rate_score?.hypothetical_prob_adj || '',
      row.hits ? (Array.isArray(row.hits) ? row.hits.join('; ') : JSON.stringify(row.hits)) : '',
      row.misses ? (Array.isArray(row.misses) ? row.misses.join('; ') : JSON.stringify(row.misses)) : ''
    ];
    csvRows.push(values.map(escapeCSV).join(','));
  }

  const csvPath = path.join(__dirname, 'FULL_TRADE_LOG.csv');
  const csvPathTemp = path.join(__dirname, 'FULL_TRADE_LOG_TEMP.csv');
  try {
    fs.writeFileSync(csvPath, csvRows.join('\n'), 'utf8');
    console.log(`CSV saved: ${csvPath} (${allTrades.length} trades)`);
  } catch (e) {
    console.warn(`CSV locked, writing to temp: ${e.message}`);
    fs.writeFileSync(csvPathTemp, csvRows.join('\n'), 'utf8');
    console.log(`CSV saved to temp: ${csvPathTemp} (${allTrades.length} trades)`);
  }

  // ============================================================
  // SECTION 3 PREP - Sort asset table
  // ============================================================
  function getAssessment(wr) {
    if (wr === null || wr === undefined) return { label: 'N/A', color: '#888', bg: '#1a1a1a' };
    const w = parseFloat(wr);
    if (w >= 65) return { label: '⭐ Star', color: '#00ff88', bg: '#0a2a1a' };
    if (w >= 55) return { label: '💪 Strong', color: '#88ff44', bg: '#1a2a0a' };
    if (w >= 45) return { label: '⚡ Borderline', color: '#ffcc00', bg: '#2a2000' };
    if (w >= 40) return { label: '👀 Watch', color: '#ff8800', bg: '#2a1500' };
    return { label: '🚫 Ban', color: '#ff4444', bg: '#2a0000' };
  }

  // ============================================================
  // BUILD HTML REPORT
  // ============================================================
  const reportDate = new Date(REPORT_DATE).toLocaleDateString('en-AU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const todayWRDelta = todayWR !== null && yesterdayWR !== null ? todayWR - yesterdayWR : null;
  const overallWRDelta = overallData.wr && overallYesterday[0]?.wr ? parseFloat(overallData.wr) - parseFloat(overallYesterday[0].wr) : null;
  const postFixWRDelta = postFixData.wr && postFixYesterday[0]?.wr ? parseFloat(postFixData.wr) - parseFloat(postFixYesterday[0].wr) : null;

  function delta(val) {
    if (val === null || val === undefined || isNaN(val)) return '';
    const v = parseFloat(val);
    if (v > 0) return `<span style="color:#00ff88"> ↑${Math.abs(v).toFixed(1)}pp</span>`;
    if (v < 0) return `<span style="color:#ff4444"> ↓${Math.abs(v).toFixed(1)}pp</span>`;
    return `<span style="color:#888"> ↔0pp</span>`;
  }

  // Build flags
  let criticalFlags = [];
  let warningFlags = [];
  let positiveFlags = [];

  // Critical flags
  if (criticalLossStreaks.length > 0) {
    criticalLossStreaks.forEach(s => criticalFlags.push(`<b>${s.asset}</b> is on a ${s.len}-trade losing streak — consider temp-ban`));
  }
  if (inflation > 12) {
    criticalFlags.push(`<b>Calibration inflation at +${inflation}pp</b> — exceeds 12pp threshold (target: <3pp)`);
  }
  if (regressionBugs > 0) {
    criticalFlags.push(`<b>⚠️ DEPLOYMENT REGRESSION DETECTED:</b> ${regressionBugs} long trade(s) post-fix have disabled bull signals (RSI/BB/StochRSI) firing — investigate immediately`);
  }
  if (criticalRolling10.length > 0) {
    criticalRolling10.forEach(a => criticalFlags.push(`<b>${a.asset}</b> rolling-10 WR: ${a.wr}% (${a.n} trades) — suggest temp-ban`));
  }

  // Warning flags
  if (lowRolling10.length > 0) {
    lowRolling10.forEach(a => warningFlags.push(`<b>${a.asset}</b> rolling-10 WR: ${a.wr}% (${a.n} trades) — below 42% threshold`));
  }
  if (confInversion) {
    warningFlags.push(`<b>Confidence inversion present:</b> Medium WR (${medConf?.wr}%) < Low WR (${lowConf?.wr}%) — calibration system still needs attention`);
  }
  if (inflation > 8 && inflation <= 12) {
    warningFlags.push(`<b>Calibration inflation at +${inflation}pp</b> — elevated but below critical threshold (target: <3pp)`);
  }
  if (inflationYesterday && inflation > inflationYesterday) {
    warningFlags.push(`<b>Calibration inflation increasing:</b> ${inflationYesterday}pp → ${inflation}pp day-over-day`);
  }
  if (warningLossStreaks.length > 0) {
    warningLossStreaks.forEach(s => warningFlags.push(`<b>${s.asset}</b> on ${s.len}-trade loss streak — monitor closely`));
  }

  // Positive flags
  const postFixWR = parseFloat(postFixData.wr || 0);
  if (postFixWR > 55) {
    positiveFlags.push(`<b>Post-fix WR at ${postFixData.wr}%</b> across ${postFixData.total} trades — tracking toward 72.6% target`);
  }
  if (inflation < inflationYesterday && inflationYesterday > 0) {
    positiveFlags.push(`<b>Calibration inflation declining:</b> ${inflationYesterday}pp → ${inflation}pp`);
  }
  // Check EMA/Ichimoku in wins
  const hitsA = hitsAnalysis[0];
  const totalWins = parseInt(hitsA.total_wins || 0);
  if (totalWins > 0) {
    const emaPct = Math.round(100 * hitsA.ema_in_wins / totalWins);
    const ichimokuPct = Math.round(100 * hitsA.ichimoku_in_wins / totalWins);
    if (emaPct >= 60) positiveFlags.push(`<b>EMA in ${emaPct}% of winning trades</b> — momentum thesis confirmed`);
    if (ichimokuPct >= 50) positiveFlags.push(`<b>Ichimoku in ${ichimokuPct}% of winning trades</b> — structure confirmation working`);
  }
  if (fourHOpp && fourHAligned) {
    positiveFlags.push(`<b>4h conflict data accumulating:</b> ${fourHOpp.n} trades with 4h opposing (${fourHOpp.wr}% WR), ${fourHAligned.n} without (${fourHAligned.wr}% WR)`);
  }

  // No flags? Add defaults
  if (criticalFlags.length === 0) criticalFlags.push('No critical issues detected today');
  if (warningFlags.length === 0) warningFlags.push('No active warnings');
  if (positiveFlags.length === 0) positiveFlags.push('Insufficient post-fix data to determine positive trends yet');

  // AI questions
  const aiQuestions = [];
  if ((parseInt(postFixData.wins||0)+parseInt(postFixData.losses||0)) > 5) {
    aiQuestions.push(`Post-fix WR is <b>${postFixData.wr}%</b> after ${(parseInt(postFixData.wins||0)+parseInt(postFixData.losses||0))} resolved trades — on track for 72.6% backtest target?`);
  }
  if (inflation > 5) {
    aiQuestions.push(`Calibration inflation is <b>+${inflation}pp</b> — should we adjust correction weight from current setting?`);
  }
  if (confInversion) {
    aiQuestions.push(`Confidence inversion still present (Medium ${medConf?.wr}% vs Low ${lowConf?.wr}%) — does this suggest over-filtering Medium signals?`);
  }
  const totalResolvedPostFix = parseInt(postFixData.total) - parseInt(postFixData.pending);
  if (hitsA && totalWins > 0) {
    const emaPct = Math.round(100 * hitsA.ema_in_wins / totalWins);
    aiQuestions.push(`EMA appearing in <b>${emaPct}%</b> of winning hits (target >80%) — is momentum thesis fully validated with current sample size?`);
  }
  if (fourHOpp && parseInt(fourHOpp.n) >= 10) {
    aiQuestions.push(`4h opposing trades show <b>${fourHOpp.wr}% WR</b> over ${fourHOpp.n} trades — should we consider hardening the 4h gate before 30-trade threshold?`);
  }
  if (regressionBugs > 0) {
    aiQuestions.push(`⚠️ Regression check found ${regressionBugs} post-fix long trades with disabled signals still firing — is this a logging artefact or a live deployment issue?`);
  }
  while (aiQuestions.length < 3) {
    aiQuestions.push('Continue monitoring post-fix data accumulation — more resolved trades needed for statistical significance.');
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Daily AI Review Report — ${REPORT_DATE}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0d0d0d; color: #e0e0e0; font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px; line-height: 1.5; padding: 20px; }
  h1 { font-size: 22px; color: #ffffff; margin-bottom: 4px; }
  h2 { font-size: 15px; color: #ffffff; margin: 20px 0 10px; padding: 8px 12px; border-radius: 6px; }
  h2.critical { background: #2a0808; border-left: 4px solid #ff4444; }
  h2.warning { background: #2a1f00; border-left: 4px solid #ffcc00; }
  h2.positive { background: #0a2a0f; border-left: 4px solid #00ff88; }
  h2.section { background: #111; border-left: 4px solid #4488ff; }
  .subtitle { color: #888; font-size: 12px; margin-bottom: 20px; }
  .flag-block { margin-bottom: 8px; padding: 8px 12px; border-radius: 4px; font-size: 12px; }
  .flag-critical { background: #1a0505; border: 1px solid #ff4444; }
  .flag-warning { background: #1a1400; border: 1px solid #ffaa00; }
  .flag-positive { background: #051a0a; border: 1px solid #00cc66; }
  .grid-5 { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 16px; }
  .metric-card { background: #141414; border: 1px solid #222; border-radius: 8px; padding: 12px; text-align: center; }
  .metric-card .val { font-size: 24px; font-weight: bold; color: #fff; }
  .metric-card .label { font-size: 11px; color: #888; margin-top: 4px; }
  .metric-card .delta { font-size: 12px; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 12px; }
  th { background: #1a1a1a; color: #aaa; padding: 7px 8px; text-align: left; border-bottom: 2px solid #333; font-weight: 600; }
  td { padding: 6px 8px; border-bottom: 1px solid #1f1f1f; vertical-align: middle; }
  tr:hover td { background: #161616; }
  .badge { display: inline-block; padding: 2px 7px; border-radius: 12px; font-size: 10px; font-weight: 600; }
  .win-green { color: #00ff88; }
  .loss-red { color: #ff4444; }
  .warn-yellow { color: #ffcc00; }
  .info-blue { color: #4488ff; }
  .status-ok { color: #00cc66; }
  .status-warn { color: #ffaa00; }
  .status-bad { color: #ff4444; }
  .section-content { background: #111; border: 1px solid #1f1f1f; border-radius: 6px; padding: 14px; margin-bottom: 16px; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .exp-tag { display: inline-block; padding: 2px 8px; background: #1a1a3a; border: 1px solid #4444aa; border-radius: 4px; font-size: 10px; color: #8888ff; margin-bottom: 8px; }
  .question-item { padding: 8px 12px; margin: 6px 0; background: #141428; border: 1px solid #2244aa; border-radius: 6px; font-size: 12px; }
  hr { border: none; border-top: 1px solid #222; margin: 16px 0; }
  .col-good { color: #00ff88; font-weight: bold; }
  .col-warn { color: #ffcc00; font-weight: bold; }
  .col-bad { color: #ff4444; font-weight: bold; }
  .page-break { page-break-after: always; }
  @media print { body { background: white; color: black; } }
</style>
</head>
<body>
<h1>📊 Daily AI Review Report</h1>
<div class="subtitle">Ultimate Crypto Backtester Pro &nbsp;|&nbsp; ${reportDate} &nbsp;|&nbsp; Post-Fix Day ${Math.floor((new Date(REPORT_DATE) - new Date(FIX_DATE)) / 86400000)} &nbsp;|&nbsp; Baseline Before Fix: 55.41% WR &nbsp;|&nbsp; Target: 72.6% WR</div>

<!-- ===================== SECTION 1: FLAGS ===================== -->
<h2 class="critical">🚨 AUTOMATED FLAGS — Most Important Section</h2>
<div style="background:#1a0505; border:1px solid #ff4444; border-radius:6px; padding:12px; margin-bottom:10px;">
  <div style="color:#ff4444; font-weight:bold; font-size:13px; margin-bottom:8px;">🔴 CRITICAL — Act Today</div>
  ${criticalFlags.map(f => `<div class="flag-block flag-critical">• ${f}</div>`).join('')}
</div>
<div style="background:#1a1400; border:1px solid #ffaa00; border-radius:6px; padding:12px; margin-bottom:10px;">
  <div style="color:#ffcc00; font-weight:bold; font-size:13px; margin-bottom:8px;">🟡 WARNING — Review This Week</div>
  ${warningFlags.map(f => `<div class="flag-block flag-warning">• ${f}</div>`).join('')}
</div>
<div style="background:#051a0a; border:1px solid #00cc66; border-radius:6px; padding:12px; margin-bottom:10px;">
  <div style="color:#00ff88; font-weight:bold; font-size:13px; margin-bottom:8px;">🟢 POSITIVE — Tracking Well</div>
  ${positiveFlags.map(f => `<div class="flag-block flag-positive">• ${f}</div>`).join('')}
</div>

<hr>

<!-- ===================== SECTION 2: DAILY SNAPSHOT ===================== -->
<h2 class="section">📊 Daily Snapshot</h2>
<div class="grid-5">
  <div class="metric-card">
    <div class="val">${todayWR !== null ? todayWR + '%' : 'N/A'}</div>
    <div class="label">Today's WR</div>
    <div class="delta">${delta(todayWRDelta)}</div>
  </div>
  <div class="metric-card">
    <div class="val" style="color:${parseFloat(overallData.wr||0)>=55?'#00ff88':parseFloat(overallData.wr||0)>=45?'#ffcc00':'#ff4444'}">${overallData.wr || 'N/A'}%</div>
    <div class="label">Overall WR (${overallData.total} trades)</div>
    <div class="delta">${delta(overallWRDelta)}</div>
  </div>
  <div class="metric-card">
    <div class="val" style="color:${parseFloat(postFixData.wr||0)>=65?'#00ff88':parseFloat(postFixData.wr||0)>=50?'#ffcc00':'#ff4444'}">${postFixData.wr || 'N/A'}%</div>
    <div class="label">Post-Fix WR (target: 72.6%)</div>
    <div class="delta">${delta(postFixWRDelta)}<br><span style="color:#888;font-size:10px;">${(parseInt(postFixData.wins||0)+parseInt(postFixData.losses||0))} resolved</span></div>
  </div>
  <div class="metric-card">
    <div class="val">${todayData.total}</div>
    <div class="label">Resolved Today</div>
    <div class="delta"><span class="win-green">${todayData.wins}W</span> / <span class="loss-red">${todayData.losses}L</span></div>
  </div>
  <div class="metric-card">
    <div class="val" style="color:#4488ff">${overallData.pending}</div>
    <div class="label">Pending Trades</div>
    <div class="delta" style="font-size:10px; color:#888;">${postFixData.pending} post-fix</div>
  </div>
</div>

<!-- ===================== SECTION 3: PER-ASSET TABLE ===================== -->
<h2 class="section">📈 Per-Asset Performance</h2>
<div class="section-content">
<table>
  <thead>
    <tr>
      <th>Asset</th>
      <th>Overall WR</th>
      <th>W/L</th>
      <th>Rolling-10 WR</th>
      <th>Streak</th>
      <th>Post-Fix WR</th>
      <th>Post-Fix n</th>
      <th>Pending</th>
      <th>Avg PnL%</th>
      <th>Assessment</th>
    </tr>
  </thead>
  <tbody>
    ${assetStats.map(a => {
      const r10 = rolling10Map[a.asset] || {};
      const streak = streakMap[a.asset] || {};
      const pf = postFixAssetMap[a.asset] || {};
      const assessment = getAssessment(a.wr);
      const r10wr = r10.rolling10_wr ? parseFloat(r10.rolling10_wr) : null;
      const r10Color = r10wr === null ? '#888' : r10wr >= 55 ? '#00ff88' : r10wr >= 45 ? '#ffcc00' : r10wr >= 35 ? '#ff8800' : '#ff4444';
      const streakText = streak.len ? `${streak.outcome === 'win' ? '🟢' : '🔴'} ${streak.len}${streak.outcome === 'win' ? 'W' : 'L'}` : '-';
      const overallWrVal = parseFloat(a.wr || 0);
      const wrColor = overallWrVal >= 60 ? '#00ff88' : overallWrVal >= 50 ? '#88ff44' : overallWrVal >= 45 ? '#ffcc00' : '#ff4444';
      const pfWrVal = parseFloat(pf.wr || 0);
      const pfColor = pfWrVal >= 60 ? '#00ff88' : pfWrVal >= 50 ? '#ffcc00' : pfWrVal > 0 ? '#ff4444' : '#888';
      return `<tr>
        <td><b style="color:#fff">${a.asset}</b></td>
        <td style="color:${wrColor};font-weight:bold">${a.wr || 'N/A'}%</td>
        <td>${a.wins}W / ${a.losses}L</td>
        <td style="color:${r10Color};font-weight:bold">${r10wr !== null ? r10wr + '%' : '-'} <span style="color:#555;font-size:10px">(${r10.last10_total || 0}/10)</span></td>
        <td>${streakText}</td>
        <td style="color:${pfColor};font-weight:bold">${pf.wr || '-'}%</td>
        <td style="color:#888">${pf.resolved || 0}</td>
        <td style="color:#4488ff">${a.pending}</td>
        <td style="color:${parseFloat(a.avg_pnl||0)>0?'#00ff88':parseFloat(a.avg_pnl||0)<0?'#ff4444':'#888'}">${a.avg_pnl || '0.00'}%</td>
        <td style="background:${assessment.bg};color:${assessment.color};font-size:11px;font-weight:bold;border-radius:4px;padding:3px 7px">${assessment.label}</td>
      </tr>`;
    }).join('')}
  </tbody>
</table>
<p style="font-size:11px; color:#666;">⭐ Star: WR≥65% | 💪 Strong: 55-65% | ⚡ Borderline: 45-55% | 👀 Watch: 40-45% | 🚫 Ban: <40%</p>
</div>

<!-- ===================== SECTION 4: INDICATOR EDGE ===================== -->
<h2 class="section">🔬 Indicator Edge Check (Post-Fix Only)</h2>
<div class="section-content">
<div class="two-col">
<div>
  <p style="color:#888; font-size:11px; margin-bottom:8px;">Bull signal WR (all directions vs long trades)</p>
  <table>
    <thead><tr><th>Indicator</th><th>WR When Fired</th><th>Times Fired</th><th>Edge (pp)</th><th>Status</th></tr></thead>
    <tbody>
    ${indicatorEdge.map(ind => {
      const isDisabled = ['RSI', 'BB', 'StochRSI'].includes(ind.indicator);
      const edgeColor = ind.edge === null ? '#888' : ind.edge > 5 ? '#00ff88' : ind.edge > 0 ? '#88ff44' : '#ff4444';
      const wrColor = ind.firedWR === null ? '#888' : ind.firedWR >= 55 ? '#00ff88' : ind.firedWR >= 45 ? '#ffcc00' : '#ff4444';
      const status = isDisabled
        ? (ind.fired > 0 ? '<span style="color:#ff4444;font-weight:bold">⚠️ DISABLED (firing!)</span>' : '<span style="color:#666">Disabled (correct)</span>')
        : ind.fired >= 5 ? (parseFloat(ind.edge||0) > 3 ? '<span style="color:#00ff88">✅ Positive Edge</span>' : '<span style="color:#ffcc00">⚡ Neutral</span>')
        : '<span style="color:#666">Insufficient data</span>';
      return `<tr>
        <td><b style="color:${isDisabled?'#888':'#fff'}">${ind.indicator}</b>${isDisabled?' <span style="color:#666;font-size:10px">(disabled)</span>':''}</td>
        <td style="color:${wrColor};font-weight:bold">${ind.firedWR !== null ? ind.firedWR + '%' : 'N/A'}</td>
        <td style="color:#888">${ind.fired}</td>
        <td style="color:${edgeColor};font-weight:bold">${ind.edge !== null ? (ind.edge > 0 ? '+' : '') + ind.edge + 'pp' : 'N/A'}</td>
        <td>${status}</td>
      </tr>`;
    }).join('')}
    </tbody>
  </table>
</div>
<div>
  <p style="color:#888; font-size:11px; margin-bottom:8px;">Bear signal WR (short trades only)</p>
  <table>
    <thead><tr><th>Indicator</th><th>WR When Bear Fired</th><th>Times Fired</th></tr></thead>
    <tbody>
    ${bearIndicatorEdge.map(ind => {
      const wrColor = ind.firedWR === null ? '#888' : ind.firedWR >= 55 ? '#00ff88' : ind.firedWR >= 45 ? '#ffcc00' : '#ff4444';
      return `<tr>
        <td><b>${ind.indicator}</b></td>
        <td style="color:${wrColor};font-weight:bold">${ind.firedWR !== null ? ind.firedWR + '%' : 'N/A'}</td>
        <td style="color:#888">${ind.fired}</td>
      </tr>`;
    }).join('')}
    </tbody>
  </table>

  <div style="margin-top:14px; padding:10px; background:#0a0a1a; border:1px solid #223; border-radius:4px; font-size:11px;">
    <b style="color:#fff;">Hits Analysis (Post-Fix Wins)</b><br>
    <span style="color:#888">Total wins: ${hitsA.total_wins}</span><br>
    EMA in winning trades: <b style="color:${Math.round(100*(hitsA.ema_in_wins||0)/(hitsA.total_wins||1))>=80?'#00ff88':'#ffcc00'}">${totalWins > 0 ? Math.round(100*hitsA.ema_in_wins/totalWins) : 0}%</b> (target: >80%)<br>
    Ichimoku in winning trades: <b style="color:${Math.round(100*(hitsA.ichimoku_in_wins||0)/(hitsA.total_wins||1))>=70?'#00ff88':'#ffcc00'}">${totalWins > 0 ? Math.round(100*hitsA.ichimoku_in_wins/totalWins) : 0}%</b> (target: >70%)<br>
    MACD in winning trades: <b style="color:#88aaff">${totalWins > 0 ? Math.round(100*hitsA.macd_in_wins/totalWins) : 0}%</b>
  </div>
  ${regressionBugs > 0 ? `<div style="margin-top:10px; padding:10px; background:#2a0505; border:2px solid #ff4444; border-radius:4px; font-size:11px;">
    <b style="color:#ff4444;">⚠️ REGRESSION BUG DETECTED</b><br>
    ${regressionBugs} long trade(s) post-fix have disabled signals (RSI/BB/StochRSI bull) appearing in signal_snapshot.<br>
    <span style="color:#888">This may indicate a deployment regression — verify the engine code.</span>
  </div>` : `<div style="margin-top:10px; padding:8px; background:#051a0a; border:1px solid #00cc66; border-radius:4px; font-size:11px;">
    <b style="color:#00ff88;">✅ Regression Check Passed</b><br>
    No disabled signals (RSI/BB/StochRSI bull) found on post-fix long trades.
  </div>`}
</div>
</div>
</div>

<!-- ===================== SECTION 4B: CROSS-TF ALIGNMENT ===================== -->
<h2 class="section">🔀 Cross-TF Alignment Analysis</h2>
<div class="section-content">
${tfAlignmentAll[0] && parseInt(tfAlignmentAll[0].total_with_tf) > 0 ? `
<div class="two-col">
<div>
  <p style="color:#aaa; font-size:11px; margin-bottom:6px;">Alignment Score Distribution (${tfAlignmentAll[0].total_with_tf} trades with TF data)</p>
  <table>
    <thead><tr><th>Score</th><th>Trades (resolved)</th><th>WR</th></tr></thead>
    <tbody>
    ${tfAlignment.map(r => {
      const wrVal = parseFloat(r.wr || 0);
      const wrColor = wrVal >= 60 ? '#00ff88' : wrVal >= 45 ? '#ffcc00' : '#ff4444';
      return `<tr>
        <td><b style="color:#4488ff">${r.tf_alignment_score}</b></td>
        <td style="color:#888">${r.n} (${r.resolved})</td>
        <td style="color:${wrColor};font-weight:bold">${r.resolved > 0 ? r.wr + '%' : 'Pending'}</td>
      </tr>`;
    }).join('')}
    </tbody>
  </table>
</div>
<div>
  <p style="color:#aaa; font-size:11px; margin-bottom:6px;">4h Conflict Impact</p>
  <table>
    <thead><tr><th>4h Status</th><th>Trades</th><th>WR</th></tr></thead>
    <tbody>
    ${fourHConflict.map(r => {
      const wrVal = parseFloat(r.wr || 0);
      const wrColor = wrVal >= 55 ? '#00ff88' : wrVal >= 45 ? '#ffcc00' : '#ff4444';
      return `<tr>
        <td><b>${r.conflict}</b></td>
        <td style="color:#888">${r.resolved}</td>
        <td style="color:${wrColor};font-weight:bold">${r.resolved > 0 ? r.wr + '%' : 'Pending'}</td>
      </tr>`;
    }).join('')}
    </tbody>
  </table>
  ${fourHOpp && parseInt(fourHOpp.resolved) >= 30 && parseFloat(fourHOpp.wr) < 40
    ? `<div style="margin-top:8px; padding:8px; background:#2a0505; border:1px solid #ff4444; border-radius:4px; font-size:11px; color:#ff8888;">⚠️ 4h opposing WR below 40% on 30+ trades — <b>recommend upgrading to hard block</b></div>`
    : `<div style="margin-top:8px; padding:8px; background:#0a1a0a; border:1px solid #224; border-radius:4px; font-size:11px; color:#668;">Collecting data for hard block recommendation (need 30+ resolved 4h-opposing trades)</div>`}

  <p style="color:#aaa; font-size:11px; margin: 10px 0 6px;">TF Bear Count (Shorts)</p>
  <table>
    <thead><tr><th>Bear TFs</th><th>n (resolved)</th><th>WR</th></tr></thead>
    <tbody>
    ${tfBearCount.map(r => `<tr>
      <td style="color:#ff8888">${r.tf_bear_count}/5</td>
      <td style="color:#888">${r.n} (${r.resolved})</td>
      <td style="color:${parseFloat(r.wr||0)>=55?'#00ff88':parseFloat(r.wr||0)>=45?'#ffcc00':'#ff4444'};font-weight:bold">${r.resolved > 0 ? r.wr + '%' : '-'}</td>
    </tr>`).join('')}
    </tbody>
  </table>
</div>
</div>
` : `<p style="color:#666; font-style:italic; padding:12px;">No cross-TF alignment data logged yet (started March 19). Data will populate as trades come in with tf_alignment_score values.</p>`}
</div>

<!-- ===================== SECTION 4C: EXPERIMENTAL ===================== -->
<h2 class="section">🔬 Experimental Data Collection <span style="font-size:11px; color:#888; font-weight:normal">(NOT LIVE — Logging Only)</span></h2>
<div class="section-content">
<div class="exp-tag">⚗️ EXPERIMENTAL — Data collection only. These features are NOT active signals and do NOT affect trade execution or scoring.</div>

<div class="two-col">
<div>
  <b style="color:#aaa;">Market Structure (HH/HL Detection)</b><br>
  <span style="color:#666; font-size:11px;">Logging ${expDataCount[0]?.ms_count || 0} trades with market_structure data</span>
  ${marketStructure.length > 0 ? `
  <table style="margin-top:8px;">
    <thead><tr><th>Structure</th><th>Direction</th><th>n</th><th>WR</th></tr></thead>
    <tbody>
    ${marketStructure.map(r => `<tr>
      <td style="color:#88aaff">${r.structure || 'unknown'}</td>
      <td style="color:${r.direction==='long'?'#00ff88':'#ff8888'}">${r.direction}</td>
      <td style="color:#888">${r.resolved}/${r.n}</td>
      <td style="color:${parseFloat(r.wr||0)>=55?'#00ff88':parseFloat(r.wr||0)>=45?'#ffcc00':'#ff4444'}">${r.resolved > 0 ? r.wr + '%' : 'Pending'}</td>
    </tr>`).join('')}
    </tbody>
  </table>` : '<p style="color:#555; font-size:11px; margin-top:6px;">No market_structure data yet in signal_snapshot JSONB.</p>'}
  <p style="color:#555; font-size:10px; margin-top:6px;">Gate activation: 30+ trades with structure opposing direction AND WR &lt;40%</p>
</div>
<div>
  <b style="color:#aaa;">Funding Rate as Primary Signal</b><br>
  <span style="color:#666; font-size:11px;">Logging ${expDataCount[0]?.fr_count || 0} trades with funding_rate_score data</span>
  ${fundingRateData.length > 0 ? `
  <table style="margin-top:8px;">
    <thead><tr><th>FR Signal</th><th>Dir</th><th>n</th><th>WR</th><th>Avg Hyp Adj</th></tr></thead>
    <tbody>
    ${fundingRateData.map(r => `<tr>
      <td style="color:#aa88ff; font-size:10px">${r.signal || 'unknown'}</td>
      <td style="color:${r.direction==='long'?'#00ff88':'#ff8888'}">${r.direction}</td>
      <td style="color:#888">${r.resolved}/${r.n}</td>
      <td style="color:${parseFloat(r.wr||0)>=55?'#00ff88':parseFloat(r.wr||0)>=45?'#ffcc00':'#ff4444'}">${r.resolved > 0 ? r.wr + '%' : 'Pending'}</td>
      <td style="color:#888">${r.avg_hyp_adj || 'N/A'}pp</td>
    </tr>`).join('')}
    </tbody>
  </table>` : '<p style="color:#555; font-size:11px; margin-top:6px;">No funding_rate_score data yet in signal_snapshot JSONB.</p>'}
  <p style="color:#555; font-size:10px; margin-top:6px;">Gate activation: 50+ trades showing hypothetical adj improves calibration by >3pp</p>
</div>
</div>
</div>

<!-- ===================== SECTION 5: CALIBRATION ===================== -->
<h2 class="section">📐 Calibration Health</h2>
<div class="section-content">
<div class="two-col">
<div>
  <table>
    <thead><tr><th>Metric</th><th>Value</th><th>Target</th><th>Status</th></tr></thead>
    <tbody>
      <tr>
        <td>Avg Calibrated Prob</td>
        <td style="color:#fff;font-weight:bold">${calData.avg_calibrated}%</td>
        <td style="color:#666">—</td>
        <td>—</td>
      </tr>
      <tr>
        <td>Avg Raw Prob</td>
        <td style="color:#888">${calData.avg_raw}%</td>
        <td style="color:#666">—</td>
        <td>—</td>
      </tr>
      <tr>
        <td>Avg Inflation</td>
        <td style="color:${inflation<=3?'#00ff88':inflation<=8?'#ffcc00':'#ff4444'};font-weight:bold">+${inflation}pp</td>
        <td style="color:#666">&lt;3pp</td>
        <td style="color:${inflation<=3?'#00ff88':inflation<=8?'#ffcc00':'#ff4444'}">${inflation<=3?'✅ On target':inflation<=8?'⚠️ Elevated':'🔴 Critical'}</td>
      </tr>
      <tr>
        <td>Yesterday Inflation</td>
        <td style="color:#888">${inflationYesterday > 0 ? '+' + inflationYesterday + 'pp' : 'N/A'}</td>
        <td style="color:#666">—</td>
        <td style="color:${inflation > inflationYesterday ? '#ff4444' : '#00ff88'}">${inflation > inflationYesterday && inflationYesterday > 0 ? '📈 Increasing' : inflationYesterday > 0 ? '📉 Decreasing' : '—'}</td>
      </tr>
      <tr>
        <td>Baseline (pre-fix)</td>
        <td style="color:#666">+11pp</td>
        <td style="color:#666">&lt;3pp</td>
        <td style="color:#888">Reference</td>
      </tr>
    </tbody>
  </table>
</div>
<div>
  <p style="color:#aaa; font-size:12px; margin-bottom:6px;">Probability Bucket Accuracy (need 30+ for activation)</p>
  <table>
    <thead><tr><th>Bucket</th><th>Predicted</th><th>Actual WR</th><th>n</th><th>Accuracy</th></tr></thead>
    <tbody>
    ${calibBuckets.map(b => {
      const diff = b.actual_wr ? Math.round((parseFloat(b.actual_wr) - parseFloat(b.avg_prob)) * 10) / 10 : null;
      const diffColor = diff === null ? '#888' : Math.abs(diff) <= 5 ? '#00ff88' : Math.abs(diff) <= 10 ? '#ffcc00' : '#ff4444';
      const nInt = parseInt(b.n);
      return `<tr>
        <td style="color:#88aaff">${b.bucket}</td>
        <td style="color:#888">${b.avg_prob}%</td>
        <td style="color:${parseFloat(b.actual_wr||0)>=55?'#00ff88':'#ffcc00'};font-weight:bold">${b.actual_wr || 'N/A'}%</td>
        <td style="color:${nInt>=30?'#00ff88':nInt>=15?'#ffcc00':'#ff8800'}">${b.n} ${nInt < 30 ? '⚠️' : '✅'}</td>
        <td style="color:${diffColor}">${diff !== null ? (diff > 0 ? '+' : '') + diff + 'pp' : '—'}</td>
      </tr>`;
    }).join('')}
    </tbody>
  </table>

  <p style="color:#aaa; font-size:12px; margin: 10px 0 6px;">Confidence Level WR (Post-Fix)</p>
  <table>
    <thead><tr><th>Confidence</th><th>Resolved</th><th>WR</th><th>Status</th></tr></thead>
    <tbody>
    ${confidenceWR.map((c, i) => {
      const prevWR = i > 0 ? parseFloat(confidenceWR[i-1].wr || 0) : null;
      const curWR = parseFloat(c.wr || 0);
      const inverted = prevWR !== null && curWR > prevWR;
      return `<tr>
        <td style="color:#fff;font-weight:bold">${c.confidence}</td>
        <td style="color:#888">${c.resolved}</td>
        <td style="color:${curWR>=55?'#00ff88':curWR>=45?'#ffcc00':'#ff4444'};font-weight:bold">${c.wr || 'N/A'}%</td>
        <td>${inverted ? '<span style="color:#ff4444">⚠️ Inverted</span>' : '<span style="color:#00ff88">✅ Normal</span>'}</td>
      </tr>`;
    }).join('')}
    </tbody>
  </table>
</div>
</div>
</div>

<!-- ===================== SECTION 6: SCANNER HEALTH ===================== -->
<h2 class="section">🏥 Scanner Health</h2>
<div class="section-content">
${scannerErrors.length > 0 ? `
<table>
  <thead><tr><th>Timeframe</th><th>Created Today</th><th>Pending</th></tr></thead>
  <tbody>
  ${scannerErrors.map(r => `<tr>
    <td style="color:#88aaff;font-weight:bold">${r.timeframe}</td>
    <td style="color:#fff">${r.total_created_today}</td>
    <td style="color:#4488ff">${r.pending_today}</td>
  </tr>`).join('')}
  </tbody>
</table>` : `<p style="color:#666; font-style:italic;">No new trades created today (${REPORT_DATE}).</p>`}

<div style="margin-top:12px; padding:10px; background:#0a0a0a; border:1px solid #222; border-radius:4px;">
  <b style="color:#aaa; font-size:11px;">Recent Post-Fix Activity (last 10 trades)</b>
  <table style="margin-top:6px;">
    <thead><tr><th>ID</th><th>Asset</th><th>Dir</th><th>TF</th><th>Prob</th><th>Conf</th><th>MQ</th><th>Outcome</th><th>Created</th></tr></thead>
    <tbody>
    ${recentTrades.slice(0, 10).map(t => `<tr>
      <td style="color:#555">#${t.id}</td>
      <td style="color:#fff;font-weight:bold">${t.asset}</td>
      <td style="color:${t.direction==='long'?'#00ff88':'#ff8888'}">${t.direction}</td>
      <td style="color:#88aaff">${t.timeframe}</td>
      <td style="color:#fff">${t.probability}%</td>
      <td style="color:#888">${t.confidence}</td>
      <td style="color:#888">${t.market_quality}</td>
      <td style="color:${t.outcome==='win'?'#00ff88':t.outcome==='loss'?'#ff4444':'#888'}">${t.outcome || '⏳'}</td>
      <td style="color:#555; font-size:10px">${t.created_at ? new Date(t.created_at).toLocaleDateString('en-AU') : '-'}</td>
    </tr>`).join('')}
    </tbody>
  </table>
</div>
</div>

<!-- ===================== SECTION 7: COMPOUND TRACKER ===================== -->
<h2 class="section">📊 Compound Tracker (1% Per Day Target, $1,000 start from March 18)</h2>
<div class="section-content">
${compoundRows.length > 0 ? `
<table>
  <thead><tr><th>Date</th><th>Daily PnL</th><th>Wins</th><th>Losses</th><th>Hit 1% Target</th><th>Simulated Balance</th></tr></thead>
  <tbody>
  ${compoundRows.map(r => `<tr>
    <td style="color:#aaa">${r.day}</td>
    <td style="color:${r.pnl>0?'#00ff88':r.pnl<0?'#ff4444':'#888'};font-weight:bold">${r.pnl > 0 ? '+' : ''}${r.pnl}%</td>
    <td style="color:#00ff88">${r.wins}</td>
    <td style="color:#ff4444">${r.losses}</td>
    <td>${r.hitTarget ? '<span style="color:#00ff88">✅ Yes</span>' : '<span style="color:#ff4444">❌ No</span>'}</td>
    <td style="color:#fff;font-weight:bold">$${r.balance.toFixed(2)}</td>
  </tr>`).join('')}
  </tbody>
</table>
<div style="padding:10px; background:#0a1a0a; border:1px solid #226; border-radius:4px; font-size:12px; margin-top:8px;">
  <b>Current Balance:</b> <span style="color:${compoundRows[compoundRows.length-1]?.balance >= 1000 ? '#00ff88' : '#ff4444'}; font-size:16px;">$${(compoundRows[compoundRows.length-1]?.balance || 1000).toFixed(2)}</span>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <b>Total Return:</b> <span style="color:${compoundRows[compoundRows.length-1]?.balance >= 1000 ? '#00ff88' : '#ff4444'}">${(((compoundRows[compoundRows.length-1]?.balance || 1000) - 1000) / 10).toFixed(1)}%</span>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <b>Days with 1% target:</b> <span style="color:#fff">${compoundRows.filter(r => r.hitTarget).length} / ${compoundRows.length}</span>
</div>
` : '<p style="color:#666; font-style:italic;">No resolved trades with PnL data since March 18. Compound tracking will populate as trades resolve with PnL values.</p>'}
</div>

<!-- ===================== SECTION 8: AI REVIEW QUESTIONS ===================== -->
<h2 class="section">❓ AI Review Questions</h2>
<div style="background:#0d0d1f; border:1px solid #2233aa; border-radius:6px; padding:14px;">
  ${aiQuestions.map((q, i) => `<div class="question-item"><b style="color:#6688ff">Q${i+1}.</b> ${q}</div>`).join('')}
  <div style="margin-top:12px; padding:8px; background:#050510; border-radius:4px; font-size:11px; color:#556;">
    <b style="color:#668;">For AI Reviewers (ChatGPT/Grok/Claude):</b><br>
    • Baseline before March 18 fix: <b style="color:#888">55.41% WR</b><br>
    • Backtest prediction: <b style="color:#888">72.6% WR</b> on qualifying trades<br>
    • Major changes March 18: Momentum flip, RSI/BB/StochRSI bull disabled for longs, new weights (EMA=30, Ichi=25, MACD=18, Vol=15, RSI=7, StochRSI=3, BB=2)<br>
    • Cross-TF alignment logging started: March 19<br>
    • Market structure (HH/HL) + funding rate: EXPERIMENTAL, not live<br>
    • DOGE: Suspended — review for unban on/after March 25
  </div>
</div>

<hr>
<div style="text-align:center; color:#444; font-size:11px; margin-top:16px;">
  Generated ${new Date().toISOString()} &nbsp;|&nbsp; Ultimate Crypto Backtester Pro &nbsp;|&nbsp; Auto-generated daily report
</div>

</body>
</html>`;

  const reportPath = path.join(__dirname, `DAILY_REPORT_${REPORT_DATE}.html`);
  fs.writeFileSync(reportPath, html, 'utf8');
  console.log(`\nReport saved: ${reportPath}`);

  // Print top 3 findings
  console.log('\n========== TOP 3 FINDINGS ==========');
  const postFixResolved = parseInt(postFixData.wins||0) + parseInt(postFixData.losses||0);
  console.log(`1. Post-Fix WR: ${postFixData.wr}% (${postFixResolved} resolved, ${postFixData.pending} pending) — target: 72.6%`);
  console.log(`2. Calibration inflation: +${inflation}pp (yesterday: +${inflationYesterday}pp) — target: <3pp`);
  if (regressionBugs > 0) {
    console.log(`3. ⚠️ REGRESSION: ${regressionBugs} post-fix long trades have disabled signals (RSI/BB/StochRSI bull) still firing!`);
  } else if (criticalLossStreaks.length > 0) {
    console.log(`3. Loss streaks: ${criticalLossStreaks.map(s => `${s.asset} (${s.len})`).join(', ')} — consider action`);
  } else if (confInversion) {
    console.log(`3. Confidence inversion: Medium WR (${medConf?.wr}%) < Low WR (${lowConf?.wr}%) — calibration needs attention`);
  } else {
    console.log(`3. Overall WR: ${overallData.wr}% across ${overallData.total} trades (${overallData.pending} pending)`);
  }

  await pool.end();
}

generateReport().catch(err => {
  console.error('Fatal error:', err.message, err.stack);
  pool.end();
  process.exit(1);
});
