const { pool } = require('../db');
const { fetchKlines } = require('./binance');
const { computeSignal } = require('./indicators');
const fetch = require('node-fetch');

class PaperEngine {
  constructor() {
    this.strategies = new Map(); // id -> { config, interval }
    this.running = false;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    console.log('Paper trading engine starting...');
    // Load active strategies
    const result = await pool.query('SELECT id, config, user_id FROM paper_strategies WHERE active=TRUE');
    for (const row of result.rows) {
      this.addStrategy(row.id, row.config, row.user_id);
    }
    console.log(`Paper engine loaded ${result.rows.length} active strategies`);
  }

  addStrategy(id, config, userId) {
    if (this.strategies.has(id)) return;
    const interval = setInterval(() => this.poll(id), 60000);
    this.strategies.set(id, { config, userId, interval });
    // Initial poll
    setTimeout(() => this.poll(id), 5000);
  }

  removeStrategy(id) {
    const s = this.strategies.get(id);
    if (s) {
      clearInterval(s.interval);
      this.strategies.delete(id);
    }
  }

  async poll(id) {
    const entry = this.strategies.get(id);
    if (!entry) return;
    try {
      const { config, userId } = entry;
      const symbol = config.symbol || 'BTCUSDT';
      const tf = config.timeframe || '1h';

      // Fetch candles
      const candles = await fetchKlines(symbol, tf, 500);
      if (!candles || candles.length < 50) return;

      // Load current state
      const stateResult = await pool.query('SELECT state FROM paper_state WHERE strategy_id=$1', [id]);
      let state = stateResult.rows.length > 0 ? stateResult.rows[0].state : {
        equity: config.capital || 10000,
        capital: config.capital || 10000,
        positions: [],
        trades: [],
        equityCurve: [],
        lastProcessedBarTs: null
      };

      // Get last bar
      const bar = candles[candles.length - 2]; // use closed bar
      if (!bar || bar.t === state.lastProcessedBarTs) return; // already processed

      // Compute signals for each indicator
      const indicators = config.indicators || [];
      const signals = indicators.map(ind => {
        const sig = computeSignal(ind.id, candles, ind.params || {});
        return sig[sig.length - 2]; // signal for closed bar
      });

      // Combine signals (AND = all agree, OR = any)
      const logic = config.comboLogic || 'AND';
      let combinedSignal = 0;
      if (signals.length > 0) {
        if (logic === 'AND') {
          const allLong = signals.every(s => s > 0);
          const allShort = signals.every(s => s < 0);
          combinedSignal = allLong ? 1 : allShort ? -1 : 0;
        } else {
          const anyLong = signals.some(s => s > 0);
          const anyShort = signals.some(s => s < 0);
          combinedSignal = anyLong ? 1 : anyShort ? -1 : 0;
        }
      }

      const price = bar.c;
      const leverage = config.leverage || 1;
      const stopLoss = config.stopLoss || 0;
      const takeProfit = config.takeProfit || 0;
      const tradePct = config.tradePct || 100;

      // Process position exits
      if (state.positions.length > 0) {
        const pos = state.positions[0];
        let exitReason = null;

        // Check SL/TP
        if (stopLoss > 0) {
          const slPrice = pos.dir === 1
            ? pos.entry * (1 - stopLoss / 100 / leverage)
            : pos.entry * (1 + stopLoss / 100 / leverage);
          if ((pos.dir === 1 && price <= slPrice) || (pos.dir === -1 && price >= slPrice)) {
            exitReason = 'SL';
          }
        }
        if (takeProfit > 0 && !exitReason) {
          const tpPrice = pos.dir === 1
            ? pos.entry * (1 + takeProfit / 100 / leverage)
            : pos.entry * (1 - takeProfit / 100 / leverage);
          if ((pos.dir === 1 && price >= tpPrice) || (pos.dir === -1 && price <= tpPrice)) {
            exitReason = 'TP';
          }
        }
        // Signal reversal
        if (!exitReason && combinedSignal !== 0 && combinedSignal !== pos.dir) {
          exitReason = 'Signal';
        }

        if (exitReason) {
          const pnlPct = ((price - pos.entry) / pos.entry * pos.dir * leverage * 100);
          const pnl = pos.size * (pnlPct / 100);
          state.equity += pnl;
          state.trades.push({
            dir: pos.dir, entry: pos.entry, exit: price,
            pnl, pnlPct: pnlPct.toFixed(2), reason: exitReason, t: bar.t
          });
          state.positions = [];

          // Send Telegram if configured
          this.sendTelegramAlert(userId, `📊 ${symbol} ${pos.dir === 1 ? 'LONG' : 'SHORT'} closed @ ${price} | P&L: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%) | Reason: ${exitReason}`);
        }
      }

      // Process entries
      if (state.positions.length === 0 && combinedSignal !== 0) {
        const direction = config.direction || 'both';
        const allowEntry = direction === 'both' || (direction === 'long' && combinedSignal === 1) || (direction === 'short' && combinedSignal === -1);

        if (allowEntry) {
          const size = state.equity * (tradePct / 100);
          state.positions.push({
            dir: combinedSignal, entry: price, size, t: bar.t
          });
          this.sendTelegramAlert(userId, `🚀 ${symbol} ${combinedSignal === 1 ? 'LONG' : 'SHORT'} entry @ ${price} | Size: $${size.toFixed(2)} | Leverage: ${leverage}x`);
        }
      }

      // Mark-to-market
      let unrealized = 0;
      if (state.positions.length > 0) {
        const pos = state.positions[0];
        unrealized = pos.size * ((price - pos.entry) / pos.entry * pos.dir * leverage);
      }

      state.equityCurve.push({ t: bar.t, v: state.equity + unrealized });
      state.lastProcessedBarTs = bar.t;

      // Keep equity curve manageable (last 5000 points)
      if (state.equityCurve.length > 5000) {
        state.equityCurve = state.equityCurve.slice(-5000);
      }
      // Keep last 500 trades
      if (state.trades.length > 500) {
        state.trades = state.trades.slice(-500);
      }

      // Save state
      await pool.query(
        'INSERT INTO paper_state (strategy_id, state) VALUES ($1, $2) ON CONFLICT (strategy_id) DO UPDATE SET state=$2, updated_at=NOW()',
        [id, JSON.stringify(state)]
      );

    } catch (err) {
      console.error(`Paper engine poll error for ${id}:`, err.message);
    }
  }

  async sendTelegramAlert(userId, message) {
    try {
      const creds = await pool.query('SELECT token_encrypted, chat_id FROM telegram_creds WHERE user_id=$1', [userId]);
      if (creds.rows.length === 0) return;
      const { token_encrypted: token, chat_id: chatId } = creds.rows[0];
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
      });
    } catch (err) {
      // Telegram send failures are non-critical
    }
  }

  stop() {
    for (const [id, entry] of this.strategies) {
      clearInterval(entry.interval);
    }
    this.strategies.clear();
    this.running = false;
    console.log('Paper engine stopped');
  }
}

module.exports = new PaperEngine();
