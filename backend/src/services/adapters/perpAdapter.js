/**
 * Abstract PerpAdapter - unified interface for perp DEX protocols.
 * Both Jupiter and Drift adapters implement this interface.
 */
class PerpAdapter {
  constructor(name) {
    this.name = name;
  }

  /** List available perpetual markets */
  async getMarkets() {
    throw new Error(`${this.name}: getMarkets() not implemented`);
  }

  /**
   * Open a perpetual position
   * @param {Object} params
   * @param {Keypair} params.keypair - Solana keypair for signing
   * @param {string} params.market - Market name (e.g. 'BTC-USD' or 'BTC-PERP')
   * @param {string} params.direction - 'long' or 'short'
   * @param {number} params.collateralUsd - Collateral amount in USD
   * @param {number} params.leverage - Leverage multiplier
   * @param {number} [params.slPrice] - Optional stop-loss price
   * @param {number} [params.tpPrice] - Optional take-profit price
   * @returns {{ txSignature: string, protocol: string }}
   */
  async openPosition(params) {
    throw new Error(`${this.name}: openPosition() not implemented`);
  }

  /**
   * Close a perpetual position
   * @param {Object} params
   * @param {Keypair} params.keypair - Solana keypair for signing
   * @param {string} params.market - Market name
   * @param {string} params.direction - 'long' or 'short'
   * @returns {{ txSignature: string }}
   */
  async closePosition(params) {
    throw new Error(`${this.name}: closePosition() not implemented`);
  }

  /** Get all open positions for a wallet */
  async getPositions(publicKey) {
    throw new Error(`${this.name}: getPositions() not implemented`);
  }

  /** Get wallet balance (collateral) */
  async getBalance(publicKey) {
    throw new Error(`${this.name}: getBalance() not implemented`);
  }

  /** Get current funding rate for a market */
  async getFundingRate(market) {
    throw new Error(`${this.name}: getFundingRate() not implemented`);
  }

  /** Estimate liquidation price for a position */
  async getLiquidationPrice(position) {
    const liqPct = 0.9 / (position.leverage || 1);
    return position.direction === 'long'
      ? position.entryPrice * (1 - liqPct)
      : position.entryPrice * (1 + liqPct);
  }
}

module.exports = PerpAdapter;
