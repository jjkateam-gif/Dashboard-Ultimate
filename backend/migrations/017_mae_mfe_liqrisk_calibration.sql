-- Migration 017: MAE/MFE tracking, liquidation risk per trade, calibration persistence
-- Plus missing columns that were being written by INSERT but never formally migrated

-- ══════════════════════════════════════════════════════════════
-- A) MAE/MFE (Max Adverse/Favorable Excursion) on resolution
-- ══════════════════════════════════════════════════════════════
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS mae_pct DECIMAL(10,4);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS mfe_pct DECIMAL(10,4);

-- ══════════════════════════════════════════════════════════════
-- B) Liquidation risk score at entry
-- ══════════════════════════════════════════════════════════════
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS liq_risk_score INTEGER;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS liq_risk_level TEXT;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS liq_risk_components JSONB;

-- ══════════════════════════════════════════════════════════════
-- C) Missing P1-P4 columns (written by scanner but never formally migrated)
-- ══════════════════════════════════════════════════════════════

-- Cross-TF alignment
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS tf_bear_count INTEGER;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS tf_bull_count INTEGER;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS tf_alignment_score DECIMAL(5,2);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS highest_tf_conflict TEXT;

-- P1+P2 indicator enrichment
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS bb_squeeze BOOLEAN;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS volume_drying BOOLEAN;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS macd_histogram_expanding BOOLEAN;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS bb_position_pct DECIMAL(10,4);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS ichi_cloud_thickness_pct DECIMAL(10,4);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS candle_body_pct DECIMAL(10,4);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS candle_type TEXT;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS ema_spread_pct DECIMAL(10,4);

-- P4 swing/level/pattern enrichment
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS pct_from_swing_high DECIMAL(10,4);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS pct_from_swing_low DECIMAL(10,4);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS bars_since_swing_high INTEGER;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS bars_since_swing_low INTEGER;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS nearest_round_pct DECIMAL(10,4);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS at_key_level BOOLEAN;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS consecutive_bear_candles INTEGER;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS consecutive_bull_candles INTEGER;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS volume_increasing_3bar BOOLEAN;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS volume_spike BOOLEAN;

-- P3 derivatives
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS oi_value DECIMAL(20,4);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS oi_change_pct_1h DECIMAL(10,4);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS oi_direction TEXT;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS taker_buy_ratio DECIMAL(10,4);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS taker_sell_ratio DECIMAL(10,4);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS taker_dominance TEXT;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS top_trader_long_ratio DECIMAL(10,4);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS top_trader_short_ratio DECIMAL(10,4);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS crowd_positioning TEXT;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS funding_rate_prev1 DECIMAL(12,8);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS funding_rate_prev2 DECIMAL(12,8);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS funding_rate_trend TEXT;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS funding_rate_3p_avg DECIMAL(12,8);

-- P5 execution intelligence
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS hours_to_resolution DECIMAL(10,2);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS exit_reason TEXT;

-- ══════════════════════════════════════════════════════════════
-- D) Calibration history table — snapshots of model accuracy over time
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS calibration_history (
  id SERIAL PRIMARY KEY,
  snapshot_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_resolved INTEGER,
  overall_win_rate DECIMAL(6,4),
  avg_calibration_error DECIMAL(6,4),
  kelly_graduation DECIMAL(6,4),
  sharpe_ratio DECIMAL(8,4),
  per_trade_sharpe DECIMAL(8,4),
  drawdown_pct DECIMAL(6,2),
  consecutive_losses INTEGER,
  phase INTEGER,
  prob_buckets JSONB,
  regime_tf JSONB,
  quality_grades JSONB,
  confidence_levels JSONB,
  extra_data JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_calibration_date ON calibration_history(snapshot_date);
