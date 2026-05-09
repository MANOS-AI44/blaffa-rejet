const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { authenticate } = require('../auth');
const { startRobotForUser, stopRobotForUser, isRobotRunning } = require('../workers/robot');

router.use(authenticate);

// Seuils autorisés en minutes
const ALLOWED_THRESHOLDS = [10, 13, 30, 120, 360];

// GET /api/me : profil + settings + état robot
router.get('/me', async (req, res) => {
  const userId = req.user.id;
  const u = await query('SELECT id, username, is_admin FROM users WHERE id = $1', [userId]);
  if (u.rows.length === 0) return res.status(404).json({ error: 'Introuvable' });
  const s = await query(
    `SELECT cookies_json IS NOT NULL AND cookies_json <> '' AS has_cookies,
            threshold_minutes, robot_active, last_run_at, last_status
     FROM user_settings WHERE user_id = $1`,
    [userId]
  );
  res.json({
    user: u.rows[0],
    settings: s.rows[0] || { has_cookies: false, threshold_minutes: 120, robot_active: false },
    robot_running: isRobotRunning(userId),
    allowed_thresholds: ALLOWED_THRESHOLDS,
  });
});

// POST /api/cookies : injecter/mettre à jour les cookies managment.io
router.post('/cookies', async (req, res) => {
  try {
    const userId = req.user.id;
    const { cookies } = req.body || {};
    if (!cookies) return res.status(400).json({ error: 'Cookies requis' });

    // Vérification de format
    let parsed = cookies;
    if (typeof cookies === 'string') {
      try {
        parsed = JSON.parse(cookies);
      } catch (e) {
        // Format texte simple "name=value; ..." accepté
        const parts = cookies.split(';').map((p) => {
          const [k, ...v] = p.trim().split('=');
          return { name: k.trim(), value: v.join('=').trim(), domain: '.managment.io', path: '/' };
        }).filter((c) => c.name);
        parsed = parts;
      }
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return res.status(400).json({ error: 'Format cookies invalide. Attendu : tableau JSON ou "name=value; name2=value2"' });
    }

    await query(
      `INSERT INTO user_settings (user_id, cookies_json, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET cookies_json = EXCLUDED.cookies_json, updated_at = NOW()`,
      [userId, JSON.stringify(parsed)]
    );
    res.json({ success: true, count: parsed.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/cookies : supprimer
router.delete('/cookies', async (req, res) => {
  await query('UPDATE user_settings SET cookies_json = NULL WHERE user_id = $1', [req.user.id]);
  stopRobotForUser(req.user.id);
  res.json({ success: true });
});

// POST /api/threshold : choisir le seuil (10, 13, 30, 120, 360)
router.post('/threshold', async (req, res) => {
  const userId = req.user.id;
  const { minutes } = req.body || {};
  const m = parseInt(minutes, 10);
  if (!ALLOWED_THRESHOLDS.includes(m)) {
    return res.status(400).json({ error: 'Seuil non autorisé. Valeurs : ' + ALLOWED_THRESHOLDS.join(', ') });
  }
  await query(
    `INSERT INTO user_settings (user_id, threshold_minutes, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET threshold_minutes = EXCLUDED.threshold_minutes, updated_at = NOW()`,
    [userId, m]
  );
  res.json({ success: true, threshold: m });
});

// POST /api/robot/start
router.post('/robot/start', async (req, res) => {
  const userId = req.user.id;
  const s = await query('SELECT cookies_json FROM user_settings WHERE user_id = $1', [userId]);
  if (s.rows.length === 0 || !s.rows[0].cookies_json) {
    return res.status(400).json({ error: 'Veuillez d\'abord injecter vos cookies managment.io' });
  }
  await query(
    `INSERT INTO user_settings (user_id, robot_active, updated_at)
     VALUES ($1, TRUE, NOW())
     ON CONFLICT (user_id) DO UPDATE SET robot_active = TRUE, updated_at = NOW()`,
    [userId]
  );
  startRobotForUser(userId);
  res.json({ success: true, running: true });
});

// POST /api/robot/stop
router.post('/robot/stop', async (req, res) => {
  const userId = req.user.id;
  await query('UPDATE user_settings SET robot_active = FALSE WHERE user_id = $1', [userId]);
  stopRobotForUser(userId);
  res.json({ success: true, running: false });
});

// GET /api/rejections : historique rejets de l'utilisateur
router.get('/rejections', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const r = await query(
    `SELECT id, request_number, deposit_id, user_phone, user_identifier,
            amount, bank_name, processing_time, threshold_used, rejected_at, success, error_msg
     FROM rejections
     WHERE user_id = $1
     ORDER BY rejected_at DESC
     LIMIT $2`,
    [req.user.id, limit]
  );
  res.json({ rejections: r.rows });
});

// GET /api/logs : journal du robot
router.get('/logs', async (req, res) => {
  const r = await query(
    `SELECT level, message, created_at FROM robot_logs
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [req.user.id]
  );
  res.json({ logs: r.rows });
});

// GET /api/stats : statistiques de l'utilisateur
router.get('/stats', async (req, res) => {
  const userId = req.user.id;
  const total = (await query('SELECT COUNT(*) FROM rejections WHERE user_id = $1', [userId])).rows[0].count;
  const today = (await query(
    "SELECT COUNT(*) FROM rejections WHERE user_id = $1 AND rejected_at > NOW() - INTERVAL '24 hours'",
    [userId]
  )).rows[0].count;
  const last7d = (await query(
    "SELECT COUNT(*) FROM rejections WHERE user_id = $1 AND rejected_at > NOW() - INTERVAL '7 days'",
    [userId]
  )).rows[0].count;
  res.json({
    total: parseInt(total),
    last24h: parseInt(today),
    last7d: parseInt(last7d),
  });
});

module.exports = router;
