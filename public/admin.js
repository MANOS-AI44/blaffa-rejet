// Admin BLAFFA REJET
const labelByMinutes = { 10: '10 min', 13: '13 min', 30: '30 min', 120: '2 h', 360: '6 h' };

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

const titles = { overview: 'Vue globale', users: 'Utilisateurs', rejections: 'Tous les rejets', myDashboard: 'Mon espace' };

function showSection(name) {
  document.querySelectorAll('.sidebar a[data-section]').forEach((a) => {
    a.classList.toggle('active', a.dataset.section === name);
  });
  ['overview','users','rejections','myDashboard'].forEach((n) => {
    const el = document.getElementById('section-' + n);
    if (el) el.classList.toggle('hidden', n !== name);
  });
  document.getElementById('sectionTitle').textContent = titles[name] || '';
  if (name === 'overview') loadOverview();
  if (name === 'users') loadUsers();
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
    document.getElementById('statTotalUsers').textContent = stats.totalUsers;
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
        <td><strong>${x.username}</strong></td>
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

async function loadUsers() {
  const tbody = document.getElementById('usersTbody');
  tbody.innerHTML = '<tr><td colspan="8">Chargement…</td></tr>';
  try {
    const data = await api('/admin/users');
    if (!data.users.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-muted">Aucun utilisateur.</td></tr>';
      return;
    }
    tbody.innerHTML = data.users.map((u) => {
      const robot = u.robot_active
        ? '<span class="badge badge-success"><span class="status-dot green"></span>Actif</span>'
        : '<span class="badge badge-gray">Inactif</span>';
      const role = u.is_admin
        ? '<span class="badge badge-warning">Admin</span>'
        : '<span class="badge badge-info">Utilisateur</span>';
      const status = u.is_active
        ? '<span class="badge badge-success">Activé</span>'
        : '<span class="badge badge-danger">Désactivé</span>';
      const seuil = labelByMinutes[u.threshold_minutes] || u.threshold_minutes + ' min';
      const lastRun = u.last_run_at
        ? new Date(u.last_run_at).toLocaleString('fr-FR') + (u.last_status ? ` — ${u.last_status.substring(0,40)}` : '')
        : '-';
      return `<tr>
        <td><strong>${u.username}</strong></td>
        <td>${role}</td>
        <td>${status}</td>
        <td>${robot}</td>
        <td>${seuil}</td>
        <td>${u.total_rejections}</td>
        <td class="text-sm">${lastRun}</td>
        <td>
          <div class="flex gap-8">
            <button class="btn btn-sm btn-secondary" data-action="toggle-active" data-id="${u.id}" data-val="${!u.is_active}">${u.is_active ? '🔒 Désactiver' : '🔓 Activer'}</button>
            <button class="btn btn-sm btn-warning" data-action="reset-pwd" data-id="${u.id}" data-name="${u.username}">🔑 MdP</button>
            <button class="btn btn-sm btn-danger" data-action="delete" data-id="${u.id}" data-name="${u.username}">🗑</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    // Délégation des actions
    tbody.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const a = btn.dataset.action, id = btn.dataset.id;
        try {
          if (a === 'toggle-active') {
            await api('/admin/users/' + id, { method: 'PUT', body: { is_active: btn.dataset.val === 'true' } });
          } else if (a === 'reset-pwd') {
            const np = prompt(`Nouveau mot de passe pour "${btn.dataset.name}" (6+ car.) :`);
            if (!np) return;
            await api('/admin/users/' + id, { method: 'PUT', body: { new_password: np } });
            alert('✅ Mot de passe modifié.');
          } else if (a === 'delete') {
            if (!confirm(`Supprimer définitivement l'utilisateur "${btn.dataset.name}" ?`)) return;
            await api('/admin/users/' + id, { method: 'DELETE' });
          }
          loadUsers();
        } catch (e) { alert(e.message); }
      });
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" class="alert-error">${e.message}</td></tr>`;
  }
}

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
      <td><strong>${x.username}</strong></td>
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

document.getElementById('btnCreateUser').addEventListener('click', async () => {
  const a = document.getElementById('createAlert');
  a.classList.add('hidden');
  const username = document.getElementById('newUsername').value.trim();
  const password = document.getElementById('newPassword').value;
  const is_admin = document.getElementById('newIsAdmin').checked;
  if (!username || !password) {
    a.className = 'alert alert-error'; a.textContent = 'Champs requis.'; a.classList.remove('hidden'); return;
  }
  try {
    await api('/admin/users', { method: 'POST', body: { username, password, is_admin } });
    a.className = 'alert alert-success'; a.textContent = `✅ Utilisateur "${username}" créé.`; a.classList.remove('hidden');
    document.getElementById('newUsername').value = '';
    document.getElementById('newPassword').value = '';
    document.getElementById('newIsAdmin').checked = false;
    loadUsers();
  } catch (e) { a.className = 'alert alert-error'; a.textContent = e.message; a.classList.remove('hidden'); }
});

document.getElementById('btnRefreshAll').addEventListener('click', loadAllRejections);

(async () => {
  await loadMe();
  await loadOverview();
  setInterval(() => {
    if (!document.getElementById('section-overview').classList.contains('hidden')) loadOverview();
    if (!document.getElementById('section-users').classList.contains('hidden')) loadUsers();
    if (!document.getElementById('section-rejections').classList.contains('hidden')) loadAllRejections();
  }, 15000);
})();
