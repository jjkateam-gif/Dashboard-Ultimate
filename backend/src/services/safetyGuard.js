const { pool } = require('../db');

class SafetyGuard {
  async canOpenPosition(userId, collateralUsd, leverage) {
    const config = await this.getConfig(userId);

    if (config.kill_switch) {
      throw new Error('KILL SWITCH ACTIVE - all trading halted');
    }

    const positionUsd = collateralUsd * leverage;
    if (positionUsd > config.max_position_usd) {
      throw new Error(`Position $${positionUsd.toFixed(2)} exceeds max $${config.max_position_usd}`);
    }
    if (leverage > config.max_leverage) {
      throw new Error(`Leverage ${leverage}x exceeds max ${config.max_leverage}x`);
    }

    // Check daily loss limit
    const todayPnl = await this.getTodayPnl(userId);
    if (todayPnl < 0 && Math.abs(todayPnl) >= config.daily_loss_limit_usd) {
      throw new Error(`Daily loss limit reached: -$${Math.abs(todayPnl).toFixed(2)} / $${config.daily_loss_limit_usd}`);
    }

    return true;
  }

  async shouldAutoClose(userId, position) {
    const config = await this.getConfig(userId);
    if (config.kill_switch) return { close: true, reason: 'KILL_SWITCH' };

    // Check proximity to liquidation
    if (position.liqPrice && position.markPrice && position.liqPrice > 0) {
      const distPct = Math.abs(position.markPrice - position.liqPrice) / position.markPrice * 100;
      if (distPct <= config.auto_close_liq_pct) {
        return { close: true, reason: `NEAR_LIQ_${distPct.toFixed(1)}pct` };
      }
    }

    return { close: false };
  }

  async getConfig(userId) {
    const result = await pool.query('SELECT * FROM live_safety_config WHERE user_id=$1', [userId]);
    if (result.rows.length > 0) return result.rows[0];
    return {
      max_position_usd: 500,
      max_leverage: 20,
      daily_loss_limit_usd: 100,
      auto_close_liq_pct: 5,
      kill_switch: false,
    };
  }

  async updateConfig(userId, updates) {
    const fields = [];
    const values = [userId];
    let idx = 2;

    if (updates.max_position_usd !== undefined) { fields.push(`max_position_usd=$${idx++}`); values.push(updates.max_position_usd); }
    if (updates.max_leverage !== undefined) { fields.push(`max_leverage=$${idx++}`); values.push(updates.max_leverage); }
    if (updates.daily_loss_limit_usd !== undefined) { fields.push(`daily_loss_limit_usd=$${idx++}`); values.push(updates.daily_loss_limit_usd); }
    if (updates.auto_close_liq_pct !== undefined) { fields.push(`auto_close_liq_pct=$${idx++}`); values.push(updates.auto_close_liq_pct); }

    if (fields.length === 0) return this.getConfig(userId);

    await pool.query(
      `INSERT INTO live_safety_config (user_id, ${fields.map(f => f.split('=')[0]).join(', ')})
       VALUES ($1, ${values.slice(1).map((_, i) => `$${i + 2}`).join(', ')})
       ON CONFLICT (user_id) DO UPDATE SET ${fields.join(', ')}, updated_at=NOW()`,
      values
    );
    return this.getConfig(userId);
  }

  async getTodayPnl(userId) {
    const result = await pool.query(
      "SELECT COALESCE(SUM(pnl), 0) as total FROM live_trade_history WHERE user_id=$1 AND closed_at >= CURRENT_DATE",
      [userId]
    );
    return parseFloat(result.rows[0].total);
  }

  async activateKillSwitch(userId) {
    await pool.query(
      'INSERT INTO live_safety_config (user_id, kill_switch) VALUES ($1, TRUE) ON CONFLICT (user_id) DO UPDATE SET kill_switch=TRUE, updated_at=NOW()',
      [userId]
    );
    return true;
  }

  async deactivateKillSwitch(userId) {
    await pool.query(
      'UPDATE live_safety_config SET kill_switch=FALSE, updated_at=NOW() WHERE user_id=$1',
      [userId]
    );
    return true;
  }
}

module.exports = new SafetyGuard();
