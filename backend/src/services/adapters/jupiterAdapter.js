const PerpAdapter = require('./perpAdapter');
const fetch = require('node-fetch');
const { connection, VersionedTransaction } = require('../solanaRpc');

const PERPS_API = 'https://perps-api.jup.ag/v1';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const MARKETS = {
  'SOL-USD': { marketIndex: 0, symbol: 'SOLUSDT', maxLev: 100 },
  'BTC-USD': { marketIndex: 1, symbol: 'BTCUSDT', maxLev: 100 },
  'ETH-USD': { marketIndex: 2, symbol: 'ETHUSDT', maxLev: 100 },
};

class JupiterAdapter extends PerpAdapter {
  constructor() {
    super('jupiter');
  }

  async getMarkets() {
    return Object.entries(MARKETS).map(([name, m]) => ({
      name,
      symbol: m.symbol,
      maxLeverage: m.maxLev,
      protocol: 'jupiter',
    }));
  }

  async openPosition({ keypair, market, direction, collateralUsd, leverage, slPrice, tpPrice }) {
    const collateralLamports = Math.round(collateralUsd * 1e6); // USDC 6 decimals
    const body = {
      walletAddress: keypair.publicKey.toBase58(),
      market,
      side: direction,
      collateralMint: USDC_MINT,
      collateralAmount: collateralLamports,
      leverage,
      slippage: 0.5,
    };
    if (slPrice) body.stopLossPrice = slPrice;
    if (tpPrice) body.takeProfitPrice = tpPrice;

    // Try increase-position first, then open-position as fallback
    let apiData;
    const endpoints = ['increase-position', 'open-position'];
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(`${PERPS_API}/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          apiData = await res.json();
          break;
        }
      } catch (err) {
        console.error(`[Jupiter] ${endpoint} failed:`, err.message);
      }
    }
    if (!apiData) throw new Error('Jupiter Perps API: all endpoints failed');
    if (apiData.error) throw new Error('Jupiter Perps: ' + apiData.error);

    const txBase64 = apiData.transaction || apiData.tx || apiData.serializedTransaction;
    if (!txBase64) throw new Error('No transaction returned from Jupiter Perps');

    // Deserialize, sign, send
    const txBytes = Buffer.from(txBase64, 'base64');
    const vtx = VersionedTransaction.deserialize(txBytes);
    vtx.sign([keypair]);
    const rawTx = vtx.serialize();
    const sig = await connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      maxRetries: 3,
    });
    await connection.confirmTransaction(sig, 'confirmed');

    console.log(`[Jupiter] Opened ${direction} ${market} | Collateral: $${collateralUsd} | Lev: ${leverage}x | Tx: ${sig}`);
    return { txSignature: sig, protocol: 'jupiter' };
  }

  async closePosition({ keypair, market, direction }) {
    const body = {
      walletAddress: keypair.publicKey.toBase58(),
      market,
      side: direction,
    };

    const endpoints = ['close-position', 'decrease-position'];
    let apiData;
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(`${PERPS_API}/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          apiData = await res.json();
          break;
        }
      } catch (err) {
        console.error(`[Jupiter] ${endpoint} failed:`, err.message);
      }
    }
    if (!apiData) throw new Error('Jupiter close-position: all endpoints failed');

    const txBase64 = apiData.transaction || apiData.tx || apiData.serializedTransaction;
    if (!txBase64) throw new Error('No close transaction returned');

    const txBytes = Buffer.from(txBase64, 'base64');
    const vtx = VersionedTransaction.deserialize(txBytes);
    vtx.sign([keypair]);
    const rawTx = vtx.serialize();
    const sig = await connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      maxRetries: 3,
    });
    await connection.confirmTransaction(sig, 'confirmed');

    console.log(`[Jupiter] Closed ${direction} ${market} | Tx: ${sig}`);
    return { txSignature: sig };
  }

  async getPositions(publicKey) {
    try {
      const res = await fetch(`${PERPS_API}/positions?walletAddress=${publicKey}`);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.positions || data || []).map(p => ({
        market: p.market || p.marketName,
        direction: p.side || p.direction,
        size: p.sizeUsd || p.size,
        collateral: p.collateralUsd || p.collateral,
        leverage: p.leverage,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice,
        pnl: p.pnl || p.unrealizedPnl,
        liquidationPrice: p.liquidationPrice,
        protocol: 'jupiter',
      }));
    } catch {
      return [];
    }
  }

  async getBalance(publicKey) {
    const { getSolBalance, getTokenBalance, USDC_MINT } = require('../solanaRpc');
    const sol = await getSolBalance(publicKey);
    const usdc = await getTokenBalance(publicKey, USDC_MINT);
    return { sol, usdc, protocol: 'jupiter' };
  }

  async getFundingRate(market) {
    try {
      const res = await fetch(`${PERPS_API}/funding-rate?market=${market}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.fundingRate || data.rate || null;
    } catch {
      return null;
    }
  }
}

module.exports = new JupiterAdapter();
