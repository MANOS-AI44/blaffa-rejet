require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');

const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const adminRoutes = require('./routes/admin.routes');
const { bootstrap } = require('./workers/robot');

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'", "'unsafe-inline'"],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
      },
    },
  })
);
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

// Rate limiting sur les endpoints auth pour limiter le brute-force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Trop de tentatives, réessayez plus tard.' },
});
app.use('/api/auth', authLimiter);

// Health check pour Railway
app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'BLAFFA REJET' }));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api', userRoutes);
app.use('/api/admin', adminRoutes);

// Servir les fichiers statiques du frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// Catch-all : renvoie l'index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 BLAFFA REJET prêt sur le port ${PORT}`);
  // Lancer les robots des utilisateurs déjà actifs
  bootstrap().catch((e) => console.error('Bootstrap robots:', e));
});
