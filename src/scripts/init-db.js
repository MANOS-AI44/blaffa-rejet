// Init DB - simplified with early logging
process.stdout.write('=== INIT-DB STARTING ===\n');
process.on('uncaughtException', (e) => {
  console.error('UNCAUGHT:', e);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error('UNHANDLED:', e);
  process.exit(1);
});

try {
  require('dotenv').config();
  process.stdout.write('dotenv OK\n');
} catch (e) {
  console.error('dotenv failed:', e.message);
}

const bcrypt = require('bcrypt');
process.stdout.write('bcrypt loaded\n');

const { pool, query } = require('../db');
process.stdout.write('db module loaded\n');

async function init() {
  process.stdout.write('init() called\n');
  try {
    process.stdout.write('Testing DB connection...\n');
    await query('SELECT 1');
    process.stdout.write('DB connection OK\n');

    await query('CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username VARCHAR(64) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL, is_admin BOOLEAN DEFAULT FALSE, is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT NOW(), last_login TIMESTAMP)');
    await query('CREATE TABLE IF NOT EXISTS user_settings (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, cookies_json TEXT, threshold_minutes INTEGER DEFAULT 120, robot_active BOOLEAN DEFAULT FALSE, last_run_at TIMESTAMP, last_status TEXT, updated_at TIMESTAMP DEFAULT NOW())');
    await query('CREATE TABLE IF NOT EXISTS rejections (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, request_number VARCHAR(64), deposit_id VARCHAR(64), user_phone VARCHAR(64), user_identifier VARCHAR(64), amount VARCHAR(32), bank_name VARCHAR(128), processing_time TEXT, threshold_used INTEGER, rejected_at TIMESTAMP DEFAULT NOW(), success BOOLEAN DEFAULT TRUE, error_msg TEXT)');
    await query('CREATE INDEX IF NOT EXISTS idx_rejections_user ON rejections(user_id)');
    await query('CREATE INDEX IF NOT EXISTS idx_rejections_date ON rejections(rejected_at DESC)');
    await query('CREATE TABLE IF NOT EXISTS robot_logs (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, level VARCHAR(16), message TEXT, created_at TIMESTAMP DEFAULT NOW())');
    await query('CREATE INDEX IF NOT EXISTS idx_logs_user_date ON robot_logs(user_id, created_at DESC)');
    process.stdout.write('Tables OK\n');

    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
    const existing = await query('SELECT id FROM users WHERE username = $1', [adminUser]);
    if (existing.rows.length === 0) {
      const hash = await bcrypt.hash(adminPass, 10);
      const ins = await query('INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, TRUE) RETURNING id', [adminUser, hash]);
      await query('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [ins.rows[0].id]);
      process.stdout.write('Admin cree: ' + adminUser + '\n');
    } else {
      process.stdout.write('Admin existe deja\n');
    }
    process.stdout.write('=== INIT-DB DONE ===\n');
  } catch (err) {
    console.error('INIT-DB ERROR:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    try { await pool.end(); } catch (e) {}
  }
}

init();
