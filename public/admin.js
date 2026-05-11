// Admin BLAFFA REJET - gestion par plateformes
const labelByMinutes = { 10: '10 min', 13: '13 min', 30: '30 min', 120: '2 h', 360: '6 h' };
let currentCookiePlatform = null;
let currentLogsPlatform = null;
let allowedThresholds = [10, 13, 30, 120, 360];

async function api(path, options = {}) {
  const r = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch (e) {}
  if (!r.ok) {
    if (r.status === 401) { window.location.href = '/'; return; }
    throw new Error((data && data.error) || 'Erreur ' + r.status);
  }
  return data;
}

const titles = {
  overview: 'Vue globale',
  platforms: 'Plateformes',
  rejections: 'Tous les rejets',
  security: 'Mot de passe',
};

function showSection(name) {
  document.querySelectorAll('.sidebar a[data-section]').forEach((a) => {
    a.classList.toggle('active', a.dataset.section === name);
  });
  ['overview','platforms','rejections','security'].forEach((n) => {
    const el = document.getElementById('section-' + n);
    if (el) el.classList.toggle('hidden', n !== name);
  });
  document.getElementById('sectionTitle').textContent = titles[name] || '';
  if (name === 'overview') loadOverview();
  if (name === 'platforms') loadPlatforms();
  if (name === 'rejections') loadAllRejections();
}

document.querySelectorAll('.sidebar a[data-section]').forEach((a) => {
  a.addEventListener('click', () => showSection(a.dataset.section));
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' });
  window.location.href = '/';
});

async function loadMe() {
  const me = await api('/me');
  document.getElementById('userInfo').textContent = '👤 ' + me.user.username + ' (admin)';
}

async function loadOverview() {
  try {
    const stats = await api('/admin/stats');
    document.getElementById('statTotalPlatforms').textContent = stats.totalPlatforms;
    document.getElementById('statActiveRobots').textContent = stats.activeRobots;
    document.getElementById('statTotalRejections').textContent = stats.totalRejections;
    document.getElementById('stat24h').textContent = stats.last24h;
    const r = await api('/admin/rejections?limit=50');
    const tbody = document.getElementById('recentRejectionsTbody');
    if (!r.rejections.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-muted">Aucun rejet encore.</td></tr>';
    } else {
      tbody.innerHTML = r.rejections.map((x) => `<tr>
        <td>${new Date(x.rejected_at).toLocaleString('fr-FR')}</td>
        <td><strong>${x.platform_name || '-'}</strong></td>
        <td>${x.request_number || '-'}</td>
        <td>${x.user_identifier || '-'}</td>
        <td>${x.user_phone || '-'}</td>
        <td>${x.amount || '-'}</td>
        <td>${x.bank_name || '-'}</td>
        <td>${x.processing_time || '-'}</td>
      </tr>`).join('');
    }
  } catch (e) { console.error(e); }
}

async function loadPlatforms() {
  const tbody = document.getElementById('platformsTbody');
  tbody.innerHTML = '<tr><td colspan="7">Chargement…</td></tr>';
  try {
    const data = await api('/admin/platforms');
    allowedThresholds = data.allowed_thresholds || allowedThresholds;
    if (!data.platforms.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-muted">Aucune plateforme. Créez-en une ci-dessus.</td></tr>';
      return;
    }
    tbody.innerHTML = data.platforms.map((p) => {
      const cookies = p.has_cookies
        ? '<span class="badge badge-success">✅ OK</span>'
        : '<span class="badge badge-danger">⚠️ Aucun</span>';
      const robot = p.robot_active
        ? '<span class="badge badge-success"><span class="status-dot green"></span>Actif</span>'
        : '<span class="badge badge-gray">Inactif</span>';
      const seuilOptions = allowedThresholds.map(m =>
        `<option value="${m}" ${m === p.threshold_minutes ? 'selected' : ''}>${labelByMinutes[m] || m + ' min'}</option>`
      ).join('');
      const lastRun = p.last_run_at
        ? new Date(p.last_run_at).toLocaleString('fr-FR') + (p.last_status ? ` — ${p.last_status.substring(0,40)}` : '')
        : '-';
      const startStop = p.robot_active
        ? `<button class="btn btn-sm btn-danger" data-action="stop" data-id="${p.id}">⏸ Stop</button>`
        : `<button class="btn btn-sm btn-success" data-action="start" data-id="${p.id}">▶ Start</button>`;
      return `<tr>
        <td><strong>${p.name}</strong></td>
        <td>${cookies}</td>
        <td>
          <select data-action="threshold" data-id="${p.id}" class="select-sm">${seuilOptions}</select>
        </td>
        <td>${robot}</td>
        <td>${p.total_rejections}</td>
        <td class="text-sm">${lastRun}</td>
        <td>
          <div class="flex gap-8" style="flex-wrap:wrap">
            <button class="btn btn-sm btn-secondary" data-action="cookies" data-id="${p.id}" data-name="${p.name}">🍪 Cookies</button>
            ${startStop}
            <button class="btn btn-sm btn-secondary" data-action="logs" data-id="${p.id}" data-name="${p.name}">📜 Logs</button>
            <button class="btn btn-sm btn-warning" data-action="rename" data-id="${p.id}" data-name="${p.name}">✏️</button>
            <button class="btn btn-sm btn-danger" data-action="delete" data-id="${p.id}" data-name="${p.name}">🗑</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    // Selects de seuil
    tbody.querySelectorAll('select[data-action="threshold"]').forEach((sel) => {
      sel.addEventListener('change', async () => {
        try {
          await api('/admin/platforms/' + sel.dataset.id, { method: 'PUT', body: { threshold_minutes: parseInt(sel.value, 10) } });
        } catch (e) { alert(e.message); loadPlatforms(); }
      });
    });

    // Boutons d'action
    tbody.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const a = btn.dataset.action, id = btn.dataset.id, name = btn.dataset.name;
        try {
          if (a === 'start') {
            await api('/admin/platforms/' + id + '/start', { method: 'POST' });
            loadPlatforms();
          } else if (a === 'stop') {
            await api('/admin/platforms/' + id + '/stop', { method: 'POST' });
            loadPlatforms();
          } else if (a === 'cookies') {
            openCookieModal(id, name);
          } else if (a === 'logs') {
            openLogsModal(id, name);
          } else if (a === 'rename') {
            const np = prompt(`Nouveau nom pour la plateforme "${name}":`, name);
            if (!np || np === name) return;
            await api('/admin/platforms/' + id, { method: 'PUT', body: { name: np } });
            loadPlatforms();
          } else if (a === 'delete') {
            if (!confirm(`Supprimer définitivement la plateforme "${name}" ?\nTous ses rejets et logs seront effacés.`)) return;
            await api('/admin/platforms/' + id, { method: 'DELETE' });
            loadPlatforms();
          }
        } catch (e) { alert(e.message); }
      });
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="alert-error">${e.message}</td></tr>`;
  }
}

// ========== Modal cookies ==========
function openCookieModal(id, name) {
  currentCookiePlatform = id;
  document.getElementById('cookieModalName').textContent = name;
  document.getElementById('cookieModalInput').value = '';
  document.getElementById('cookieModalAlert').classList.add('hidden');
  document.getElementById('cookieModal').classList.remove('hidden');
}
function closeCookieModal() {
  document.getElementById('cookieModal').classList.add('hidden');
  currentCookiePlatform = null;
}
document.getElementById('cookieModalClose').addEventListener('click', closeCookieModal);
document.getElementById('cookieModalCancel').addEventListener('click', closeCookieModal);
document.getElementById('cookieModalSave').addEventListener('click', async () => {
  if (!currentCookiePlatform) return;
  const a = document.getElementById('cookieModalAlert');
  a.classList.add('hidden');
  const v = document.getElementById('cookieModalInput').value.trim();
  if (!v) { a.className = 'alert alert-error'; a.textContent = 'Veuillez coller des cookies.'; a.classList.remove('hidden'); return; }
  try {
    const r = await api('/admin/platforms/' + currentCookiePlatform + '/cookies', { method: 'POST', body: { cookies: v } });
    a.className = 'alert alert-success'; a.textContent = `✅ ${r.count} cookie(s) enregistré(s).`; a.classList.remove('hidden');
    setTimeout(() => { closeCookieModal(); loadPlatforms(); }, 800);
  } catch (e) { a.className = 'alert alert-error'; a.textContent = e.message; a.classList.remove('hidden'); }
});
document.getElementById('cookieModalDelete').addEventListener('click', async () => {
  if (!currentCookiePlatform) return;
  if (!confirm('Supprimer les cookies ? Le robot sera arrêté.')) return;
  await api('/admin/platforms/' + currentCookiePlatform + '/cookies', { method: 'DELETE' });
  closeCookieModal(); loadPlatforms();
});

// ========== Modal logs ==========
function openLogsModal(id, name) {
  currentLogsPlatform = id;
  document.getElementById('logsModalName').textContent = name;
  document.getElementById('logsModalContainer').textContent = 'Chargement…';
  document.getElementById('logsModal').classList.remove('hidden');
  refreshLogs();
}
function closeLogsModal() {
  document.getElementById('logsModal').classList.add('hidden');
  currentLogsPlatform = null;
}
async function refreshLogs() {
  if (!currentLogsPlatform) return;
  const c = document.getElementById('logsModalContainer');
  try {
    const data = await api('/admin/platforms/' + currentLogsPlatform + '/logs');
    if (!data.logs.length) { c.textContent = 'Aucun log pour le moment.'; return; }
    c.innerHTML = data.logs
      .map((l) => `<div class="log-${l.level}">[${new Date(l.created_at).toLocaleTimeString('fr-FR')}] [${l.level}] ${l.message}</div>`)
      .join('');
  } catch (e) { c.textContent = e.message; }
}
document.getElementById('logsModalClose').addEventListener('click', closeLogsModal);

async function loadAllRejections() {
  const tbody = document.getElementById('allRejectionsTbody');
  tbody.innerHTML = '<tr><td colspan="9">Chargement…</td></tr>';
  try {
    const data = await api('/admin/rejections?limit=500');
    if (!data.rejections.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="text-muted">Aucun rejet.</td></tr>';
      return;
    }
    tbody.innerHTML = data.rejections.map((x) => `<tr>
      <td>${new Date(x.rejected_at).toLocaleString('fr-FR')}</td>
      <td><strong>${x.platform_name || '-'}</strong></td>
      <td>${x.request_number || '-'}</td>
      <td>${x.user_identifier || '-'}</td>
      <td>${x.user_phone || '-'}</td>
      <td>${x.amount || '-'}</td>
      <td>${x.bank_name || '-'}</td>
      <td>${x.processing_time || '-'}</td>
      <td><span class="badge badge-info">${labelByMinutes[x.threshold_used] || x.threshold_used}</span></td>
    </tr>`).join('');
  } catch (e) { tbody.innerHTML = `<tr><td colspan="9" class="alert-error">${e.message}</td></tr>`; }
}

// Creation plateforme
document.getElementById('btnCreatePlatform').addEventListener('click', async () => {
  const a = document.getElementById('createAlert');
  a.classList.add('hidden');
  const name = document.getElementById('newPlatformName').value.trim();
  const threshold = parseInt(document.getElementById('newPlatformThreshold').value, 10);
  if (!name) {
    a.className = 'alert alert-error'; a.textContent = 'Nom requis.'; a.classList.remove('hidden'); return;
  }
  try {
    await api('/admin/platforms', { method: 'POST', body: { name, threshold_minutes: threshold } });
    a.className = 'alert alert-success'; a.textContent = `✅ Plateforme "${name}" créée. N'oubliez pas d'ajouter ses cookies.`; a.classList.remove('hidden');
    document.getElementById('newPlatformName').value = '';
    loadPlatforms();
  } catch (e) { a.className = 'alert alert-error'; a.textContent = e.message; a.classList.remove('hidden'); }
});

document.getElementById('btnRefreshAll').addEventListener('click', loadAllRejections);

// ========== Maintenance ==========
document.getElementById('btnRestartPlatforms').addEventListener('click', async () => {
  const a = document.getElementById('restartAlert');
  a.classList.add('hidden');
  if (!confirm('Redémarrer les robots ?\nLes plateformes actives seront stop/start (10s).')) return;
  try {
    const r = await api('/admin/restart-platforms', { method: 'POST' });
    a.className = 'alert alert-success';
    a.textContent = `♻️ ${r.count} plateforme(s) en cours de redémarrage. Ça reprend dans ~10 secondes.`;
    a.classList.remove('hidden');
    setTimeout(loadPlatforms, 12000);
  } catch (e) {
    a.className = 'alert alert-error'; a.textContent = e.message; a.classList.remove('hidden');
  }
});

document.getElementById('btnRestartServer').addEventListener('click', async () => {
  const a = document.getElementById('restartAlert');
  a.classList.add('hidden');
  if (!confirm('Redémarrer COMPLÈTEMENT le serveur ?\nLe service sera indisponible 30-60 secondes.\nRailway relancera automatiquement.')) return;
  try {
    await api('/admin/restart', { method: 'POST' });
    a.className = 'alert alert-info';
    a.innerHTML = '🔄 <strong>Redémarrage en cours…</strong> Patientez 30 à 60 secondes puis rafraîchissez la page.';
    a.classList.remove('hidden');
  } catch (e) {
    a.className = 'alert alert-error'; a.textContent = e.message; a.classList.remove('hidden');
  }
});

// Mot de passe admin
document.getElementById('btnChangePwd').addEventListener('click', async () => {
  const a = document.getElementById('pwdAlert');
  a.classList.add('hidden');
  const cur = document.getElementById('currentPwd').value;
  const nw = document.getElementById('newPwd').value;
  if (!nw || nw.length < 6) {
    a.className = 'alert alert-error'; a.textContent = 'Nouveau mot de passe trop court.'; a.classList.remove('hidden'); return;
  }
  try {
    await api('/auth/change-password', { method: 'POST', body: { current_password: cur, new_password: nw } });
    a.className = 'alert alert-success'; a.textContent = '✅ Mot de passe modifié.'; a.classList.remove('hidden');
    document.getElementById('currentPwd').value = '';
    document.getElementById('newPwd').value = '';
  } catch (e) { a.className = 'alert alert-error'; a.textContent = e.message; a.classList.remove('hidden'); }
});

(async () => {
  await loadMe();
  await loadOverview();
  setInterval(() => {
    if (!document.getElementById('section-overview').classList.contains('hidden')) loadOverview();
    if (!document.getElementById('section-platforms').classList.contains('hidden')) loadPlatforms();
    if (!document.getElementById('section-rejections').classList.contains('hidden')) loadAllRejections();
    if (currentLogsPlatform) refreshLogs();
  }, 15000);
})();
