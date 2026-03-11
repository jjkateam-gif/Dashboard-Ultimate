-- Trading wallets (one per user, separate from browser wallet)
CREATE TABLE IF NOT EXISTS trading_wallets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  public_key VARCHAR(64) NOT NULL,
  encrypted_data TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Live strategies (mirrors paper_strategies with protocol choice)
CREATE TABLE IF NOT EXISTS live_strategies (
  id VARCHAR(64) PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  config JSONB NOT NULL,
  protocol VARCHAR(20) NOT NULL DEFAULT 'jupiter',
  active BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Live positions (currently open on-chain)
CREATE TABLE IF NOT EXISTS live_positions (
  id SERIAL PRIMARY KEY,
  strategy_id VARCHAR(64) REFERENCES live_strategies(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  protocol VARCHAR(20) NOT NULL,
  market VARCHAR(20) NOT NULL,
  direction VARCHAR(5) NOT NULL,
  entry_price NUMERIC NOT NULL,
  size_usd NUMERIC NOT NULL,
  collateral_usd NUMERIC NOT NULL,
  leverage NUMERIC NOT NULL DEFAULT 1,
  open_tx VARCHAR(128),
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  exit_price NUMERIC,
  close_tx VARCHAR(128),
  pnl NUMERIC,
  close_reason VARCHAR(20),
  sl_price NUMERIC,
  tp_price NUMERIC,
  liq_price NUMERIC
);

-- Trade history (immutable log of all live trades)
CREATE TABLE IF NOT EXISTS live_trade_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  strategy_id VARCHAR(64),
  protocol VARCHAR(20) NOT NULL,
  market VARCHAR(20) NOT NULL,
  direction VARCHAR(5) NOT NULL,
  entry_price NUMERIC,
  exit_price NUMERIC,
  size_usd NUMERIC,
  collateral_usd NUMERIC,
  leverage NUMERIC,
  pnl NUMERIC,
  pnl_pct NUMERIC,
  open_tx VARCHAR(128),
  close_tx VARCHAR(128),
  close_reason VARCHAR(20),
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Safety limits per user
CREATE TABLE IF NOT EXISTS live_safety_config (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  max_position_usd NUMERIC DEFAULT 500,
  max_leverage INTEGER DEFAULT 10,
  daily_loss_limit_usd NUMERIC DEFAULT 100,
  auto_close_liq_pct NUMERIC DEFAULT 5,
  kill_switch BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_live_strategies_user ON live_strategies(user_id);
CREATE INDEX IF NOT EXISTS idx_live_positions_user ON live_positions(user_id);
CREATE INDEX IF NOT EXISTS idx_live_positions_open ON live_positions(closed_at) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_live_trade_history_user ON live_trade_history(user_id);
