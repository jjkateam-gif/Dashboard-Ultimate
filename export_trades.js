const { Pool } = require('./backend/node_modules/pg');
const fs = require('fs');
const path = require('path');

const DATABASE_URL = 'postgresql://postgres:wRSDXXNuuEvJMttNrQaKDbWURHnVbckX@shortline.proxy.rlwy.net:43088/railway';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function exportTrades() {
  console.log('Connecting to database...');

  const { rows } = await pool.query(`
    SELECT
      id, asset, direction, timeframe,
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
      hits, misses,
      tf_alignment_score, tf_bear_count, tf_bull_count,
      highest_tf_conflict,
      bb_squeeze, volume_drying, macd_histogram_expanding,
      bb_position_pct, ichi_cloud_thickness_pct,
      candle_body_pct, candle_type, ema_spread_pct,
      pct_from_swing_high, pct_from_swing_low,
      bars_since_swing_high, bars_since_swing_low,
      nearest_round_pct, at_key_level,
      consecutive_bear_candles, consecutive_bull_candles,
      volume_increasing_3bar, volume_spike,
      oi_value, oi_change_pct_1h, oi_direction,
      taker_buy_ratio, taker_sell_ratio, taker_dominance,
      top_trader_long_ratio, top_trader_short_ratio, crowd_positioning,
      funding_rate_prev1, funding_rate_prev2, funding_rate_trend, funding_rate_3p_avg,
      hours_to_resolution, exit_reason,
      fear_greed_value, fear_greed_label, btc_price, btc_trend, btc_rsi_1h, btc_rsi_4h,
      btc_ema_trend_1h, btc_ema_trend_4h, dvol, dvol_level, btc_dominance, market_cap_change_24h,
      session_hour_utc, trading_session, is_weekend,
      open_positions_count, daily_pnl_pct, consecutive_losses_at_entry,
      global_long_short_ratio, mark_price_premium, book_imbalance
    FROM best_trades_log
    ORDER BY created_at DESC
  `);

  console.log(`Fetched ${rows.length} trades`);

  // CSV columns - all DB fields + expanded signal_snapshot + expanded hits/misses
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
    // Cross-TF columns
    'tf_alignment_score', 'tf_bear_count', 'tf_bull_count',
    'highest_tf_conflict',
    // signal_snapshot expanded — booleans
    'rsi_value', 'rsi_bull', 'rsi_bear',
    'ema_bull', 'ema_bear',
    'macd_bull', 'macd_bear',
    'stochrsi_bull', 'stochrsi_bear',
    'bb_bull', 'bb_bear', 'bb_squeeze',
    'ichimoku_bull', 'ichimoku_bear',
    'volume_bull', 'volume_bear', 'volume_drying',
    // signal_snapshot expanded — numeric indicator values
    'ema_fast_value', 'ema_slow_value', 'ema_spread_pct',
    'macd_line', 'macd_signal', 'macd_histogram', 'macd_histogram_prev',
    'stochrsi_k_value',
    'bb_upper', 'bb_lower', 'bb_middle', 'bb_position_pct', 'bb_width_pct', 'bb_bbwp',
    'ichi_tenkan', 'ichi_kijun', 'ichi_cloud_top', 'ichi_cloud_bottom',
    'ichi_cloud_thickness_pct', 'ichi_price_vs_cloud',
    'vol_ratio', 'vol_obv_slope', 'vol_body_ratio', 'vol_is_doji',
    // funding & patterns
    'funding_rate',
    'pattern_adj', 'pattern_composite',
    'chart_patterns',
    // hits/misses
    'hits_list', 'misses_list',
    // P1+P2 dedicated DB columns
    'db_bb_squeeze', 'db_volume_drying', 'db_macd_histogram_expanding',
    'db_bb_position_pct', 'db_ichi_cloud_thickness_pct',
    'db_candle_body_pct', 'db_candle_type', 'db_ema_spread_pct',
    // P4 dedicated DB columns
    'db_pct_from_swing_high', 'db_pct_from_swing_low',
    'db_bars_since_swing_high', 'db_bars_since_swing_low',
    'db_nearest_round_pct', 'db_at_key_level',
    'db_consecutive_bear_candles', 'db_consecutive_bull_candles',
    'db_volume_increasing_3bar', 'db_volume_spike',
    // P3 derivatives columns
    'oi_value', 'oi_change_pct_1h', 'oi_direction',
    'taker_buy_ratio', 'taker_sell_ratio', 'taker_dominance',
    'top_trader_long_ratio', 'top_trader_short_ratio', 'crowd_positioning',
    'funding_rate_prev1', 'funding_rate_prev2', 'funding_rate_trend', 'funding_rate_3p_avg',
    // P5 execution intelligence
    'hours_to_resolution', 'exit_reason',
    // Market context
    'fear_greed_value', 'fear_greed_label', 'btc_price', 'btc_trend', 'btc_rsi_1h', 'btc_rsi_4h',
    'btc_ema_trend_1h', 'btc_ema_trend_4h', 'dvol', 'dvol_level', 'btc_dominance', 'market_cap_change_24h',
    // Session timing
    'session_hour_utc', 'trading_session', 'is_weekend',
    // Portfolio state
    'open_positions_count', 'daily_pnl_pct', 'consecutive_losses_at_entry',
    // Expanded derivatives
    'global_long_short_ratio', 'mark_price_premium', 'book_imbalance',
  ];

  function escapeCSV(val) {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  function formatPatterns(patterns) {
    if (!patterns || !Array.isArray(patterns)) return '';
    return patterns.map(p => `${p.name}(${p.direction}/${p.stage}:${p.score})`).join(' | ');
  }

  const csvRows = [csvHeaders.join(',')];

  let hasSnapshot = 0;
  let missingSnapshot = 0;

  for (const row of rows) {
    const snap = row.signal_snapshot || {};
    if (row.signal_snapshot) hasSnapshot++; else missingSnapshot++;

    const values = [
      row.id,
      row.asset,
      row.direction,
      row.timeframe,
      row.probability,
      row.raw_probability,
      row.confidence,
      row.market_quality,
      row.regime,
      row.outcome,
      row.pnl,
      row.entry_price,
      row.stop_price,
      row.target_price,
      row.stop_pct,
      row.target_pct,
      row.rr_ratio,
      row.ev,
      row.optimal_lev,
      row.atr_value,
      row.volume_ratio,
      row.confluence_score,
      row.executed,
      row.order_id,
      row.created_at ? new Date(row.created_at).toISOString() : '',
      row.resolved_at ? new Date(row.resolved_at).toISOString() : '',
      row.last_seen_at ? new Date(row.last_seen_at).toISOString() : '',
      row.scan_count,
      // Cross-TF columns
      row.tf_alignment_score,
      row.tf_bear_count,
      row.tf_bull_count,
      row.highest_tf_conflict,
      // signal_snapshot expanded — booleans
      snap.RSI?.value ?? '',
      snap.RSI?.bull ?? '',
      snap.RSI?.bear ?? '',
      snap.EMA?.bull ?? '',
      snap.EMA?.bear ?? '',
      snap.MACD?.bull ?? '',
      snap.MACD?.bear ?? '',
      snap.StochRSI?.bull ?? '',
      snap.StochRSI?.bear ?? '',
      snap.BB?.bull ?? '',
      snap.BB?.bear ?? '',
      snap.BB?.squeeze ?? '',
      snap.Ichimoku?.bull ?? '',
      snap.Ichimoku?.bear ?? '',
      snap.Volume?.bull ?? '',
      snap.Volume?.bear ?? '',
      snap.Volume?.drying ?? '',
      // signal_snapshot expanded — numeric indicator values
      snap.EMA?.fastValue ?? '',
      snap.EMA?.slowValue ?? '',
      snap.EMA?.spreadPct ?? '',
      snap.MACD?.line ?? '',
      snap.MACD?.signal ?? '',
      snap.MACD?.histogram ?? '',
      snap.MACD?.histogramPrev ?? '',
      snap.StochRSI?.kValue ?? '',
      snap.BB?.upper ?? '',
      snap.BB?.lower ?? '',
      snap.BB?.middle ?? '',
      snap.BB?.positionPct ?? '',
      snap.BB?.widthPct ?? '',
      snap.BB?.bbwp ?? '',
      snap.Ichimoku?.tenkan ?? '',
      snap.Ichimoku?.kijun ?? '',
      snap.Ichimoku?.cloudTop ?? '',
      snap.Ichimoku?.cloudBottom ?? '',
      snap.Ichimoku?.cloudThicknessPct ?? '',
      snap.Ichimoku?.priceVsCloud ?? '',
      snap.Volume?.ratio ?? '',
      snap.Volume?.obvSlope ?? '',
      snap.Volume?.bodyRatio ?? '',
      snap.Volume?.isDoji ?? '',
      // funding & patterns
      snap.fundingRate ?? '',
      snap.patternAdj ?? '',
      snap.patternComposite ?? '',
      formatPatterns(snap.chartPatterns),
      // hits/misses
      row.hits ? (Array.isArray(row.hits) ? row.hits.join('; ') : JSON.stringify(row.hits)) : '',
      row.misses ? (Array.isArray(row.misses) ? row.misses.join('; ') : JSON.stringify(row.misses)) : '',
      // P1+P2 dedicated DB columns
      row.bb_squeeze ?? '',
      row.volume_drying ?? '',
      row.macd_histogram_expanding ?? '',
      row.bb_position_pct ?? '',
      row.ichi_cloud_thickness_pct ?? '',
      row.candle_body_pct ?? '',
      row.candle_type ?? '',
      row.ema_spread_pct ?? '',
      // P4 dedicated DB columns
      row.pct_from_swing_high ?? '',
      row.pct_from_swing_low ?? '',
      row.bars_since_swing_high ?? '',
      row.bars_since_swing_low ?? '',
      row.nearest_round_pct ?? '',
      row.at_key_level ?? '',
      row.consecutive_bear_candles ?? '',
      row.consecutive_bull_candles ?? '',
      row.volume_increasing_3bar ?? '',
      row.volume_spike ?? '',
      // P3 derivatives columns
      row.oi_value ?? '',
      row.oi_change_pct_1h ?? '',
      row.oi_direction ?? '',
      row.taker_buy_ratio ?? '',
      row.taker_sell_ratio ?? '',
      row.taker_dominance ?? '',
      row.top_trader_long_ratio ?? '',
      row.top_trader_short_ratio ?? '',
      row.crowd_positioning ?? '',
      row.funding_rate_prev1 ?? '',
      row.funding_rate_prev2 ?? '',
      row.funding_rate_trend ?? '',
      row.funding_rate_3p_avg ?? '',
      // P5 execution intelligence
      row.hours_to_resolution ?? '',
      row.exit_reason ?? '',
      // Market context
      row.fear_greed_value ?? '',
      row.fear_greed_label ?? '',
      row.btc_price ?? '',
      row.btc_trend ?? '',
      row.btc_rsi_1h ?? '',
      row.btc_rsi_4h ?? '',
      row.btc_ema_trend_1h ?? '',
      row.btc_ema_trend_4h ?? '',
      row.dvol ?? '',
      row.dvol_level ?? '',
      row.btc_dominance ?? '',
      row.market_cap_change_24h ?? '',
      // Session timing
      row.session_hour_utc ?? '',
      row.trading_session ?? '',
      row.is_weekend ?? '',
      // Portfolio state
      row.open_positions_count ?? '',
      row.daily_pnl_pct ?? '',
      row.consecutive_losses_at_entry ?? '',
      // Expanded derivatives
      row.global_long_short_ratio ?? '',
      row.mark_price_premium ?? '',
      row.book_imbalance ?? '',
    ];

    csvRows.push(values.map(escapeCSV).join(','));
  }

  const csvContent = csvRows.join('\n');
  const outputPath = path.join(__dirname, 'FULL_TRADE_LOG.csv');
  fs.writeFileSync(outputPath, csvContent, 'utf8');
  console.log(`\nCSV exported to: ${outputPath}`);
  console.log(`Total trades: ${rows.length}`);
  console.log(`With signal snapshot: ${hasSnapshot}`);
  console.log(`Missing signal snapshot: ${missingSnapshot}`);

  // Print first 5 rows as sample
  console.log('\n========== FIRST 5 ROWS (SAMPLE) ==========');
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const r = rows[i];
    const snap = r.signal_snapshot || {};
    console.log(`\n--- Trade #${r.id} ---`);
    console.log(`  Asset: ${r.asset} | Dir: ${r.direction} | TF: ${r.timeframe}`);
    console.log(`  Prob: ${r.probability} | Raw: ${r.raw_probability} | Conf: ${r.confidence} | MQ: ${r.market_quality} | Regime: ${r.regime}`);
    console.log(`  Outcome: ${r.outcome} | PnL: ${r.pnl}`);
    console.log(`  Entry: ${r.entry_price} | Stop: ${r.stop_price} | Target: ${r.target_price}`);
    console.log(`  Stop%: ${r.stop_pct} | Target%: ${r.target_pct} | RR: ${r.rr_ratio} | EV: ${r.ev}`);
    console.log(`  OptLev: ${r.optimal_lev} | ATR: ${r.atr_value} | VolRatio: ${r.volume_ratio} | Confluence: ${r.confluence_score}`);
    console.log(`  Created: ${r.created_at} | Resolved: ${r.resolved_at}`);
    console.log(`  ScanCount: ${r.scan_count} | Executed: ${r.executed}`);
    console.log(`  RSI: ${snap.RSI?.value} (bull:${snap.RSI?.bull} bear:${snap.RSI?.bear})`);
    console.log(`  EMA: bull:${snap.EMA?.bull} bear:${snap.EMA?.bear}`);
    console.log(`  MACD: bull:${snap.MACD?.bull} bear:${snap.MACD?.bear}`);
    console.log(`  StochRSI: bull:${snap.StochRSI?.bull} bear:${snap.StochRSI?.bear}`);
    console.log(`  BB: bull:${snap.BB?.bull} bear:${snap.BB?.bear}`);
    console.log(`  Ichimoku: bull:${snap.Ichimoku?.bull} bear:${snap.Ichimoku?.bear}`);
    console.log(`  Volume: bull:${snap.Volume?.bull} bear:${snap.Volume?.bear}`);
    console.log(`  FundingRate: ${snap.fundingRate}`);
    console.log(`  PatternAdj: ${snap.patternAdj} | PatternComposite: ${snap.patternComposite}`);
    if (snap.chartPatterns) {
      console.log(`  ChartPatterns: ${formatPatterns(snap.chartPatterns)}`);
    }
    console.log(`  Hits: ${r.hits ? (Array.isArray(r.hits) ? r.hits.join(', ') : JSON.stringify(r.hits)) : 'N/A'}`);
    console.log(`  Misses: ${r.misses ? (Array.isArray(r.misses) ? r.misses.join(', ') : JSON.stringify(r.misses)) : 'N/A'}`);
  }

  // Find specific example trades
  console.log('\n\n========== SPECIFIC EXAMPLE TRADES ==========');

  // Winning WIF trade
  const wifWin = rows.find(r => r.asset === 'WIF' && r.outcome === 'win');
  // Losing AVAX trade
  const avaxLoss = rows.find(r => r.asset === 'AVAX' && r.outcome === 'loss');
  // Losing DOGE trade
  const dogeLoss = rows.find(r => r.asset === 'DOGE' && r.outcome === 'loss');

  const examples = [
    { label: 'WINNING WIF TRADE', trade: wifWin },
    { label: 'LOSING AVAX TRADE', trade: avaxLoss },
    { label: 'LOSING DOGE TRADE', trade: dogeLoss }
  ];

  for (const { label, trade: r } of examples) {
    console.log(`\n===== ${label} =====`);
    if (!r) { console.log('  NOT FOUND'); continue; }
    const snap = r.signal_snapshot || {};
    console.log(`  ID: ${r.id}`);
    console.log(`  Asset: ${r.asset} | Dir: ${r.direction} | TF: ${r.timeframe}`);
    console.log(`  Prob: ${r.probability} | Raw: ${r.raw_probability}`);
    console.log(`  Confidence: ${r.confidence} | MarketQuality: ${r.market_quality} | Regime: ${r.regime}`);
    console.log(`  Outcome: ${r.outcome} | PnL: ${r.pnl}`);
    console.log(`  Entry: ${r.entry_price} | Stop: ${r.stop_price} | Target: ${r.target_price}`);
    console.log(`  Stop%: ${r.stop_pct} | Target%: ${r.target_pct} | RR: ${r.rr_ratio}`);
    console.log(`  EV: ${r.ev} | OptimalLev: ${r.optimal_lev}`);
    console.log(`  ATR: ${r.atr_value} | VolumeRatio: ${r.volume_ratio} | Confluence: ${r.confluence_score}`);
    console.log(`  Created: ${r.created_at} | Resolved: ${r.resolved_at}`);
    console.log(`  ScanCount: ${r.scan_count} | Executed: ${r.executed} | OrderID: ${r.order_id}`);
    console.log(`  --- INDICATORS ---`);
    console.log(`  RSI value: ${snap.RSI?.value}`);
    console.log(`  RSI bull: ${snap.RSI?.bull} | RSI bear: ${snap.RSI?.bear}`);
    console.log(`  EMA bull: ${snap.EMA?.bull} | EMA bear: ${snap.EMA?.bear}`);
    console.log(`  MACD bull: ${snap.MACD?.bull} | MACD bear: ${snap.MACD?.bear}`);
    console.log(`  StochRSI bull: ${snap.StochRSI?.bull} | StochRSI bear: ${snap.StochRSI?.bear}`);
    console.log(`  BB bull: ${snap.BB?.bull} | BB bear: ${snap.BB?.bear}`);
    console.log(`  Ichimoku bull: ${snap.Ichimoku?.bull} | Ichimoku bear: ${snap.Ichimoku?.bear}`);
    console.log(`  Volume bull: ${snap.Volume?.bull} | Volume bear: ${snap.Volume?.bear}`);
    console.log(`  Funding Rate: ${snap.fundingRate}`);
    console.log(`  Pattern Adj: ${snap.patternAdj}`);
    console.log(`  Pattern Composite: ${snap.patternComposite}`);
    if (snap.chartPatterns && snap.chartPatterns.length > 0) {
      console.log(`  --- CHART PATTERNS ---`);
      for (const p of snap.chartPatterns) {
        console.log(`    ${p.name}: dir=${p.direction} stage=${p.stage} score=${p.score} type=${p.type} baseWinRate=${p.baseWinRate}`);
      }
    }
    console.log(`  Hits: ${r.hits ? (Array.isArray(r.hits) ? r.hits.join(', ') : JSON.stringify(r.hits)) : 'N/A'}`);
    console.log(`  Misses: ${r.misses ? (Array.isArray(r.misses) ? r.misses.join(', ') : JSON.stringify(r.misses)) : 'N/A'}`);
  }

  pool.end();
}

exportTrades().catch(err => {
  console.error('Error:', err.message);
  pool.end();
  process.exit(1);
});
