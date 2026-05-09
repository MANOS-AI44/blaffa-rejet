// Robot de rejet - utilise Playwright avec Chromium systeme
const { query } = require('../db');

const BASE_URL = process.env.MANAGMENT_BASE_URL || 'https://managment.io';
const PENDING_URL = BASE_URL + '/fr/admin/report/pendingrequestrefill';
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium';

const runners = new Map();

async function log(userId, level, message) {
  console.log('[' + level + '][user:' + userId + '] ' + message);
  try {
    await query('INSERT INTO robot_logs (user_id, level, message) VALUES (\$1, \$2, \$3)', [userId, level, message.substring(0, 2000)]);
    await query('DELETE FROM robot_logs WHERE id IN (SELECT id FROM robot_logs WHERE user_id = \$1 ORDER BY created_at DESC OFFSET 200)', [userId]);
  } catch (e) {}
}

function parseCookies(cookiesJson) {
  if (!cookiesJson) return [];
  let parsed;
  try { parsed = typeof cookiesJson === 'string' ? JSON.parse(cookiesJson) : cookiesJson; }
  catch (e) { parsed = cookiesJson.split(';').map(p => { const [n, ...r] = p.trim().split('='); return { name: n.trim(), value: r.join('=').trim() }; }); }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(c => c && c.name).map(c => ({
    name: c.name, value: String(c.value || ''),
    domain: c.domain || '.managment.io', path: c.path || '/',
    httpOnly: c.httpOnly || false, secure: c.secure !== false,
    sameSite: ['Strict','Lax','None'].includes(c.sameSite) ? c.sameSite : 'Lax',
  }));
}

function processingTimeToMinutes(pt) {
  if (!pt) return 0;
  const t = pt.toLowerCase();
  if (t.includes('less than 1') || t.includes('moins')) return 0;
  let m = 0, x;
  if ((x = t.match(/(\\d+)\\s*jour/))) m += parseInt(x[1]) * 1440;
  if ((x = t.match(/(\\d+)\\s*heure/))) m += parseInt(x[1]) * 60;
  if ((x = t.match(/(\\d+)\\s*minute/))) m += parseInt(x[1]);
  return m;
}

async function runOneCycleForUser(userId) {
  let chromium;
  try { chromium = require('playwright').chromium; }
  catch (e) { await log(userId, 'ERROR', 'Playwright non disponible: ' + e.message); return { error: 'no playwright' }; }

  const s = (await query('SELECT cookies_json, threshold_minutes, robot_active FROM user_settings WHERE user_id = \$1', [userId])).rows[0];
  if (!s || !s.robot_active) return { stopped: true };
  const threshold = s.threshold_minutes || 120;
  const cookies = parseCookies(s.cookies_json);
  if (!cookies.length) { await log(userId, 'WARN', 'Aucun cookie injecte.'); return { error: 'no cookies' }; }

  await log(userId, 'INFO', 'Debut cycle (seuil=' + threshold + ' min)');
  let browser = null, rejectedCount = 0;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: CHROMIUM_PATH,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    await page.goto(PENDING_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);

    const isLogin = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
    if (isLogin) {
      await log(userId, 'ERROR', 'Cookies invalides.');
      await query('UPDATE user_settings SET last_status = \$1, last_run_at = NOW() WHERE user_id = \$2', ['ERROR_AUTH', userId]);
      return { error: 'auth' };
    }

    const apply = page.locator('button:has-text("APPLIQUER"), button:has-text("Appliquer")').first();
    if (await apply.isVisible({ timeout: 3000 }).catch(() => false)) { await apply.click(); await page.waitForTimeout(3000); }

    for (let i = 0; i < 500; i++) {
      const rows = await page.evaluate(() => {
        const rs = document.querySelectorAll('table tbody tr');
        if (!rs.length) return null;
        const data = [];
        rs.forEach(r => {
          const c = r.querySelectorAll('td');
          if (c.length >= 7) data.push({
            infos: c[0]?.innerText?.trim() || '', amount: c[1]?.innerText?.trim() || '',
            processingTime: c[3]?.innerText?.trim() || '', identifier: c[5]?.innerText?.trim() || '',
            dateCreation: c[6]?.innerText?.trim() || '', bankName: c[7]?.innerText?.trim() || '',
          });
        });
        return data;
      });
      if (!rows || !rows.length) break;
      const last = rows[rows.length - 1];
      if (processingTimeToMinutes(last.processingTime) <= threshold) { await log(userId, 'INFO', 'Plus aucune > ' + threshold + ' min.'); break; }
      const phoneMatch = last.infos.match(/(\\d{8,15})/);
      const userPhone = phoneMatch ? phoneMatch[1] : '';

      const result = await page.evaluate(async () => {
        const rs = document.querySelectorAll('table tbody tr');
        const link = rs[rs.length - 1].querySelectorAll('td')[4].querySelector('a');
        if (!link) return { error: 'no link' };
        link.scrollIntoView({ block: 'center' });
        link.click();
        for (let i = 0; i < 30; i++) {
          const m = document.body.innerText.match(/N[\u00b0\u00bao]\\s*(\\d+)/);
          if (m) return { requestNumber: m[1] };
          await new Promise(r => setTimeout(r, 100));
        }
        return { error: 'modal not found' };
      });
      if (result.error) { await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(500); continue; }

      const filled = await page.evaluate(() => {
        const input = document.querySelector('input[placeholder="Commentaire"]');
        if (!input) return { error: 'no input' };
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'AA');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        for (const b of document.querySelectorAll('button')) if (b.innerText.trim() === 'OK' && b.offsetParent !== null) { b.click(); return { ok: true }; }
        return { error: 'no OK btn' };
      });
      if (filled.error) { await page.keyboard.press('Escape').catch(() => {}); continue; }
      await page.waitForTimeout(1500);
      try {
        await query('INSERT INTO rejections (user_id, request_number, deposit_id, user_phone, user_identifier, amount, bank_name, processing_time, threshold_used, success) VALUES (\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, TRUE)',
          [userId, result.requestNumber, last.identifier, userPhone, last.identifier, last.amount, last.bankName, last.processingTime, threshold]);
      } catch (e) {}
      rejectedCount++;
    }
    await query('UPDATE user_settings SET last_status = \$1, last_run_at = NOW() WHERE user_id = \$2', ['OK: ' + rejectedCount + ' rejet(s)', userId]);
    await log(userId, 'INFO', 'Cycle termine : ' + rejectedCount + ' rejets.');
    return { rejected: rejectedCount };
  } catch (err) {
    await log(userId, 'ERROR', 'Erreur cycle: ' + err.message);
    await query('UPDATE user_settings SET last_status = \$1, last_run_at = NOW() WHERE user_id = \$2', ['ERROR: ' + err.message.substring(0, 200), userId]);
    return { error: err.message };
  } finally {
    if (browser) { try { await browser.close(); } catch (e) {} }
  }
}

async function userLoop(userId) {
  while (runners.has(userId) && runners.get(userId).active) {
    try { await runOneCycleForUser(userId); } catch (e) { await log(userId, 'ERROR', e.message); }
    await new Promise(r => setTimeout(r, 30000));
  }
  runners.delete(userId);
}

function startRobotForUser(userId) {
  if (runners.has(userId) && runners.get(userId).active) return;
  runners.set(userId, { active: true });
  log(userId, 'INFO', 'Robot demarre.');
  userLoop(userId).catch(() => runners.delete(userId));
}

function stopRobotForUser(userId) {
  if (runners.has(userId)) { runners.get(userId).active = false; log(userId, 'INFO', 'Robot arrete.'); }
}

function isRobotRunning(userId) { return runners.has(userId) && runners.get(userId).active; }

async function bootstrap() {
  console.log('Bootstrap des robots actifs...');
  try {
    const r = await query('SELECT us.user_id FROM user_settings us JOIN users u ON u.id = us.user_id WHERE us.robot_active = TRUE AND u.is_active = TRUE');
    for (const row of r.rows) startRobotForUser(row.user_id);
    console.log(r.rows.length + ' robot(s) relance(s).');
  } catch (e) { console.error('Bootstrap error:', e.message); }
}

module.exports = { startRobotForUser, stopRobotForUser, isRobotRunning, bootstrap };
