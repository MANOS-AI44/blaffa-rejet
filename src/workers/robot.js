// Robot de rejet automatique - utilise Playwright pour piloter Chromium en arrière-plan
const { chromium } = require('playwright');
const { query } = require('../db');

const BASE_URL = process.env.MANAGMENT_BASE_URL || 'https://managment.io';
const PENDING_URL = `${BASE_URL}/fr/admin/report/pendingrequestrefill`;

// Map userId -> { active, browser, context, lastRun }
const runners = new Map();

async function log(userId, level, message) {
  console.log(`[${level}][user:${userId}] ${message}`);
  try {
    await query(
      'INSERT INTO robot_logs (user_id, level, message) VALUES ($1, $2, $3)',
      [userId, level, message.substring(0, 2000)]
    );
    // Garder seulement les 200 derniers logs par user
    await query(
      `DELETE FROM robot_logs WHERE id IN (
         SELECT id FROM robot_logs WHERE user_id = $1
         ORDER BY created_at DESC OFFSET 200
       )`,
      [userId]
    );
  } catch (e) {
    // log silencieux
  }
}

// Convertit une chaîne de cookies Playwright/Chrome en format Playwright
function parseCookies(cookiesJson) {
  if (!cookiesJson) return [];
  let parsed;
  try {
    parsed = typeof cookiesJson === 'string' ? JSON.parse(cookiesJson) : cookiesJson;
  } catch (e) {
    // Format simple "name=value; name2=value2"
    parsed = cookiesJson.split(';').map((part) => {
      const [name, ...rest] = part.trim().split('=');
      return { name: name.trim(), value: rest.join('=').trim() };
    });
  }
  if (!Array.isArray(parsed)) return [];

  // Domaine par défaut managment.io
  return parsed
    .filter((c) => c && c.name)
    .map((c) => ({
      name: c.name,
      value: String(c.value || ''),
      domain: c.domain || '.managment.io',
      path: c.path || '/',
      httpOnly: c.httpOnly || false,
      secure: c.secure !== false,
      sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax',
    }));
}

// Convertit un texte de processing time en minutes (approx)
function processingTimeToMinutes(pt) {
  if (!pt) return 0;
  const text = pt.toLowerCase();
  if (text.includes('less than 1') || text.includes('moins')) return 0;
  let totalMin = 0;
  // jours
  let m = text.match(/(\d+)\s*jour/);
  if (m) totalMin += parseInt(m[1], 10) * 24 * 60;
  // heures
  m = text.match(/(\d+)\s*heure/);
  if (m) totalMin += parseInt(m[1], 10) * 60;
  // minutes
  m = text.match(/(\d+)\s*minute/);
  if (m) totalMin += parseInt(m[1], 10);
  return totalMin;
}

async function runOneCycleForUser(userId) {
  const settingsRes = await query(
    'SELECT cookies_json, threshold_minutes, robot_active FROM user_settings WHERE user_id = $1',
    [userId]
  );
  const s = settingsRes.rows[0];
  if (!s || !s.robot_active) return { stopped: true };

  const threshold = s.threshold_minutes || 120;
  const cookies = parseCookies(s.cookies_json);
  if (cookies.length === 0) {
    await log(userId, 'WARN', 'Aucun cookie injecté pour ce compte. Robot inactif.');
    return { error: 'Aucun cookie' };
  }

  await log(userId, 'INFO', `Début cycle (seuil=${threshold} min)`);
  let browser = null;
  let rejectedCount = 0;
  const errors = [];

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    });
    await context.addCookies(cookies);

    const page = await context.newPage();
    await page.goto(PENDING_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);

    // Vérifier qu'on est bien connecté
    const isLoginPage = await page
      .locator('input[type="password"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (isLoginPage) {
      await log(userId, 'ERROR', 'Cookies invalides ou expirés. Veuillez les remettre à jour.');
      await query(
        'UPDATE user_settings SET last_status = $1, last_run_at = NOW() WHERE user_id = $2',
        ['ERROR_AUTH', userId]
      );
      return { error: 'auth' };
    }

    // 1) Désactiver auto-update si actif
    try {
      const toggle = page.locator('text=/Mise à jour auto|Auto.?update/i').first();
      if (await toggle.isVisible({ timeout: 2000 }).catch(() => false)) {
        // chercher le switch ON à côté
        const onSwitch = page.locator('xpath=//*[contains(text(),"Mise à jour auto") or contains(text(),"auto")]/following::*[contains(@class,"on") or contains(@class,"toggle") or contains(@class,"switch")][1]');
        if (await onSwitch.first().isVisible({ timeout: 1000 }).catch(() => false)) {
          await onSwitch.first().click().catch(() => {});
        }
      }
    } catch (e) {}

    // Cliquer APPLIQUER
    const apply = page.locator('button:has-text("APPLIQUER"), button:has-text("Appliquer")').first();
    if (await apply.isVisible({ timeout: 3000 }).catch(() => false)) {
      await apply.click();
      await page.waitForTimeout(3000);
    }

    // Changer page-size à 500 si disponible
    try {
      // Le sélecteur est un combobox custom. On clique dessus puis on choisit 500.
      const sizeBox = page
        .locator('text="100", text="50", text="25"')
        .first();
      // Approche plus fiable : cliquer sur l'élément qui montre la pagination
      const pageSizeTrigger = page.locator('div').filter({ hasText: /^100$/ }).first();
      if (await pageSizeTrigger.isVisible({ timeout: 1500 }).catch(() => false)) {
        await pageSizeTrigger.click();
        await page.waitForTimeout(500);
        const opt500 = page.locator('text=/^500$/').first();
        if (await opt500.isVisible({ timeout: 1500 }).catch(() => false)) {
          await opt500.click();
          await page.waitForTimeout(500);
          if (await apply.isVisible({ timeout: 1500 }).catch(() => false)) {
            await apply.click();
            await page.waitForTimeout(3000);
          }
        }
      }
    } catch (e) {}

    // Boucle de rejet : tant qu'il reste des éligibles, traiter du plus ancien
    const MAX_PER_CYCLE = 500;
    for (let i = 0; i < MAX_PER_CYCLE; i++) {
      // Extraire les rangées et trouver la dernière (la plus ancienne, celle qui dépasse le plus)
      const rowInfo = await page.evaluate(() => {
        const rows = document.querySelectorAll('table tbody tr');
        if (rows.length === 0) return null;
        const data = [];
        rows.forEach((row) => {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 7) {
            data.push({
              infos: cells[0]?.innerText?.trim() || '',
              amount: cells[1]?.innerText?.trim() || '',
              processingTime: cells[3]?.innerText?.trim() || '',
              identifier: cells[5]?.innerText?.trim() || '',
              dateCreation: cells[6]?.innerText?.trim() || '',
              bankName: cells[7]?.innerText?.trim() || '',
            });
          }
        });
        return data;
      });

      if (!rowInfo || rowInfo.length === 0) break;
      const last = rowInfo[rowInfo.length - 1];
      const ptMin = processingTimeToMinutes(last.processingTime);
      if (ptMin <= threshold) {
        await log(userId, 'INFO', `Plus aucune demande > ${threshold} min. Cycle terminé.`);
        break;
      }

      // Extraire le numéro MTN/utilisateur depuis "infos" (ex: "Écrivez votre numéro MTN 0506144843")
      const phoneMatch = last.infos.match(/(\d{8,15})/);
      const userPhone = phoneMatch ? phoneMatch[1] : '';

      // Cliquer Rejeter sur la dernière ligne via JavaScript
      const result = await page.evaluate(async () => {
        const rows = document.querySelectorAll('table tbody tr');
        const last = rows[rows.length - 1];
        const cells = last.querySelectorAll('td');
        const link = cells[4].querySelector('a');
        if (!link) return { error: 'no link' };
        link.scrollIntoView({ block: 'center' });
        link.click();
        // Attendre l'apparition du modal
        let attempts = 0;
        while (attempts < 30) {
          const modalText = document.body.innerText;
          const numMatch = modalText.match(/N[°ºo]\s*(\d+)/);
          if (numMatch) {
            return { requestNumber: numMatch[1] };
          }
          await new Promise((r) => setTimeout(r, 100));
          attempts++;
        }
        return { error: 'modal not found' };
      });

      if (result.error) {
        await log(userId, 'WARN', `Échec ouverture modal: ${result.error}`);
        errors.push(result.error);
        // tenter de fermer un éventuel modal coincé en pressant Escape
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(500);
        continue;
      }

      // Remplir le commentaire et valider
      const filled = await page.evaluate(() => {
        const input = document.querySelector('input[placeholder="Commentaire"], input[placeholder="commentaire"]');
        if (!input) return { error: 'no input' };
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'AA');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          if (b.innerText.trim() === 'OK' && b.offsetParent !== null) {
            b.click();
            return { ok: true };
          }
        }
        return { error: 'no OK btn' };
      });

      if (filled.error) {
        await log(userId, 'WARN', `Échec validation: ${filled.error}`);
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(500);
        continue;
      }

      // Attendre que le rejet soit pris en compte
      await page.waitForTimeout(1500);

      // Enregistrer le rejet en base
      try {
        await query(
          `INSERT INTO rejections
           (user_id, request_number, deposit_id, user_phone, user_identifier, amount, bank_name, processing_time, threshold_used, success)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)`,
          [
            userId,
            result.requestNumber,
            last.identifier,
            userPhone,
            last.identifier,
            last.amount,
            last.bankName,
            last.processingTime,
            threshold,
          ]
        );
      } catch (e) {
        await log(userId, 'WARN', `DB insert rejection failed: ${e.message}`);
      }

      rejectedCount++;
      if (rejectedCount % 10 === 0) {
        await log(userId, 'INFO', `${rejectedCount} rejets effectués...`);
      }
    }

    await query(
      'UPDATE user_settings SET last_status = $1, last_run_at = NOW() WHERE user_id = $2',
      [`OK: ${rejectedCount} rejet(s)`, userId]
    );
    await log(userId, 'INFO', `Cycle terminé : ${rejectedCount} rejets.`);
    return { rejected: rejectedCount, errors };
  } catch (err) {
    await log(userId, 'ERROR', `Erreur cycle : ${err.message}`);
    await query(
      'UPDATE user_settings SET last_status = $1, last_run_at = NOW() WHERE user_id = $2',
      [`ERROR: ${err.message.substring(0, 200)}`, userId]
    );
    return { error: err.message };
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }
}

async function userLoop(userId) {
  while (runners.has(userId) && runners.get(userId).active) {
    try {
      await runOneCycleForUser(userId);
    } catch (e) {
      await log(userId, 'ERROR', `Boucle utilisateur: ${e.message}`);
    }
    // Pause de 30 secondes entre chaque cycle pour ne pas surcharger
    await new Promise((r) => setTimeout(r, 30000));
  }
  runners.delete(userId);
}

function startRobotForUser(userId) {
  if (runners.has(userId) && runners.get(userId).active) return;
  runners.set(userId, { active: true });
  log(userId, 'INFO', '▶️ Robot démarré.');
  userLoop(userId).catch((err) => {
    console.error(`User loop ${userId} crashed:`, err);
    runners.delete(userId);
  });
}

function stopRobotForUser(userId) {
  if (runners.has(userId)) {
    runners.get(userId).active = false;
    log(userId, 'INFO', '⏸ Robot arrêté.');
  }
}

function isRobotRunning(userId) {
  return runners.has(userId) && runners.get(userId).active;
}

// Au démarrage du serveur, relancer les robots des utilisateurs actifs
async function bootstrap() {
  console.log('🤖 Bootstrap des robots actifs...');
  try {
    const r = await query(
      `SELECT us.user_id FROM user_settings us
       JOIN users u ON u.id = us.user_id
       WHERE us.robot_active = TRUE AND u.is_active = TRUE`
    );
    for (const row of r.rows) {
      startRobotForUser(row.user_id);
    }
    console.log(`✅ ${r.rows.length} robot(s) relancé(s).`);
  } catch (e) {
    console.error('Bootstrap error:', e.message);
  }
}

module.exports = {
  startRobotForUser,
  stopRobotForUser,
  isRobotRunning,
  bootstrap,
};
