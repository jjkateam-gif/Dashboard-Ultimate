-- Best Trades server-side scanner settings (survives Railway deploys)
CREATE TABLE IF NOT EXISTS best_trades_settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  enabled BOOLEAN NOT NULL DEFAULT false,
  mode VARCHAR(10) NOT NULL DEFAULT 'confirm',  -- 'confirm' or 'auto'
  timeframe VARCHAR(10) NOT NULL DEFAULT '4h',
  min_prob INTEGER NOT NULL DEFAULT 70,
  trade_size_usd DECIMAL(10,2) NOT NULL DEFAULT 100,
  max_open INTEGER NOT NULL DEFAULT 3,
  leverage INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT single_row_bt CHECK (id = 1)
);

INSERT INTO best_trades_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- Log server-side Best Trades scan results
CREATE TABLE IF NOT EXISTS best_trades_log (
  id SERIAL PRIMARY KEY,
  asset VARCHAR(20) NOT NULL,
  direction VARCHAR(10) NOT NULL,
  probability INTEGER NOT NULL,
  confidence VARCHAR(10),
  market_quality VARCHAR(10),
  rr_ratio DECIMAL(5,1),
  entry_price DECIMAL(20,8),
  stop_price DECIMAL(20,8),
  target_price DECIMAL(20,8),
  stop_pct DECIMAL(5,2),
  target_pct DECIMAL(5,2),
  regime VARCHAR(30),
  executed BOOLEAN DEFAULT false,
  order_id VARCHAR(100),
  outcome VARCHAR(10),
  pnl DECIMAL(10,4),
  resolved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bt_log_created ON best_trades_log(created_at);
CREATE INDEX IF NOT EXISTS idx_bt_log_executed ON best_trades_log(executed);
