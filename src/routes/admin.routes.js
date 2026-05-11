// Admin routes - gestion des plateformes managment.io
const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { authenticate, requireAdmin } = require('../auth');
const { startRobotForPlatform, stopRobotForPlatform, isRobotRunning } = require('../workers/robot');

router.use(authenticate, requireAdmin);

// Seuils autorises en minutes
const ALLOWED_THRESHOLDS = [10, 13, 30, 120, 360];

// ==================== PLATEFORMES ====================

// GET /api/admin/platforms - liste avec stats
router.get('/platforms', async (req, res) => {
  try {
    const r = await query(`
      SELECT p.id, p.name, p.threshold_minutes, p.robot_active,
             p.last_run_at, p.last_status, p.created_at,
             p.cookies_json IS NOT NULL AND p.cookies_json <> '' AS has_cookies,
             (SELECT COUNT(*) FROM rejections WHERE platform_id = p.id) AS total_rejections
      FROM platforms p
      ORDER BY p.created_at ASC
    `);
    const withRunning = r.rows.map(p => ({ ...p, robot_running: isRobotRunning(p.id) }));
    res.json({ platforms: withRunning, allowed_thresholds: ALLOWED_THRESHOLDS });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/admin/platforms - creer
router.post('/platforms', async (req, res) => {
  try {
    const { name, threshold_minutes } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nom de plateforme requis' });
    const cleanName = name.trim();
    const thr = parseInt(threshold_minutes, 10);
    const finalThr = ALLOWED_THRESHOLDS.includes(thr) ? thr : 120;
    const exists = await query('SELECT id FROM platforms WHERE name = $1', [cleanName]);
    if (exists.rows.length > 0) return res.status(409).json({ error: 'Nom deja utilise' });
    const ins = await query(
      'INSERT INTO platforms (name, threshold_minutes) VALUES ($1, $2) RETURNING id, name, threshold_minutes',
      [cleanName, finalThr]
    );
    res.json({ success: true, platform: ins.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/admin/platforms/:id - renommer / changer seuil
router.put('/platforms/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, threshold_minutes } = req.body || {};
    const fields = []; const vals = []; let idx = 1;
    if (name && name.trim()) {
      fields.push(`name = $${idx++}`); vals.push(name.trim());
    }
    if (threshold_minutes !== undefined) {
      const m = parseInt(threshold_minutes, 10);
      if (!ALLOWED_THRESHOLDS.includes(m)) {
        return res.status(400).json({ error: 'Seuil non autorise. Valeurs: ' + ALLOWED_THRESHOLDS.join(', ') });
      }
      fields.push(`threshold_minutes = $${idx++}`); vals.push(m);
    }
    if (fields.length === 0) return res.json({ success: true });
    fields.push(`updated_at = NOW()`);
    vals.push(id);
    await query(`UPDATE platforms SET ${fields.join(', ')} WHERE id = $${idx}`, vals);
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Nom deja utilise' });
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/admin/platforms/:id
router.delete('/platforms/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    stopRobotForPlatform(id);
    await query('DELETE FROM platforms WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/admin/platforms/:id/cookies - injecter/maj cookies
router.post('/platforms/:id/cookies', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { cookies } = req.body || {};
    if (!cookies) return res.status(400).json({ error: 'Cookies requis' });
    let parsed = cookies;
    if (typeof cookies === 'string') {
      try {
        parsed = JSON.parse(cookies);
      } catch (e) {
        const parts = cookies.split(';').map((p) => {
          const [k, ...v] = p.trim().split('=');
          return { name: k.trim(), value: v.join('=').trim(), domain: '.managment.io', path: '/' };
        }).filter((c) => c.name);
        parsed = parts;
      }
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return res.status(400).json({ error: 'Format cookies invalide. Attendu: tableau JSON ou "name=value; name2=value2"' });
    }
    await query(
      'UPDATE platforms SET cookies_json = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(parsed), id]
    );
    res.json({ success: true, count: parsed.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/admin/platforms/:id/cookies
router.delete('/platforms/:id/cookies', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await query('UPDATE platforms SET cookies_json = NULL WHERE id = $1', [id]);
  stopRobotForPlatform(id);
  res.json({ success: true });
});

// POST /api/admin/platforms/:id/start
router.post('/platforms/:id/start', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const s = await query('SELECT cookies_json FROM platforms WHERE id = $1', [id]);
    if (s.rows.length === 0) return res.status(404).json({ error: 'Plateforme introuvable' });
    if (!s.rows[0].cookies_json) {
      return res.status(400).json({ error: 'Veuillez d\'abord injecter les cookies managment.io' });
    }
    await query('UPDATE platforms SET robot_active = TRUE, updated_at = NOW() WHERE id = $1', [id]);
    startRobotForPlatform(id);
    res.json({ success: true, running: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/admin/platforms/:id/stop
router.post('/platforms/:id/stop', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await query('UPDATE platforms SET robot_active = FALSE WHERE id = $1', [id]);
  stopRobotForPlatform(id);
  res.json({ success: true, running: false });
});

// GET /api/admin/platforms/:id/logs - journal robot par plateforme
router.get('/platforms/:id/logs', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await query(
    `SELECT level, message, created_at FROM robot_logs
     WHERE platform_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [id]
  );
  res.json({ logs: r.rows });
});

// GET /api/admin/platforms/:id/rejections - historique par plateforme
router.get('/platforms/:id/rejections', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
  const r = await query(
    `SELECT id, request_number, deposit_id, user_phone, user_identifier,
            amount, bank_name, processing_time, threshold_used, rejected_at, success, error_msg
     FROM rejections WHERE platform_id = $1
     ORDER BY rejected_at DESC LIMIT $2`,
    [id, limit]
  );
  res.json({ rejections: r.rows });
});

// ==================== AGREGATS ====================

// GET /api/admin/rejections - tous les rejets toutes plateformes
router.get('/rejections', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
  const r = await query(
    `SELECT r.*, p.name AS platform_name
     FROM rejections r
     LEFT JOIN platforms p ON p.id = r.platform_id
     WHERE r.platform_id IS NOT NULL
     ORDER BY r.rejected_at DESC
     LIMIT $1`,
    [limit]
  );
  res.json({ rejections: r.rows });
});

// GET /api/admin/stats
router.get('/stats', async (req, res) => {
  const totalPlatforms = (await query('SELECT COUNT(*) FROM platforms')).rows[0].count;
  const activeRobots = (await query('SELECT COUNT(*) FROM platforms WHERE robot_active = TRUE')).rows[0].count;
  const totalRejections = (await query('SELECT COUNT(*) FROM rejections WHERE platform_id IS NOT NULL')).rows[0].count;
  const today = (await query("SELECT COUNT(*) FROM rejections WHERE platform_id IS NOT NULL AND rejected_at > NOW() - INTERVAL '24 hours'")).rows[0].count;
  res.json({
    totalPlatforms: parseInt(totalPlatforms),
    activeRobots: parseInt(activeRobots),
    totalRejections: parseInt(totalRejections),
    last24h: parseInt(today),
  });
});

module.exports = router;
