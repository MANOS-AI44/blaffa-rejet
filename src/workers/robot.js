// Robot de rejet - avec desactivation auto-update et page-size 500
const { query } = require('../db');

const BASE_URL = process.env.MANAGMENT_BASE_URL || 'https://managment.io';
const PENDING_URL = BASE_URL + '/fr/admin/report/pendingrequestrefill';
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium';

const runners = new Map();

async function log(userId, level, message) {
  console.log('[' + level + '][user:' + userId + '] ' + message);
  try {
    await query('INSERT INTO robot_logs (user_id, level, message) VALUES ($1, $2, $3)', [userId, level, message.substring(0, 2000)]);
    await query('DELETE FROM robot_logs WHERE id IN (SELECT id FROM robot_logs WHERE user_id = $1 ORDER BY created_at DESC OFFSET 200)', [userId]);
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
  if ((x = t.match(/(\d+)\s*jour/))) m += parseInt(x[1]) * 1440;
  if ((x = t.match(/(\d+)\s*heure/))) m += parseInt(x[1]) * 60;
  if ((x = t.match(/(\d+)\s*minute/))) m += parseInt(x[1]);
  return m;
}

async function runOneCycleForUser(userId) {
  let chromium;
  try { chromium = require('playwright').chromium; }
  catch (e) { await log(userId, 'ERROR', 'Playwright: ' + e.message); return { error: 'no playwright' }; }

  const s = (await query('SELECT cookies_json, threshold_minutes, robot_active FROM user_settings WHERE user_id = $1', [userId])).rows[0];
  if (!s || !s.robot_active) return { stopped: true };
  const threshold = s.threshold_minutes || 120;
  const cookies = parseCookies(s.cookies_json);
  if (!cookies.length) { await log(userId, 'WARN', 'Aucun cookie.'); return { error: 'no cookies' }; }

  await log(userId, 'INFO', 'Debut cycle (seuil=' + threshold + ' min)');
  let browser = null, rejectedCount = 0;
  try {
    browser = await chromium.launch({
      headless: true, executablePath: CHROMIUM_PATH,
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
      await query('UPDATE user_settings SET last_status = $1, last_run_at = NOW() WHERE user_id = $2', ['ERROR_AUTH', userId]);
      return { error: 'auth' };
    }

    // 1. Desactiver l'auto-update (toggle ON a cote de "Mise a jour auto")
    await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('*'));
      for (const el of all) {
        const txt = (el.textContent || '').trim();
        // toggle ACTIF (ON) a proximite de label "Mise a jour auto"
        if ((txt === 'ON' || txt === 'on') && el.children.length === 0) {
          const parent = el.parentElement;
          if (parent && (parent.textContent || '').includes('Mise')) {
            el.click(); return;
          }
        }
      }
    });
    await page.waitForTimeout(500);

    // 2. Cliquer APPLIQUER
    const apply = page.locator('button:has-text("APPLIQUER"), button:has-text("Appliquer")').first();
    if (await apply.isVisible({ timeout: 3000 }).catch(() => false)) { await apply.click(); await page.waitForTimeout(3000); }

    // 3. Changer page-size a 500
    await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('*')).filter(e => e.textContent.trim() === '100' && e.children.length <= 1 && e.offsetWidth < 200);
      if (candidates[0]) candidates[0].click();
    });
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const opts = Array.from(document.querySelectorAll('*')).filter(e => e.textContent.trim() === '500' && e.children.length <= 1 && e.offsetWidth < 200);
      if (opts[0]) opts[0].click();
    });
    await page.waitForTimeout(800);
    if (await apply.isVisible({ timeout: 1500 }).catch(() => false)) { await apply.click(); await page.waitForTimeout(3000); }

    // Boucle de rejet: parcourir toutes les rangees, rejeter celles > seuil de la plus ancienne
    const MAX = 500;
    for (let i = 0; i < MAX; i++) {
      const allRows = await page.evaluate(() => {
        const r = document.querySelectorAll('table tbody tr');
        if (!r.length) return [];
        return Array.from(r).map(row => {
          const c = row.querySelectorAll('td');
          if (c.length < 7) return null;
          return {
            infos: (c.item(0) && c.item(0).innerText || '').trim(),
            amount: (c.item(1) && c.item(1).innerText || '').trim(),
            processingTime: (c.item(3) && c.item(3).innerText || '').trim(),
            identifier: (c.item(5) && c.item(5).innerText || '').trim(),
            bankName: (c.item(7) && c.item(7).innerText || '').trim(),
          };
        }).filter(x => x);
      });
      if (!allRows.length) { await log(userId, 'INFO', 'Table vide.'); break; }

      const eligible = allRows.filter(r => processingTimeToMinutes(r.processingTime) > threshold);
      if (!eligible.length) { await log(userId, 'INFO', 'Plus aucune > ' + threshold + ' min (parmi ' + allRows.length + ' rangees).'); break; }
      const target = eligible[eligible.length - 1];
      const targetIndex = allRows.indexOf(target);

      if (i === 0) await log(userId, 'INFO', 'Demandes a rejeter: ' + eligible.length + ' / ' + allRows.length);

      const phoneMatch = target.infos.match(/(\d{8,15})/);
      const userPhone = phoneMatch ? phoneMatch[1] : '';

      const result = await page.evaluate(async (idx) => {
        const rs = document.querySelectorAll('table tbody tr');
        const row = rs[idx];
        if (!row) return { error: 'no row' };
        const link = row.querySelectorAll('td')[4].querySelector('a');
        if (!link) return { error: 'no link' };
        link.scrollIntoView({ block: 'center' });
        link.click();
        for (let j = 0; j < 30; j++) {
          const m = document.body.innerText.match(/N[\u00b0\u00bao]\s*(\d+)/);
          if (m) return { requestNumber: m[1] };
          await new Promise(r => setTimeout(r, 100));
        }
        return { error: 'modal not found' };
      }, targetIndex);

      if (result.error) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(500); continue;
      }

      const filled = await page.evaluate(() => {
        const input = document.querySelector('input[placeholder="Commentaire"]');
        if (!input) return { error: 'no input' };
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'AA');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        for (const b of document.querySelectorAll('button')) {
          if (b.innerText.trim() === 'OK' && b.offsetParent !== null) { b.click(); return { ok: true }; }
        }
        return { error: 'no OK btn' };
      });
      if (filled.error) { await page.keyboard.press('Escape').catch(() => {}); continue; }
      await page.waitForTimeout(1500);

      try {
        await query('INSERT INTO rejections (user_id, request_number, deposit_id, user_phone, user_identifier, amount, bank_name, processing_time, threshold_used, success) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)',
          [userId, result.requestNumber, target.identifier, userPhone, target.identifier, target.amount, target.bankName, target.processingTime, threshold]);
      } catch (e) {}
      rejectedCount++;
      if (rejectedCount % 10 === 0) await log(userId, 'INFO', rejectedCount + ' rejets...');
    }

    await query('UPDATE user_settings SET last_status = $1, last_run_at = NOW() WHERE user_id = $2', ['OK: ' + rejectedCount + ' rejet(s)', userId]);
    await log(userId, 'INFO', 'Cycle termine: ' + rejectedCount + ' rejets.');
    return { rejected: rejectedCount };
  } catch (err) {
    await log(userId, 'ERROR', 'Erreur: ' + err.message);
    await query('UPDATE user_settings SET last_status = $1, last_run_at = NOW() WHERE user_id = $2', ['ERROR: ' + err.message.substring(0, 200), userId]);
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
  } catch (e) { console.error('Bootstrap:', e.message); }
}

module.exports = { startRobotForUser, stopRobotForUser, isRobotRunning, bootstrap };
