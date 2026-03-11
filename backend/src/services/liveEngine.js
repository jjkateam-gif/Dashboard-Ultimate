const { pool } = require('../db');
const { fetchKlines } = require('./binance');
const { computeSignal } = require('./indicators');
const { keypairFromSecret } = require('./solanaRpc');
const jupiterAdapter = require('./adapters/jupiterAdapter');
const safetyGuard = require('./safetyGuard');
const fetch = require('node-fetch');
const crypto = require('crypto');

class LiveEngine {
  constructor() {
    this.strategies = new Map(); // id -> { config, userId, protocol, interval }
    this.walletKeys = new Map(); // userId -> keypair
    this.running = false;
  }

  /* ── adapter resolution ─────────────────────────────────── */

  getAdapter(protocol) {
    if (protocol === 'drift') return require('./adapters/driftAdapter');
    return jupiterAdapter;
  }

  /* ── wallet management ──────────────────────────────────── */

  async unlockWallet(userId, password) {
    const result = await pool.query(
      'SELECT encrypted_data FROM trading_wallets WHERE user_id=$1',
      [userId]
    );
    if (result.rows.length === 0) throw new Error('No trading wallet found');

    const envelope = JSON.parse(result.rows[0].encrypted_data);
    const salt = Buffer.from(envelope.salt, 'hex');
    const iv = Buffer.from(envelope.iv, 'hex');
    const tag = Buffer.from(envelope.tag, 'hex');
    const ciphertext = Buffer.from(envelope.data, 'hex');

    const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    const secretBytes = JSON.parse(decrypted.toString('utf8'));
    const keypair = keypairFromSecret(secretBytes);
    this.walletKeys.set(userId, keypair);

    console.log(`[LiveEngine] Wallet unlocked for user ${userId} (${keypair.publicKey.toBase58().slice(0, 8)}...)`);

    // Start any active strategies for this user
    const strats = await pool.query(
      'SELECT id, config, protocol FROM live_strategies WHERE user_id=$1 AND active=TRUE',
      [userId]
    );
    for (const row of strats.rows) {
      this.addStrategy(row.id, row.config, userId, row.protocol);
    }

    return keypair.publicKey.toBase58();
  }

  lockWallet(userId) {
    // Remove all strategies for this user
    for (const [id, entry] of this.strategies) {
      if (entry.userId === userId) {
        clearInterval(entry.interval);
        this.strategies.delete(id);
      }
    }
    this.walletKeys.delete(userId);
    console.log(`[LiveEngine] Wallet locked for user ${userId}`);
  }

  isWalletUnlocked(userId) {
    return this.walletKeys.has(userId);
  }

  getWalletPublicKey(userId) {
    const kp = this.walletKeys.get(userId);
    return kp ? kp.publicKey.toBase58() : null;
  }

  /* ── engine lifecycle ───────────────────────────────────── */

  start() {
    if (this.running) return;
    this.running = true;
    console.log('[LiveEngine] Live trading engine started');
  }

  stop() {
    for (const [id, entry] of this.strategies) {
      clearInterval(entry.interval);
    }
    this.strategies.clear();
    this.walletKeys.clear();
    this.running = false;
    console.log('[LiveEngine] Live trading engine stopped');
  }

  /* ── strategy management ────────────────────────────────── */

  addStrategy(id, config, userId, protocol) {
    if (this.strategies.has(id)) return;
    if (!this.walletKeys.has(userId)) {
      console.warn(`[LiveEngine] Cannot add strategy ${id}: wallet not unlocked for user ${userId}`);
      return;
    }
    const interval = setInterval(() => this.poll(id), 60000);
    this.strategies.set(id, { config, userId, protocol: protocol || 'jupiter', interval });
    // Initial poll after a short delay
    setTimeout(() => this.poll(id), 5000);
    console.log(`[LiveEngine] Strategy ${id} added (${protocol || 'jupiter'})`);
  }

  removeStrategy(id) {
    const s = this.strategies.get(id);
    if (s) {
      clearInterval(s.interval);
      this.strategies.delete(id);
      console.log(`[LiveEngine] Strategy ${id} removed`);
    }
  }

  /* ── main poll loop ─────────────────────────────────────── */

  async poll(id) {
    const entry = this.strategies.get(id);
    if (!entry) return;
    try {
      const { config, userId, protocol } = entry;
      const keypair = this.walletKeys.get(userId);
      if (!keypair) return;

      const adapter = this.getAdapter(protocol);
      const symbol = config.symbol || 'BTCUSDT';
      const tf = config.timeframe || '1h';
      const market = this._mkt(symbol, protocol);

      // Fetch candles
      const candles = await fetchKlines(symbol, tf, 500);
      if (!candles || candles.length < 50) return;

      // Use the last closed bar
      const bar = candles[candles.length - 2];
      if (!bar) return;

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

      // ── Check for open position in DB ────────────────────
      const posResult = await pool.query(
        'SELECT * FROM live_positions WHERE strategy_id=$1 AND closed_at IS NULL LIMIT 1',
        [id]
      );
      const openPos = posResult.rows.length > 0 ? posResult.rows[0] : null;

      // ── Process exits ────────────────────────────────────
      if (openPos) {
        const dir = openPos.direction === 'long' ? 1 : -1;
        let exitReason = null;

        // Safety guard check (near liquidation, kill switch)
        const safetyCheck = await safetyGuard.shouldAutoClose(userId, {
          liqPrice: parseFloat(openPos.liq_price) || 0,
          markPrice: price,
        });
        if (safetyCheck.close) {
          exitReason = safetyCheck.reason;
        }

        // Check SL
        if (stopLoss > 0 && !exitReason) {
          const slPrice = dir === 1
            ? parseFloat(openPos.entry_price) * (1 - stopLoss / 100 / leverage)
            : parseFloat(openPos.entry_price) * (1 + stopLoss / 100 / leverage);
          if ((dir === 1 && price <= slPrice) || (dir === -1 && price >= slPrice)) {
            exitReason = 'SL';
          }
        }

        // Check TP
        if (takeProfit > 0 && !exitReason) {
          const tpPrice = dir === 1
            ? parseFloat(openPos.entry_price) * (1 + takeProfit / 100 / leverage)
            : parseFloat(openPos.entry_price) * (1 - takeProfit / 100 / leverage);
          if ((dir === 1 && price >= tpPrice) || (dir === -1 && price <= tpPrice)) {
            exitReason = 'TP';
          }
        }

        // Signal reversal
        if (!exitReason && combinedSignal !== 0 && combinedSignal !== dir) {
          exitReason = 'Signal';
        }

        if (exitReason) {
          try {
            const closeResult = await adapter.closePosition({
              keypair,
              market,
              direction: openPos.direction,
            });

            const entryPrice = parseFloat(openPos.entry_price);
            const sizeUsd = parseFloat(openPos.size_usd);
            const pnlPct = ((price - entryPrice) / entryPrice) * dir * leverage * 100;
            const pnl = sizeUsd * (pnlPct / 100);

            // Update position as closed
            await pool.query(
              `UPDATE live_positions
               SET closed_at=NOW(), exit_price=$1, close_tx=$2, pnl=$3, close_reason=$4
               WHERE id=$5`,
              [price, closeResult.txSignature || null, pnl, exitReason, openPos.id]
            );

            // Insert into trade history
            await pool.query(
              `INSERT INTO live_trade_history
               (user_id, strategy_id, protocol, market, direction, entry_price, exit_price,
                size_usd, collateral_usd, leverage, pnl, pnl_pct, open_tx, close_tx,
                close_reason, opened_at, closed_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())`,
              [
                userId, id, protocol, market, openPos.direction,
                entryPrice, price, sizeUsd, parseFloat(openPos.collateral_usd),
                leverage, pnl, pnlPct,
                openPos.open_tx, closeResult.txSignature || null,
                exitReason, openPos.opened_at,
              ]
            );

            const dirLabel = dir === 1 ? 'LONG' : 'SHORT';
            this._alert(userId,
              `${symbol} ${dirLabel} closed @ ${price} | P&L: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%) | Reason: ${exitReason} | Tx: ${(closeResult.txSignature || '').slice(0, 16)}...`
            );

            console.log(`[LiveEngine] Closed ${dirLabel} ${market} | PnL: ${pnl.toFixed(2)} | Reason: ${exitReason}`);
          } catch (closeErr) {
            console.error(`[LiveEngine] Close position error for ${id}:`, closeErr.message);
            this._alert(userId, `CLOSE FAILED for ${symbol}: ${closeErr.message}`);
          }
        }
      }

      // ── Process entries ──────────────────────────────────
      // Re-check for open position (may have just been closed)
      const openCheck = await pool.query(
        'SELECT id FROM live_positions WHERE strategy_id=$1 AND closed_at IS NULL LIMIT 1',
        [id]
      );
      const hasOpenPos = openCheck.rows.length > 0;

      if (!hasOpenPos && combinedSignal !== 0) {
        const direction = config.direction || 'both';
        const allowEntry =
          direction === 'both' ||
          (direction === 'long' && combinedSignal === 1) ||
          (direction === 'short' && combinedSignal === -1);

        if (allowEntry) {
          // Determine collateral from USDC balance and trade %
          const balance = await adapter.getBalance(keypair.publicKey.toBase58());
          const availableUsd = balance.usdc || 0;
          const desiredCollateral = (config.capital || availableUsd) * (tradePct / 100);
          const collateralUsd = Math.min(desiredCollateral, availableUsd);

          if (collateralUsd < 1) {
            console.warn(`[LiveEngine] Insufficient USDC balance for strategy ${id}: $${availableUsd.toFixed(2)}`);
            return;
          }

          // Safety guard check before opening
          try {
            await safetyGuard.canOpenPosition(userId, collateralUsd, leverage);
          } catch (safetyErr) {
            console.warn(`[LiveEngine] Safety guard blocked entry for ${id}: ${safetyErr.message}`);
            this._alert(userId, `ENTRY BLOCKED for ${symbol}: ${safetyErr.message}`);
            return;
          }

          const dirStr = combinedSignal === 1 ? 'long' : 'short';
          const sizeUsd = collateralUsd * leverage;

          // Compute SL/TP prices for the adapter
          let slPrice = null;
          let tpPrice = null;
          if (stopLoss > 0) {
            slPrice = combinedSignal === 1
              ? price * (1 - stopLoss / 100 / leverage)
              : price * (1 + stopLoss / 100 / leverage);
          }
          if (takeProfit > 0) {
            tpPrice = combinedSignal === 1
              ? price * (1 + takeProfit / 100 / leverage)
              : price * (1 - takeProfit / 100 / leverage);
          }

          try {
            const openResult = await adapter.openPosition({
              keypair,
              market,
              direction: dirStr,
              collateralUsd,
              leverage,
              slPrice,
              tpPrice,
            });

            // Record position in DB
            await pool.query(
              `INSERT INTO live_positions
               (strategy_id, user_id, protocol, market, direction, entry_price,
                size_usd, collateral_usd, leverage, open_tx, sl_price, tp_price)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
              [
                id, userId, protocol, market, dirStr, price,
                sizeUsd, collateralUsd, leverage,
                openResult.txSignature || null, slPrice, tpPrice,
              ]
            );

            const dirLabel = combinedSignal === 1 ? 'LONG' : 'SHORT';
            this._alert(userId,
              `${symbol} ${dirLabel} entry @ ${price} | Size: $${sizeUsd.toFixed(2)} | Collateral: $${collateralUsd.toFixed(2)} | Leverage: ${leverage}x | Tx: ${(openResult.txSignature || '').slice(0, 16)}...`
            );

            console.log(`[LiveEngine] Opened ${dirLabel} ${market} | Size: $${sizeUsd.toFixed(2)} | Lev: ${leverage}x`);
          } catch (openErr) {
            console.error(`[LiveEngine] Open position error for ${id}:`, openErr.message);
            this._alert(userId, `ENTRY FAILED for ${symbol}: ${openErr.message}`);
          }
        }
      }

    } catch (err) {
      console.error(`[LiveEngine] Poll error for ${id}:`, err.message);
    }
  }

  /* ── helpers ────────────────────────────────────────────── */

  /**
   * Convert Binance-style symbol to protocol-specific market name.
   * BTCUSDT -> BTC-PERP (drift) or BTC-USD (jupiter)
   */
  _mkt(sym, proto) {
    const base = sym.replace(/USDT$/i, '').replace(/USD$/i, '');
    if (proto === 'drift') return `${base}-PERP`;
    return `${base}-USD`;
  }

  /**
   * Send a Telegram notification to the user.
   */
  async _alert(userId, msg) {
    try {
      const creds = await pool.query(
        'SELECT token_encrypted, chat_id FROM telegram_creds WHERE user_id=$1',
        [userId]
      );
      if (creds.rows.length === 0) return;
      const { token_encrypted: token, chat_id: chatId } = creds.rows[0];
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' }),
      });
    } catch (err) {
      // Telegram failures are non-critical
    }
  }

  /* ── kill switch ────────────────────────────────────────── */

  async killSwitch(userId) {
    console.log(`[LiveEngine] KILL SWITCH activated for user ${userId}`);
    const keypair = this.walletKeys.get(userId);

    // Close all open positions for this user
    const openPositions = await pool.query(
      'SELECT * FROM live_positions WHERE user_id=$1 AND closed_at IS NULL',
      [userId]
    );

    for (const pos of openPositions.rows) {
      try {
        const adapter = this.getAdapter(pos.protocol);
        if (keypair) {
          const closeResult = await adapter.closePosition({
            keypair,
            market: pos.market,
            direction: pos.direction,
          });

          await pool.query(
            `UPDATE live_positions
             SET closed_at=NOW(), close_tx=$1, close_reason='KILL_SWITCH'
             WHERE id=$2`,
            [closeResult.txSignature || null, pos.id]
          );

          // Record in trade history
          await pool.query(
            `INSERT INTO live_trade_history
             (user_id, strategy_id, protocol, market, direction, entry_price,
              size_usd, collateral_usd, leverage, open_tx, close_tx,
              close_reason, opened_at, closed_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'KILL_SWITCH',$12,NOW())`,
            [
              userId, pos.strategy_id, pos.protocol, pos.market, pos.direction,
              pos.entry_price, pos.size_usd, pos.collateral_usd, pos.leverage,
              pos.open_tx, closeResult.txSignature || null, pos.opened_at,
            ]
          );
        } else {
          // No keypair available; mark position as closed anyway
          await pool.query(
            `UPDATE live_positions
             SET closed_at=NOW(), close_reason='KILL_SWITCH'
             WHERE id=$1`,
            [pos.id]
          );
        }
      } catch (err) {
        console.error(`[LiveEngine] Kill switch close error for position ${pos.id}:`, err.message);
        // Mark as closed even on failure so strategies don't keep trying
        await pool.query(
          `UPDATE live_positions
           SET closed_at=NOW(), close_reason='KILL_SWITCH_ERR'
           WHERE id=$1`,
          [pos.id]
        );
      }
    }

    // Deactivate all live strategies for this user
    await pool.query(
      'UPDATE live_strategies SET active=FALSE WHERE user_id=$1',
      [userId]
    );

    // Remove running strategies from the engine
    for (const [id, entry] of this.strategies) {
      if (entry.userId === userId) {
        clearInterval(entry.interval);
        this.strategies.delete(id);
      }
    }

    // Activate the kill switch flag in safety config
    await safetyGuard.activateKillSwitch(userId);

    this._alert(userId, 'KILL SWITCH ACTIVATED - All positions closed, all strategies deactivated.');
    console.log(`[LiveEngine] Kill switch complete for user ${userId}: ${openPositions.rows.length} positions closed`);
  }
}

module.exports = new LiveEngine();
