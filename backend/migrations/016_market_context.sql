-- Migration 016: Market context columns + nightly cache table
-- Adds macro market data, BTC context, session timing, portfolio state, expanded derivatives

-- ══════════════════════════════════════════════════════════════
-- A) New columns on best_trades_log for per-trade context
-- ══════════════════════════════════════════════════════════════

-- Fear & Greed
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS fear_greed_value INTEGER;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS fear_greed_label TEXT;

-- BTC context
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS btc_price DECIMAL(20,2);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS btc_trend TEXT;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS btc_rsi_1h DECIMAL(6,2);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS btc_rsi_4h DECIMAL(6,2);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS btc_ema_trend_1h TEXT;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS btc_ema_trend_4h TEXT;

-- Deribit DVOL
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS dvol DECIMAL(8,2);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS dvol_level TEXT;

-- CoinGecko global
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS btc_dominance DECIMAL(6,2);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS market_cap_change_24h DECIMAL(8,2);

-- Session timing (computed from created_at)
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS session_hour_utc INTEGER;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS trading_session TEXT;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS is_weekend BOOLEAN;

-- Portfolio state at entry
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS open_positions_count INTEGER;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS daily_pnl_pct DECIMAL(8,4);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS consecutive_losses_at_entry INTEGER;

-- Expanded derivatives
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS global_long_short_ratio DECIMAL(10,4);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS mark_price_premium DECIMAL(10,4);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS book_imbalance DECIMAL(10,4);

-- ══════════════════════════════════════════════════════════════
-- B) Nightly market cache table — daily snapshot of macro context
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS nightly_market_cache (
  id SERIAL PRIMARY KEY,
  cache_date DATE NOT NULL UNIQUE,
  fear_greed_value INTEGER,
  fear_greed_label TEXT,
  btc_price DECIMAL(20,2),
  btc_dominance DECIMAL(6,2),
  btc_trend TEXT,
  btc_rsi_1h DECIMAL(6,2),
  btc_rsi_4h DECIMAL(6,2),
  dvol DECIMAL(8,2),
  dvol_level TEXT,
  total_market_cap DECIMAL(20,0),
  total_volume_24h DECIMAL(20,0),
  market_cap_change_24h DECIMAL(8,2),
  eth_dominance DECIMAL(6,2),
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nightly_cache_date ON nightly_market_cache(cache_date);
