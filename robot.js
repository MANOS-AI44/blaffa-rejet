// Robot de rejet v5 - architecture par plateformes (1 admin, N plateformes managment.io)
const { query } = require('../db');

const BASE_URL = process.env.MANAGMENT_BASE_URL || 'https://managment.io';
const PENDING_URL = BASE_URL + '/fr/admin/report/pendingrequestrefill';
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium';

const runners = new Map();

// MUTEX GLOBAL - un seul Chromium a la fois pour eviter EAGAIN/OOM
let chromiumBusy = false;
const chromiumQueue = [];
function acquireChromium() {
  return new Promise(resolve => {
    if (!chromiumBusy) { chromiumBusy = true; resolve(); }
    else chromiumQueue.push(resolve);
  });
}
function releaseChromium() {
  if (chromiumQueue.length > 0) { const next = chromiumQueue.shift(); next(); }
  else chromiumBusy = false;
}

// Launch chromium avec retry sur EAGAIN/ENOMEM
async function launchChromiumWithRetry(chromium, opts, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await chromium.launch(opts);
    } catch (e) {
      const msg = e.message || '';
      if (i < maxRetries - 1 && (msg.includes('EAGAIN') || msg.includes('ENOMEM') || msg.includes('spawn'))) {
        await new Promise(r => setTimeout(r, 5000 * (i + 1)));
        if (global.gc) global.gc();
        continue;
      }
      throw e;
    }
  }
}

async function log(platformId, level, message) {
  console.log('[' + level + '][platform:' + platformId + '] ' + message);
  try {
    await query('INSERT INTO robot_logs (platform_id, level, message) VALUES ($1, $2, $3)', [platformId, level, message.substring(0, 2000)]);
    await query('DELETE FROM robot_logs WHERE id IN (SELECT id FROM robot_logs WHERE platform_id = $1 ORDER BY created_at DESC OFFSET 200)', [platformId]);
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

async function runOneCycleForPlatform(platformId) {
  let chromium;
  try { chromium = require('playwright').chromium; }
  catch (e) { await log(platformId, 'ERROR', 'Playwright: ' + e.message); return { error: 'no playwright' }; }

  const s = (await query('SELECT cookies_json, threshold_minutes, robot_active FROM platforms WHERE id = $1', [platformId])).rows[0];
  if (!s || !s.robot_active) return { stopped: true };
  // Seuil personnalise par plateforme (defaut 120 min = 2h)
  const threshold = s.threshold_minutes || 120;
  const cookies = parseCookies(s.cookies_json);
  if (!cookies.length) { await log(platformId, 'WARN', 'Aucun cookie.'); return { error: 'no cookies' }; }

  await log(platformId, 'INFO', 'Debut cycle (seuil=' + threshold + ' min)');
  let browser = null, rejectedCount = 0;
  let chromiumAcquired = false;
  try {
    // Attendre son tour pour lancer Chromium (mutex global)
    await acquireChromium();
    chromiumAcquired = true;
    browser = await launchChromiumWithRetry(chromium, {
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
      await log(platformId, 'ERROR', 'Cookies invalides.');
      await query('UPDATE platforms SET last_status = $1, last_run_at = NOW() WHERE id = $2', ['ERROR_AUTH', platformId]);
      return { error: 'auth' };
    }

    // 1. Disable auto-update (Mise a jour auto: ON -> OFF)
    const toggled = await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('*')).filter(el => {
        const t = (el.textContent || '').trim().toLowerCase();
        return t.includes('mise') && t.includes('jour') && t.length < 60 && el.children.length < 8;
      });
      for (const label of labels) {
        const container = label.closest('div, td, label') || label.parentElement;
        if (!container) continue;
        const cb = container.querySelector('input[type="checkbox"]');
        if (cb && cb.checked && cb.offsetParent !== null) { cb.click(); return 'checkbox'; }
        const toggles = container.querySelectorAll('.switch, .toggle, [class*="switch"], [class*="toggle"]');
        for (const t of toggles) {
          if (t.offsetParent !== null) { t.click(); return 'toggle'; }
        }
        const allInner = container.querySelectorAll('*');
        for (const b of allInner) {
          const tt = (b.textContent || '').trim();
          if ((tt === 'ON' || tt === 'on') && b.offsetParent !== null && b.children.length === 0) {
            (b.parentElement || b).click();
            return 'on-text';
          }
        }
      }
      return null;
    });
    if (toggled) await log(platformId, 'INFO', 'Auto-update desactive (' + toggled + ')');
    await page.waitForTimeout(500);

    // 2. Click APPLIQUER
    const applyBtn = page.locator('button:has-text("APPLIQUER"), a:has-text("APPLIQUER")').first();
    if (await applyBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await applyBtn.click({ force: true });
      await page.waitForTimeout(3500);
    }

    // 3. Page-size to 500
    let pageSizeChanged = false;
    try {
      const selects = page.locator('select');
      const selectCount = await selects.count();
      for (let i = 0; i < selectCount && !pageSizeChanged; i++) {
        const opts = await selects.nth(i).locator('option').allTextContents();
        if (opts.includes('500')) {
          await selects.nth(i).selectOption('500');
          pageSizeChanged = true;
          await log(platformId, 'INFO', 'Page-size 500 (select natif)');
        }
      }
    } catch (e) {}
    if (!pageSizeChanged) {
      try {
        const dd = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('div, span, button, a')).filter(e => {
            return (e.textContent || '').trim() === '100' && e.children.length <= 1 && e.offsetParent !== null;
          });
          if (els.length) { els[els.length - 1].click(); return true; }
          return false;
        });
        if (dd) {
          await page.waitForTimeout(500);
          const picked = await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('div, span, li, a, option')).filter(e => {
              return (e.textContent || '').trim() === '500' && e.children.length <= 1 && e.offsetParent !== null;
            });
            if (els.length) { els[els.length - 1].click(); return true; }
            return false;
          });
          if (picked) { pageSizeChanged = true; await log(platformId, 'INFO', 'Page-size 500 (dropdown)'); }
        }
      } catch (e) {}
    }
    await page.waitForTimeout(1000);
    if (await applyBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await applyBtn.click({ force: true });
      await page.waitForTimeout(3500);
    }

    // 4. Rejection loop - utilise des CLICS PLAYWRIGHT (vraie souris)
    const MAX = 500;
    let consecutiveFailures = 0;
    for (let i = 0; i < MAX; i++) {
      const allRows = await page.evaluate(() => {
        const r = document.querySelectorAll('table tbody tr');
        if (!r.length) return [];
        return Array.from(r).map(row => {
          const c = row.querySelectorAll('td');
          if (c.length < 5) return null;
          const hasReject = !!Array.from(row.querySelectorAll('a')).find(a => (a.textContent || '').trim() === 'Rejeter');
          if (!hasReject) return null;
          return {
            infos: (c.item(0) ? c.item(0).innerText : '').trim(),
            amount: (c.item(1) ? c.item(1).innerText : '').trim(),
            processingTime: (c.item(3) ? c.item(3).innerText : '').trim(),
            identifier: c.item(5) ? c.item(5).innerText.trim() : '',
            bankName: c.item(7) ? c.item(7).innerText.trim() : '',
          };
        }).filter(x => x);
      });
      if (!allRows.length) { await log(platformId, 'INFO', 'Table vide.'); break; }

      // Tri explicite: du plus ancien (plus grande duree d'attente) au plus recent
      const eligible = allRows
        .filter(r => processingTimeToMinutes(r.processingTime) > threshold)
        .sort((a, b) => processingTimeToMinutes(b.processingTime) - processingTimeToMinutes(a.processingTime));
      if (!eligible.length) {
        await log(platformId, 'INFO', 'Plus aucune > ' + threshold + ' min (' + allRows.length + ' rangees vues).');
        break;
      }
      // Toujours commencer par la plus ancienne demande
      const target = eligible[0];
      const targetIndex = allRows.indexOf(target);

      if (i === 0) await log(platformId, 'INFO', 'Demandes a rejeter: ' + eligible.length + ' / ' + allRows.length);

      const phoneMatch = target.infos.match(/(\d{8,15})/);
      const userPhone = phoneMatch ? phoneMatch[1] : '';

      try {
        // CLIC PLAYWRIGHT - critique pour declencher les handlers jQuery de managment.io
        const rejectLink = page.locator('table tbody tr').nth(targetIndex).locator('a:has-text("Rejeter")').first();
        await rejectLink.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await rejectLink.click({ force: true, timeout: 5000 });

        // Attendre le modal (input commentaire)
        await page.waitForSelector('input[placeholder="Commentaire"]', { state: 'visible', timeout: 8000 });

        // Extraire le N de demande depuis le modal
        const requestNumber = await page.evaluate(() => {
          const text = document.body.innerText;
          const m = text.match(/(?:N[Â°Âº]|No)\s*(\d{6,})/);
          return m ? m[1] : '';
        });

        // Remplir le commentaire de rejet via Playwright (tous les events)
        await page.fill('input[placeholder="Commentaire"]', "Nous n'avons pas reçu ce paiement");
        await page.waitForTimeout(200);

        // Cliquer OK (bouton turquoise) via Playwright
        let okClicked = false;
        try {
          await page.locator('button:has-text("OK"), a:has-text("OK")').filter({ hasText: /^OK$/i }).first().click({ force: true, timeout: 3000 });
          okClicked = true;
        } catch (e) {
          okClicked = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
            for (const b of btns) {
              const t = (b.textContent || b.value || '').trim();
              if ((t === 'OK' || t === 'Ok') && b.offsetParent !== null) { b.click(); return true; }
            }
            return false;
          });
        }

        if (!okClicked) {
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(800);
          consecutiveFailures++;
          if (consecutiveFailures > 3) { await log(platformId, 'ERROR', 'Bouton OK introuvable (3x)'); break; }
          continue;
        }

        await page.waitForSelector('input[placeholder="Commentaire"]', { state: 'hidden', timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1200);

        consecutiveFailures = 0;
        try {
          await query('INSERT INTO rejections (platform_id, request_number, deposit_id, user_phone, user_identifier, amount, bank_name, processing_time, threshold_used, success) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)',
            [platformId, requestNumber, target.identifier, userPhone, target.identifier, target.amount, target.bankName, target.processingTime, threshold]);
        } catch (e) {}
        rejectedCount++;
        if (rejectedCount === 1 || rejectedCount % 5 === 0) await log(platformId, 'INFO', 'Rejete ' + rejectedCount + ' (N ' + requestNumber + ')');
      } catch (clickErr) {
        consecutiveFailures++;
        await log(platformId, 'WARN', 'Echec idx=' + targetIndex + ': ' + (clickErr.message || '').substring(0, 100));
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(800);
        if (consecutiveFailures > 5) { await log(platformId, 'ERROR', 'Trop d echecs consecutifs, arret du cycle.'); break; }
      }
    }

    await query('UPDATE platforms SET last_status = $1, last_run_at = NOW() WHERE id = $2', ['OK: ' + rejectedCount + ' rejet(s)', platformId]);
    await log(platformId, 'INFO', 'Cycle termine: ' + rejectedCount + ' rejets.');
    return { rejected: rejectedCount };
  } catch (err) {
    await log(platformId, 'ERROR', 'Erreur: ' + err.message);
    await query('UPDATE platforms SET last_status = $1, last_run_at = NOW() WHERE id = $2', ['ERROR: ' + err.message.substring(0, 200), platformId]);
    return { error: err.message };
  } finally {
    if (browser) { try { await browser.close(); } catch (e) {} }
    if (chromiumAcquired) releaseChromium();
  }
}

async function platformLoop(platformId) {
  while (runners.has(platformId) && runners.get(platformId).active) {
    let result;
    try { result = await runOneCycleForPlatform(platformId); } catch (e) { await log(platformId, 'ERROR', e.message); }
    // Si aucune demande n'a ete trouvee/rejetee dans ce cycle,
    // attendre 5 minutes avant de reessayer (au lieu de 30s).
    const noDemandFound = result && typeof result.rejected === 'number' && result.rejected === 0;
    const delayMs = noDemandFound ? 5 * 60 * 1000 : 30 * 1000;
    if (noDemandFound) {
      await log(platformId, 'INFO', 'Aucune demande a rejeter, nouvelle verification dans 5 min.');
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  runners.delete(platformId);
}

function startRobotForPlatform(platformId) {
  if (runners.has(platformId) && runners.get(platformId).active) return;
  runners.set(platformId, { active: true });
  log(platformId, 'INFO', 'Robot demarre.');
  platformLoop(platformId).catch(() => runners.delete(platformId));
}

function stopRobotForPlatform(platformId) {
  if (runners.has(platformId)) { runners.get(platformId).active = false; log(platformId, 'INFO', 'Robot arrete.'); }
}

function isRobotRunning(platformId) { return runners.has(platformId) && runners.get(platformId).active; }

async function bootstrap() {
  console.log('Bootstrap des plateformes actives...');
  try {
    const r = await query('SELECT id FROM platforms WHERE robot_active = TRUE');
    // Espacer les demarrages de 5s pour ne pas saturer Chromium
    for (let i = 0; i < r.rows.length; i++) {
      const row = r.rows[i];
      setTimeout(() => startRobotForPlatform(row.id), i * 5000);
    }
    console.log(r.rows.length + ' plateforme(s) seront relancee(s) (5s d\'intervalle).');
  } catch (e) { console.error('Bootstrap:', e.message); }
}

module.exports = { startRobotForPlatform, stopRobotForPlatform, isRobotRunning, bootstrap };
