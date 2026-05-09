process.stdout.write('=== SERVER.JS STARTING ===\n');
process.on('uncaughtException', (e) => {
  console.error('SERVER UNCAUGHT:', e);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error('SERVER UNHANDLED:', e);
  process.exit(1);
});

try {
  require('dotenv').config();
  process.stdout.write('dotenv OK\n');
} catch (e) {
  console.error('dotenv:', e.message);
}

const path = require('path');
process.stdout.write('path OK\n');

const express = require('express');
process.stdout.write('express OK\n');

const helmet = require('helmet');
process.stdout.write('helmet OK\n');

const rateLimit = require('express-rate-limit');
process.stdout.write('rate-limit OK\n');

const cookieParser = require('cookie-parser');
process.stdout.write('cookie-parser OK\n');

let authRoutes, userRoutes, adminRoutes;
try {
  authRoutes = require('./routes/auth.routes');
  process.stdout.write('auth.routes OK\n');
} catch (e) {
  console.error('auth.routes:', e.message);
  throw e;
}
try {
  userRoutes = require('./routes/user.routes');
  process.stdout.write('user.routes OK\n');
} catch (e) {
  console.error('user.routes:', e.message);
  throw e;
}
try {
  adminRoutes = require('./routes/admin.routes');
  process.stdout.write('admin.routes OK\n');
} catch (e) {
  console.error('admin.routes:', e.message);
  throw e;
}

const app = express();
process.stdout.write('express app cree\n');

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 30, message: { error: 'Trop de tentatives' } });
app.use('/api/auth', authLimiter);

app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'BLAFFA REJET' }));

app.use('/api/auth', authRoutes);
app.use('/api', userRoutes);
app.use('/api/admin', adminRoutes);
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

process.stdout.write('routes montees, call app.listen(PORT)\n');
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  process.stdout.write('=== BLAFFA REJET READY ON PORT ' + PORT + ' ===\n');
  setTimeout(() => {
    try {
      const { bootstrap } = require('./workers/robot');
      bootstrap().catch((e) => console.error('Bootstrap:', e));
    } catch (e) {
      console.error('Robot:', e.message);
    }
  }, 2000);
});

server.on('error', (e) => {
  console.error('SERVER ERROR:', e.message);
  process.exit(1);
});
