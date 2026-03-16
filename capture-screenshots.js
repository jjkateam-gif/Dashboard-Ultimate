const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR);
// Clean old screenshots
fs.readdirSync(SCREENSHOTS_DIR).filter(f => f.endsWith('.png')).forEach(f => fs.unlinkSync(path.join(SCREENSHOTS_DIR, f)));

const URL = 'https://jjkateam-gif.github.io/Dashboard-Ultimate/';
const BACKEND = 'https://dashboard-ultimate-production.up.railway.app';
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1400, height: 900 }
  });

  const page = await browser.newPage();

  // Get JWT token via node-fetch (server-side, no CORS issues)
  console.log('Logging in via API...');
  let token = null;
  try {
    const resp = await fetch(BACKEND + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Josh', password: 'ChangeMeImmediately!2024' })
    });
    const data = await resp.json();
    token = data.token;
    console.log('Token obtained:', token ? 'YES (' + token.slice(0, 20) + '...)' : 'NO');
    if (!token) console.log('Login response:', JSON.stringify(data));
  } catch(e) {
    console.log('Login failed:', e.message);
  }

  if (!token) {
    console.log('Cannot proceed without token. Trying UI login...');
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await wait(2000);
    // Type credentials in the login form
    try {
      await page.type('input[placeholder="Username"], input[name="username"], #loginUser', 'Josh');
      await page.type('input[placeholder="Password"], input[type="password"], #loginPass', 'ChangeMeImmediately!2024');
      await wait(500);
      // Click login button
      const loginBtn = await page.$('button[type="submit"], #loginBtn, button');
      if (loginBtn) await loginBtn.click();
      await wait(5000);
      // Check if we got past login
      token = await page.evaluate(() => localStorage.getItem('dash_token'));
      console.log('UI login token:', token ? 'YES' : 'NO');
    } catch(e) {
      console.log('UI login error:', e.message);
    }
  } else {
    // Navigate and inject token
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await wait(1000);
    await page.evaluate((t) => {
      localStorage.setItem('dash_token', t);
      localStorage.setItem('dash_user', JSON.stringify({ username: 'Josh', role: 'admin' }));
      localStorage.setItem('dash_onboarded', 'true');
    }, token);
    // Reload with auth
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await wait(4000);
  }

  // Dismiss any modals/popups
  try {
    await page.evaluate(() => {
      document.querySelectorAll('[id*="Modal"],[id*="modal"],[id*="Popup"],[id*="popup"],[id*="onboard"]').forEach(el => {
        el.style.display = 'none';
      });
    });
  } catch(e) {}

  // Verify we're logged in
  const loggedIn = await page.evaluate(() => {
    return !!localStorage.getItem('dash_token') && !document.querySelector('#loginPanel')?.offsetHeight;
  });
  console.log('Logged in:', loggedIn);

  async function snap(name) {
    await wait(400);
    try {
      await page.evaluate(() => {
        // Hide any floating toasts/modals for clean screenshots
        document.querySelectorAll('.toast-container, [id*="toast"]').forEach(el => el.style.display = 'none');
      });
    } catch(e) {}
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, name) });
    console.log('  ✓', name);
  }

  // === SCREENSHOTS ===

  // 1. Best Trades - Header & Top
  console.log('\n--- Best Trades Tab ---');
  try {
    await page.evaluate(() => { if (typeof switchPageTab === 'function') switchPageTab('trades'); });
    await wait(2000);
    await page.evaluate(() => window.scrollTo(0, 0));
  } catch(e) {}
  await snap('01_best_trades_header.png');

  // 2. Auto-trade panel
  await page.evaluate(() => window.scrollBy(0, 400));
  await snap('02_autotrade_panel.png');

  // 3. Run scan and capture results
  console.log('\n--- Scan Results ---');
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
    await wait(300);
    const scanBtn = await page.$('#probeBtn');
    if (scanBtn) {
      await scanBtn.click();
      console.log('  Scanning (25s)...');
      await wait(25000);
      await page.evaluate(() => window.scrollTo(0, 0));
      await snap('03_scan_regime_banner.png');

      await page.evaluate(() => window.scrollBy(0, 450));
      await wait(300);
      await snap('04_scan_trade_cards_1.png');

      await page.evaluate(() => window.scrollBy(0, 500));
      await wait(300);
      await snap('05_scan_trade_cards_2.png');

      await page.evaluate(() => window.scrollBy(0, 500));
      await wait(300);
      await snap('06_scan_trade_cards_3.png');
    }
  } catch(e) { console.log('  Scan error:', e.message); }

  // 4. Track Record
  console.log('\n--- Track Record ---');
  try {
    await page.evaluate(() => {
      const el = document.querySelector('#recPanel, #trackRecordPanel, [id*="rec"]');
      if (el) el.scrollIntoView({ block: 'start' });
      else window.scrollTo(0, document.body.scrollHeight - 900);
    });
    await wait(1000);
    await snap('07_track_record.png');

    await page.evaluate(() => window.scrollBy(0, 500));
    await wait(300);
    await snap('08_track_record_history.png');
  } catch(e) {}

  // 5. Backtester
  console.log('\n--- Backtester ---');
  try {
    await page.evaluate(() => { if (typeof switchPageTab === 'function') switchPageTab('backtester'); });
    await wait(2000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await snap('09_backtester_top.png');

    await page.evaluate(() => window.scrollBy(0, 500));
    await wait(300);
    await snap('10_backtester_indicators.png');

    await page.evaluate(() => window.scrollBy(0, 600));
    await wait(300);
    await snap('11_backtester_bottom.png');
  } catch(e) {}

  // 6. Degen Scanner
  console.log('\n--- Degen Scanner ---');
  try {
    await page.evaluate(() => { if (typeof switchPageTab === 'function') switchPageTab('degen'); });
    await wait(2000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await snap('12_degen_scanner.png');
  } catch(e) {}

  // 7. Market Intel
  console.log('\n--- Market Intel ---');
  try {
    await page.evaluate(() => { if (typeof switchPageTab === 'function') switchPageTab('news'); });
    await wait(2000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await snap('13_market_intel.png');
  } catch(e) {}

  // 8. Alerts
  console.log('\n--- Alerts ---');
  try {
    await page.evaluate(() => { if (typeof switchPageTab === 'function') switchPageTab('alerts'); });
    await wait(2000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await snap('14_alerts.png');
  } catch(e) {}

  // 9. Paper Trade
  console.log('\n--- Paper Trade ---');
  try {
    await page.evaluate(() => { if (typeof switchPageTab === 'function') switchPageTab('paper'); });
    await wait(2000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await snap('15_paper_trade.png');
  } catch(e) {}

  // 10. Live Trading
  console.log('\n--- Live Trading ---');
  try {
    await page.evaluate(() => { if (typeof switchPageTab === 'function') switchPageTab('live'); });
    await wait(2000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await snap('16_live_trading.png');

    await page.evaluate(() => window.scrollBy(0, 500));
    await wait(300);
    await snap('17_live_trading_scroll.png');
  } catch(e) {}

  // Also capture login screen for docs
  console.log('\n--- Login Screen ---');
  try {
    await page.evaluate(() => {
      localStorage.removeItem('dash_token');
    });
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 15000 });
    await wait(2000);
    await snap('00_login_screen.png');
  } catch(e) {}

  await browser.close();

  const files = fs.readdirSync(SCREENSHOTS_DIR).filter(f => f.endsWith('.png')).sort();
  console.log(`\n✅ Done! Captured ${files.length} screenshots:`);
  files.forEach(f => {
    const stats = fs.statSync(path.join(SCREENSHOTS_DIR, f));
    console.log(`  ${f} (${(stats.size / 1024).toFixed(0)} KB)`);
  });
})();
