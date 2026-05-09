const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { authenticate, requireAdmin, hashPassword } = require('../auth');
const { stopRobotForUser } = require('../workers/robot');

router.use(authenticate, requireAdmin);

// GET /api/admin/users
router.get('/users', async (req, res) => {
  const r = await query(
    `SELECT u.id, u.username, u.is_admin, u.is_active, u.created_at, u.last_login,
            us.robot_active, us.threshold_minutes, us.last_run_at, us.last_status,
            (SELECT COUNT(*) FROM rejections WHERE user_id = u.id) AS total_rejections
     FROM users u
     LEFT JOIN user_settings us ON us.user_id = u.id
     ORDER BY u.created_at ASC`
  );
  res.json({ users: r.rows });
});

// POST /api/admin/users : créer
router.post('/users', async (req, res) => {
  try {
    const { username, password, is_admin } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Mot de passe trop court (6+ caractères)' });
    }
    const exists = await query('SELECT id FROM users WHERE username = $1', [username.trim()]);
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: 'Identifiant déjà utilisé' });
    }
    const hash = await hashPassword(password);
    const ins = await query(
      'INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, $3) RETURNING id, username, is_admin',
      [username.trim(), hash, !!is_admin]
    );
    await query('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [ins.rows[0].id]);
    res.json({ success: true, user: ins.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/admin/users/:id : activer/désactiver, reset password, promote
router.put('/users/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { is_active, is_admin, new_password } = req.body || {};
    const fields = [];
    const vals = [];
    let idx = 1;
    if (typeof is_active === 'boolean') {
      fields.push(`is_active = $${idx++}`);
      vals.push(is_active);
      if (!is_active) stopRobotForUser(id);
    }
    if (typeof is_admin === 'boolean') {
      fields.push(`is_admin = $${idx++}`);
      vals.push(is_admin);
    }
    if (new_password && new_password.length >= 6) {
      const hash = await hashPassword(new_password);
      fields.push(`password_hash = $${idx++}`);
      vals.push(hash);
    }
    if (fields.length === 0) return res.json({ success: true });
    vals.push(id);
    await query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`, vals);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.status(400).json({ error: 'Vous ne pouvez pas vous supprimer vous-même' });
  stopRobotForUser(id);
  await query('DELETE FROM users WHERE id = $1', [id]);
  res.json({ success: true });
});

// GET /api/admin/rejections : tous les rejets
router.get('/rejections', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
  const r = await query(
    `SELECT r.*, u.username
     FROM rejections r
     JOIN users u ON u.id = r.user_id
     ORDER BY r.rejected_at DESC
     LIMIT $1`,
    [limit]
  );
  res.json({ rejections: r.rows });
});

// GET /api/admin/stats : agrégats
router.get('/stats', async (req, res) => {
  const totalUsers = (await query('SELECT COUNT(*) FROM users')).rows[0].count;
  const activeRobots = (await query('SELECT COUNT(*) FROM user_settings WHERE robot_active = TRUE')).rows[0].count;
  const totalRejections = (await query('SELECT COUNT(*) FROM rejections')).rows[0].count;
  const today = (await query("SELECT COUNT(*) FROM rejections WHERE rejected_at > NOW() - INTERVAL '24 hours'")).rows[0].count;
  res.json({
    totalUsers: parseInt(totalUsers),
    activeRobots: parseInt(activeRobots),
    totalRejections: parseInt(totalRejections),
    last24h: parseInt(today),
  });
});

module.exports = router;
