const fetch = require('node-fetch');
const crypto = require('crypto');

const DEMO_BASE = 'https://demo-trading-openapi.blofin.com';
const LIVE_BASE = 'https://openapi.blofin.com';
const API_TIMEOUT_MS = 15000; // 15s timeout for all BloFin API calls

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeout));
}

// BloFin broker ID — CCXT's registered broker ID (required for CCXT-bound API keys)
const BROKER_ID = process.env.BLOFIN_BROKER_ID || 'ec6dd3a7dd982d0b';

function getBaseUrl(demo) {
  return demo ? DEMO_BASE : LIVE_BASE;
}

/* ── Rate limiter (token bucket) ─────────────────────────────── */
const bucket = { tokens: 500, last: Date.now(), max: 500, refillMs: 60000 };
const tradeBucket = { tokens: 30, last: Date.now(), max: 30, refillMs: 10000 };

function consumeToken(b) {
  const now = Date.now();
  const elapsed = now - b.last;
  b.tokens = Math.min(b.max, b.tokens + (elapsed / b.refillMs) * b.max);
  b.last = now;
  if (b.tokens < 1) throw new Error('Rate limit exceeded — try again shortly');
  b.tokens--;
}

/* ── Auth helpers ─────────────────────────────────────────────── */

function sign(method, requestPath, body, timestamp, nonce, secretKey) {
  const bodyStr = body ? JSON.stringify(body) : '';
  const prehash = requestPath + method.toUpperCase() + timestamp + nonce + bodyStr;
  const hmac = crypto.createHmac('sha256', secretKey).update(prehash).digest('hex');
  return Buffer.from(hmac).toString('base64');
}

function authHeaders(method, requestPath, body, creds) {
  const timestamp = String(Date.now());  // BloFin expects milliseconds
  const nonce = crypto.randomUUID();     // BloFin expects UUID format
  const signature = sign(method, requestPath, body, timestamp, nonce, creds.secretKey);
  return {
    'ACCESS-KEY': creds.apiKey,
    'ACCESS-SIGN': signature,
    'ACCESS-TIMESTAMP': timestamp,
    'ACCESS-NONCE': nonce,
    'ACCESS-PASSPHRASE': creds.passphrase,
    'Content-Type': 'application/json',
  };
}

/* ── Generic REST helpers ────────────────────────────────────── */

async function publicGet(path, params, demo) {
  consumeToken(bucket);
  const baseUrl = getBaseUrl(demo);
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const url = baseUrl + path + qs;
  const res = await fetchWithTimeout(url, { headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`BloFin API ${path}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== '0') throw new Error(`BloFin ${path}: ${json.msg || json.code}`);
  return json.data;
}

async function privateGet(path, params, creds, demo) {
  consumeToken(bucket);
  const baseUrl = getBaseUrl(demo);
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const requestPath = path + qs;
  const headers = authHeaders('GET', requestPath, null, creds);
  const res = await fetchWithTimeout(baseUrl + requestPath, { headers });
  if (!res.ok) throw new Error(`BloFin API ${path}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== '0') throw new Error(`BloFin ${path}: ${json.msg || json.code}`);
  return json.data;
}

async function privatePost(path, body, creds, isTrading = false, demo) {
  consumeToken(isTrading ? tradeBucket : bucket);
  const baseUrl = getBaseUrl(demo);
  const headers = authHeaders('POST', path, body, creds);
  const res = await fetchWithTimeout(baseUrl + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BloFin API ${path}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== '0') {
    // BloFin returns per-order errors in data array — extract the specific message
    let detail = json.msg || json.code;
    if (Array.isArray(json.data) && json.data[0] && json.data[0].msg) {
      detail += ' → ' + json.data[0].msg;
      if (json.data[0].code) detail += ' (code: ' + json.data[0].code + ')';
    }
    console.error(`[BloFin] POST ${path} failed:`, JSON.stringify(json));
    throw new Error(`BloFin ${path}: ${detail}`);
  }
  return json.data;
}

/* ── Market Data (Public) ────────────────────────────────────── */

async function getMarkets(demo) {
  const data = await publicGet('/api/v1/market/instruments', { instType: 'SWAP' }, demo);
  return (data || []).map(inst => ({
    name: inst.instId,           // e.g. 'BTC-USDT'
    symbol: inst.instId.replace('-', ''),
    maxLeverage: parseInt(inst.maxLever) || 100,
    minSize: inst.minSize || '1',
    lotSize: inst.lotSize || inst.minSize || '1',
    tickSize: inst.tickSize,
    contractValue: inst.contractValue,
    protocol: 'blofin',
  }));
}

async function getTicker(instId, demo) {
  const data = await publicGet('/api/v1/market/tickers', { instId }, demo);
  return data && data[0] ? {
    instId: data[0].instId,
    last: parseFloat(data[0].last),
    bid: parseFloat(data[0].bidPrice),
    ask: parseFloat(data[0].askPrice),
    high24h: parseFloat(data[0].high24h),
    low24h: parseFloat(data[0].low24h),
    volume24h: parseFloat(data[0].volCurrency24h),
    timestamp: data[0].ts,
  } : null;
}

async function getCandles(instId, bar, limit, demo) {
  return publicGet('/api/v1/market/candles', { instId, bar, limit: limit || '100' }, demo);
}

async function getFundingRate(instId, demo) {
  const data = await publicGet('/api/v1/market/funding-rate', { instId }, demo);
  return data && data[0] ? {
    instId: data[0].instId,
    fundingRate: parseFloat(data[0].fundingRate),
    nextFundingTime: data[0].nextFundingTime,
  } : null;
}

async function getMarkPrice(instId, demo) {
  const data = await publicGet('/api/v1/market/mark-price', { instId, instType: 'SWAP' }, demo);
  return data && data[0] ? parseFloat(data[0].markPrice) : null;
}

/* ── Account (Private) ───────────────────────────────────────── */

async function getBalance(creds, demo) {
  const data = await privateGet('/api/v1/account/balance', null, creds, demo);
  console.log('[BloFin] Raw balance response (FULL):', JSON.stringify(data).slice(0, 2000));

  // BloFin may return array or single object
  if (!data) return { usdt: 0, locked: false };

  // Handle both array and single object responses
  const acct = Array.isArray(data) ? data[0] : data;
  if (!acct) return { usdt: 0, locked: false };

  // Log ALL top-level account fields so we can see exactly what BloFin sends
  console.log('[BloFin] Account-level keys:', Object.keys(acct));
  console.log('[BloFin] Account-level values:', JSON.stringify(acct, null, 2).slice(0, 1000));

  const usdtDetail = (acct.details || []).find(d => d.currency === 'USDT' || d.ccy === 'USDT');

  if (usdtDetail) {
    console.log('[BloFin] USDT detail keys:', Object.keys(usdtDetail));
    console.log('[BloFin] USDT detail values:', JSON.stringify(usdtDetail, null, 2));
  } else {
    console.log('[BloFin] No USDT detail found in details array. Details:', JSON.stringify(acct.details).slice(0, 500));
  }

  // ── Parse with comprehensive field name coverage ──
  // BloFin API docs field names can vary across versions:
  //   Account level: totalEquity, availableBalance, availBal, availEq
  //   Detail level: available, availBal, availEq, cashBal, balance, equity, eq

  // Total equity (how much the account is worth)
  const totalEq = parseFloat(acct.totalEquity || acct.totalEq || 0) || 0;

  // Available balance — try account level first (more reliable), then detail level
  const acctAvail = parseFloat(acct.availableBalance || acct.availBal || acct.availEq || 0) || 0;
  const detailAvail = usdtDetail ? parseFloat(
    usdtDetail.availableBalance || usdtDetail.available || usdtDetail.availBal ||
    usdtDetail.availEq || usdtDetail.cashBal || 0
  ) || 0 : 0;
  // Use whichever is non-zero; prefer account-level
  const availBal = acctAvail > 0 ? acctAvail : detailAvail > 0 ? detailAvail : totalEq;

  // USDT balance (total including locked)
  const detailBal = usdtDetail ? parseFloat(
    usdtDetail.balance || usdtDetail.equity || usdtDetail.eq ||
    usdtDetail.cashBal || 0
  ) || 0 : 0;
  const usdtBal = detailBal > 0 ? detailBal : totalEq;

  // Frozen/locked in positions
  const frozen = usdtDetail ? parseFloat(
    usdtDetail.frozen || usdtDetail.frozenBalance || usdtDetail.frozenBal || 0
  ) || 0 : 0;

  console.log('[BloFin] FINAL Parsed — totalEq:', totalEq, 'acctAvail:', acctAvail, 'detailAvail:', detailAvail, 'availBal:', availBal, 'usdtBal:', usdtBal);

  return {
    totalEquity: totalEq,
    availableBalance: availBal,
    usdt: usdtBal,
    frozenBalance: frozen,
    locked: false,
    _debug: {
      acctAvail,
      detailAvail,
      detailBal,
      totalEq,
      acctKeys: Object.keys(acct),
      detailKeys: usdtDetail ? Object.keys(usdtDetail) : [],
    }
  };
}

// Fetch Funding account balance (separate from Trading account)
// BloFin has: Trading Account (for futures) and Funding Account (deposit/withdraw)
async function getFundingBalance(creds, demo) {
  try {
    const data = await privateGet('/api/v1/asset/balances', null, creds, demo);
    console.log('[BloFin] Funding balance response:', JSON.stringify(data).slice(0, 500));
    if (!data) return { usdt: 0 };
    const arr = Array.isArray(data) ? data : [data];
    const usdtEntry = arr.find(d => d.currency === 'USDT' || d.ccy === 'USDT');
    return {
      usdt: parseFloat(usdtEntry?.balance || usdtEntry?.available || usdtEntry?.availBal || 0) || 0,
      available: parseFloat(usdtEntry?.available || usdtEntry?.availBal || usdtEntry?.balance || 0) || 0,
    };
  } catch (e) {
    console.warn('[BloFin] Funding balance fetch failed (may not be supported):', e.message);
    return { usdt: 0, available: 0 };
  }
}

async function getPositions(creds, demo) {
  const data = await privateGet('/api/v1/account/positions', null, creds, demo);
  return (data || []).map(p => ({
    instId: p.instId,
    market: p.instId,
    direction: p.positionSide === 'long' ? 'long' : 'short',
    size: parseFloat(p.positions) || 0,
    sizeUsd: parseFloat(p.notionalUsd) || 0,
    collateral: parseFloat(p.margin) || 0,
    leverage: parseFloat(p.leverage) || 1,
    entryPrice: parseFloat(p.averagePrice) || 0,
    markPrice: parseFloat(p.markPrice) || 0,
    pnl: parseFloat(p.unrealizedPnl) || 0,
    liquidationPrice: parseFloat(p.liquidationPrice) || 0,
    marginMode: p.marginMode || 'cross',
    protocol: 'blofin',
  }));
}

/* ── Trading (Private) ───────────────────────────────────────── */

async function setLeverage(creds, instId, lever, marginMode, demo, positionSide) {
  const body = {
    instId,
    leverage: String(lever),     // BloFin expects 'leverage' not 'lever'
    marginMode: marginMode || 'cross',
  };
  // In hedge mode, must specify positionSide ('long' or 'short')
  if (positionSide) body.positionSide = positionSide;
  return privatePost('/api/v1/account/set-leverage', body, creds, false, demo);
}

async function setMarginMode(creds, instId, marginMode, demo) {
  return privatePost('/api/v1/account/set-margin-mode', {
    instId,
    marginMode, // 'cross' or 'isolated'
  }, creds, false, demo);
}

async function setPositionMode(creds, positionMode, demo) {
  return privatePost('/api/v1/account/set-position-mode', {
    positionMode, // 'long_short_mode' (hedge) or 'net_mode' (one-way)
  }, creds, false, demo);
}

async function openPosition({ creds, instId, direction, size, leverage, orderType, price, tpPrice, slPrice, marginMode, demo }) {
  const mode = marginMode || 'cross';

  // Ensure hedge mode is enabled (required for positionSide: long/short)
  try {
    await setPositionMode(creds, 'long_short_mode', demo);
  } catch (e) {
    // May already be set — non-fatal
    console.warn(`[BloFin] setPositionMode warning: ${e.message}`);
  }

  // Set leverage for the specific position side (required in hedge mode)
  try {
    await setLeverage(creds, instId, leverage, mode, demo, direction);
    console.log(`[BloFin] Leverage set to ${leverage}x for ${instId} ${direction}`);
  } catch (e) {
    // Log but continue — leverage may already be at the desired level
    console.warn(`[BloFin] setLeverage warning: ${e.message}`);
  }

  // Place the order
  const side = direction === 'long' ? 'buy' : 'sell';
  const body = {
    instId,
    marginMode: mode,       // BloFin requires 'marginMode' not 'tradeMode'
    side,
    orderType: orderType || 'market',
    size: String(size),     // Number of contracts
    positionSide: direction, // 'long' or 'short' for hedge mode
  };
  // Only include brokerId if we actually have one (Transaction keys reject empty brokerId)
  const bid = creds.brokerId || BROKER_ID;
  if (bid) body.brokerId = bid;
  if (orderType === 'limit' && price) {
    body.price = String(price);
  }

  const orderData = await privatePost('/api/v1/trade/order', body, creds, true, demo);
  const orderId = orderData && orderData[0] ? orderData[0].orderId : (orderData?.orderId || null);

  // Set TP/SL if provided
  if ((tpPrice || slPrice) && orderId) {
    try {
      const closeSide = direction === 'long' ? 'sell' : 'buy';
      const tpslBody = {
        instId,
        marginMode: mode,
        positionSide: direction,
        side: closeSide,
        size: String(size),       // same size as the order
      };
      const tpslBid = creds.brokerId || BROKER_ID;
      if (tpslBid) tpslBody.brokerId = tpslBid;
      if (tpPrice) {
        tpslBody.tpTriggerPrice = String(tpPrice);
        tpslBody.tpOrderPrice = '-1'; // market price
      }
      if (slPrice) {
        tpslBody.slTriggerPrice = String(slPrice);
        tpslBody.slOrderPrice = '-1'; // market price
      }
      const tpslResult = await privatePost('/api/v1/trade/order-tpsl', tpslBody, creds, true, demo);
      console.log(`[BloFin] TP/SL set for ${instId}:`, JSON.stringify(tpslResult));
    } catch (e) {
      console.error(`[BloFin] ❌ TP/SL FAILED for ${instId}: ${e.message} — CLOSING position to prevent unprotected trade`);
      // TP/SL failed — close the position immediately to prevent naked exposure
      try {
        await closePosition({ creds, instId, direction, marginMode: mode, demo });
        console.log(`[BloFin] Position closed after TP/SL failure for ${instId}`);
      } catch (closeErr) {
        console.error(`[BloFin] ❌❌ CRITICAL: Could not close unprotected position ${instId}: ${closeErr.message}`);
      }
      throw new Error(`TP/SL failed for ${instId} — position closed for safety: ${e.message}`);
    }
  }

  console.log(`[BloFin] Opened ${direction} ${instId} | Size: ${size} | Lev: ${leverage}x | Order: ${orderId}`);
  return { orderId, protocol: 'blofin' };
}

async function closePosition({ creds, instId, direction, marginMode, demo }) {
  const side = direction === 'long' ? 'sell' : 'buy';

  // Get actual position size to close
  let closeSize = '0';
  try {
    const positions = await getPositions(creds, demo);
    const pos = positions.find(p => p.instId === instId && p.direction === direction);
    if (pos && pos.size > 0) closeSize = String(pos.size);
  } catch (e) { console.warn('[BloFin] Could not fetch position size for close:', e.message); }

  const body = {
    instId,
    marginMode: marginMode || 'cross',
    side,
    orderType: 'market',
    size: closeSize,
    positionSide: direction,
  };
  const bid2 = creds.brokerId || BROKER_ID;
  if (bid2) body.brokerId = bid2;

  const data = await privatePost('/api/v1/trade/order', body, creds, true, demo);
  const orderId = data && data[0] ? data[0].orderId : (data?.orderId || null);
  console.log(`[BloFin] Closed ${direction} ${instId} | Order: ${orderId}`);
  return { orderId };
}

async function cancelOrder(creds, instId, orderId, demo) {
  const body = { instId, orderId };
  const bid3 = creds.brokerId || BROKER_ID;
  if (bid3) body.brokerId = bid3;
  return privatePost('/api/v1/trade/cancel-order', body, creds, true, demo);
}

async function getActiveOrders(creds, instId, demo) {
  const params = instId ? { instId } : {};
  return privateGet('/api/v1/trade/active-orders', params, creds, demo);
}

async function setTpSl({ creds, instId, direction, size, tpPrice, slPrice, marginMode, demo }) {
  const closeSide = direction === 'long' ? 'sell' : 'buy';
  const body = {
    instId,
    marginMode: marginMode || 'cross',
    positionSide: direction,
    side: closeSide,
    size: String(size),
  };
  const bid = creds.brokerId || BROKER_ID;
  if (bid) body.brokerId = bid;
  if (tpPrice) { body.tpTriggerPrice = String(tpPrice); body.tpOrderPrice = '-1'; }
  if (slPrice) { body.slTriggerPrice = String(slPrice); body.slOrderPrice = '-1'; }
  return privatePost('/api/v1/trade/order-tpsl', body, creds, true, demo);
}

async function getOrderHistory(creds, instId, demo) {
  const params = instId ? { instId } : {};
  return privateGet('/api/v1/trade/order-history', params, creds, demo);
}

module.exports = {
  getBaseUrl,
  DEMO_BASE,
  LIVE_BASE,
  getMarkets,
  getTicker,
  getCandles,
  getFundingRate,
  getMarkPrice,
  getBalance,
  getFundingBalance,
  getPositions,
  setLeverage,
  setMarginMode,
  setPositionMode,
  openPosition,
  closePosition,
  cancelOrder,
  getActiveOrders,
  getOrderHistory,
  setTpSl,
};
