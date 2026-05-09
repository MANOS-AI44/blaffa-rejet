// Dashboard utilisateur BLAFFA REJET
const API = '/api';
let currentMe = null;

const sectionTitles = {
  overview: "Vue d'ensemble",
  config: 'Cookies & Seuil',
  rejections: 'Historique des rejets',
  logs: 'Journal du robot',
  security: 'Sécurité',
};

const labelByMinutes = {
  10: '10 minutes',
  13: '13 minutes',
  30: '30 minutes',
  120: '2 heures',
  360: '6 heures',
};

async function api(path, options = {}) {
  const r = await fetch(API + path, {
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

function showSection(name) {
  document.querySelectorAll('.sidebar a[data-section]').forEach((a) => {
    a.classList.toggle('active', a.dataset.section === name);
  });
  ['overview', 'config', 'rejections', 'logs', 'security'].forEach((n) => {
    const el = document.getElementById('section-' + n);
    if (el) el.classList.toggle('hidden', n !== name);
  });
  document.getElementById('sectionTitle').textContent = sectionTitles[name] || '';

  if (name === 'rejections') loadRejections();
  if (name === 'logs') loadLogs();
}

document.querySelectorAll('.sidebar a[data-section]').forEach((a) => {
  a.addEventListener('click', () => showSection(a.dataset.section));
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' });
  window.location.href = '/';
});

async function refreshMe() {
  const me = await api('/me');
  currentMe = me;
  document.getElementById('userInfo').textContent = '👤 ' + me.user.username;

  // Statut robot
  const running = me.robot_running;
  const badge = document.getElementById('robotStatusBadge');
  badge.innerHTML = running
    ? '<span class="badge badge-success"><span class="status-dot green"></span>Robot actif</span>'
    : '<span class="badge badge-gray"><span class="status-dot gray"></span>Robot arrêté</span>';

  document.getElementById('robotState').innerHTML = running
    ? '<div class="alert alert-success">▶️ Le robot tourne en continu et rejette automatiquement les demandes éligibles.</div>'
    : '<div class="alert alert-info">⏸ Le robot est à l\'arrêt. Démarrez-le pour lancer le rejet automatique.</div>';

  document.getElementById('btnStart').disabled = running;
  document.getElementById('btnStop').disabled = !running;

  // Stats
  document.getElementById('statThreshold').textContent =
    labelByMinutes[me.settings.threshold_minutes] || me.settings.threshold_minutes + ' min';

  // Rendre les options de seuil
  const grid = document.getElementById('thresholdGrid');
  grid.innerHTML = '';
  me.allowed_thresholds.forEach((m) => {
    const div = document.createElement('div');
    div.className = 'threshold-option' + (m === me.settings.threshold_minutes ? ' active' : '');
    div.innerHTML = `<div class="label">Seuil</div><div class="value">${labelByMinutes[m] || m + ' min'}</div>`;
    div.addEventListener('click', async () => {
      try {
        await api('/threshold', { method: 'POST', body: { minutes: m } });
        await refreshMe();
      } catch (e) { alert(e.message); }
    });
    grid.appendChild(div);
  });

  // Cookies status
  const cs = document.getElementById('cookieStatus');
  cs.innerHTML = me.settings.has_cookies
    ? '<div class="alert alert-success">✅ Cookies enregistrés et prêts.</div>'
    : '<div class="alert alert-error">⚠️ Aucun cookie enregistré. Le robot ne pourra pas se connecter à managment.io.</div>';

  // Last run
  const lr = document.getElementById('lastRunInfo');
  if (me.settings.last_run_at) {
    const d = new Date(me.settings.last_run_at);
    lr.innerHTML = `Dernière exécution : <strong>${d.toLocaleString('fr-FR')}</strong> — ${me.settings.last_status || ''}`;
  } else {
    lr.innerHTML = 'Aucune exécution récente.';
  }
}

async function refreshStats() {
  try {
    const s = await api('/stats');
    document.getElementById('statTotal').textContent = s.total;
    document.getElementById('stat24h').textContent = s.last24h;
    document.getElementById('stat7d').textContent = s.last7d;
  } catch (e) { console.error(e); }
}

async function loadRejections() {
  const tbody = document.getElementById('rejectionsTbody');
  tbody.innerHTML = '<tr><td colspan="8">Chargement…</td></tr>';
  try {
    const data = await api('/rejections?limit=200');
    if (!data.rejections.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-muted">Aucun rejet pour le moment.</td></tr>';
      return;
    }
    tbody.innerHTML = data.rejections
      .map((r) => {
        const d = new Date(r.rejected_at);
        return `<tr>
          <td>${d.toLocaleString('fr-FR')}</td>
          <td><strong>${r.request_number || '-'}</strong></td>
          <td>${r.user_identifier || '-'}</td>
          <td>${r.user_phone || '-'}</td>
          <td>${r.amount || '-'}</td>
          <td>${r.bank_name || '-'}</td>
          <td>${r.processing_time || '-'}</td>
          <td><span class="badge badge-info">${labelByMinutes[r.threshold_used] || r.threshold_used}</span></td>
        </tr>`;
      })
      .join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" class="alert-error">${e.message}</td></tr>`;
  }
}

async function loadLogs() {
  const c = document.getElementById('logsContainer');
  c.textContent = 'Chargement…';
  try {
    const data = await api('/logs');
    if (!data.logs.length) {
      c.textContent = 'Aucun log pour le moment.';
      return;
    }
    c.innerHTML = data.logs
      .map((l) => `<div class="log-${l.level}">[${new Date(l.created_at).toLocaleTimeString('fr-FR')}] [${l.level}] ${l.message}</div>`)
      .join('');
  } catch (e) {
    c.textContent = e.message;
  }
}

document.getElementById('btnSaveCookies').addEventListener('click', async () => {
  try {
    const v = document.getElementById('cookiesInput').value.trim();
    if (!v) return alert('Veuillez coller vos cookies.');
    const r = await api('/cookies', { method: 'POST', body: { cookies: v } });
    alert(`✅ ${r.count} cookie(s) enregistré(s).`);
    document.getElementById('cookiesInput').value = '';
    refreshMe();
  } catch (e) { alert(e.message); }
});

document.getElementById('btnDeleteCookies').addEventListener('click', async () => {
  if (!confirm('Supprimer les cookies ? Le robot sera arrêté.')) return;
  await api('/cookies', { method: 'DELETE' });
  refreshMe();
});

document.getElementById('btnStart').addEventListener('click', async () => {
  try {
    await api('/robot/start', { method: 'POST' });
    await refreshMe();
  } catch (e) { alert(e.message); }
});
document.getElementById('btnStop').addEventListener('click', async () => {
  await api('/robot/stop', { method: 'POST' });
  await refreshMe();
});

document.getElementById('btnRefreshRejections').addEventListener('click', loadRejections);
document.getElementById('btnRefreshLogs').addEventListener('click', loadLogs);

document.getElementById('btnChangePwd').addEventListener('click', async () => {
  const a = document.getElementById('pwdAlert');
  a.classList.add('hidden');
  const cur = document.getElementById('currentPwd').value;
  const nw = document.getElementById('newPwd').value;
  if (!nw || nw.length < 6) {
    a.className = 'alert alert-error';
    a.textContent = 'Nouveau mot de passe trop court.';
    a.classList.remove('hidden');
    return;
  }
  try {
    await api('/auth/change-password', {
      method: 'POST',
      body: { current_password: cur, new_password: nw },
    });
    a.className = 'alert alert-success';
    a.textContent = '✅ Mot de passe modifié.';
    a.classList.remove('hidden');
    document.getElementById('currentPwd').value = '';
    document.getElementById('newPwd').value = '';
  } catch (e) {
    a.className = 'alert alert-error';
    a.textContent = e.message;
    a.classList.remove('hidden');
  }
});

// Initial load + auto-refresh des stats
(async () => {
  await refreshMe();
  await refreshStats();
  setInterval(() => {
    refreshMe();
    refreshStats();
    if (!document.getElementById('section-rejections').classList.contains('hidden')) loadRejections();
    if (!document.getElementById('section-logs').classList.contains('hidden')) loadLogs();
  }, 15000);
})();
