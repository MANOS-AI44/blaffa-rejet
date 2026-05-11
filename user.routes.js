// Routes admin connecte (profil + mot de passe)
const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { authenticate } = require('../auth');

router.use(authenticate);

// GET /api/me : profil admin connecte
router.get('/me', async (req, res) => {
  const userId = req.user.id;
  const u = await query('SELECT id, username, is_admin FROM users WHERE id = $1', [userId]);
  if (u.rows.length === 0) return res.status(404).json({ error: 'Introuvable' });
  res.json({ user: u.rows[0] });
});

module.exports = router;
