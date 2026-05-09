const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { verifyPassword, signToken, hashPassword } = require('../auth');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
    }
    const r = await query(
      'SELECT id, username, password_hash, is_admin, is_active FROM users WHERE username = $1',
      [username.trim()]
    );
    if (r.rows.length === 0) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }
    const user = r.rows[0];
    if (!user.is_active) {
      return res.status(403).json({ error: 'Compte désactivé. Contactez l\'administrateur.' });
    }
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }
    await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
    const token = signToken(user);
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.json({
      success: true,
      user: { id: user.id, username: user.username, is_admin: user.is_admin },
      token,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.json({ success: true });
});

// POST /api/auth/change-password (utilisateur connecté)
router.post('/change-password', async (req, res) => {
  try {
    const token = req.cookies?.auth_token;
    if (!token) return res.status(401).json({ error: 'Non authentifié' });
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, require('../auth').JWT_SECRET);
    const { current_password, new_password } = req.body || {};
    if (!new_password || new_password.length < 6) {
      return res.status(400).json({ error: 'Nouveau mot de passe trop court (6+ caractères)' });
    }
    const r = await query('SELECT password_hash FROM users WHERE id = $1', [decoded.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const ok = await verifyPassword(current_password || '', r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
    const newHash = await hashPassword(new_password);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, decoded.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
