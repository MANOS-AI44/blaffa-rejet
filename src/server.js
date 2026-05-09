require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');

const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const adminRoutes = require('./routes/admin.routes');

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

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Trop de tentatives, reessayez plus tard.' },
});
app.use('/api/auth', authLimiter);

app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'BLAFFA REJET' }));

app.use('/api/auth', authRoutes);
app.use('/api', userRoutes);
app.use('/api/admin', adminRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('BLAFFA REJET pret sur le port ' + PORT);
  // Lazy-load le robot apres le demarrage du serveur
  setTimeout(() => {
    try {
      const { bootstrap } = require('./workers/robot');
      bootstrap().catch((e) => console.error('Bootstrap robots:', e));
    } catch (e) {
      console.error('Robot worker not available:', e.message);
    }
  }, 1000);
});
