// Initialise les tables et crée le compte admin par défaut
require('dotenv').config();
const bcrypt = require('bcrypt');
const { pool, query } = require('../db');

async function init() {
  console.log('🔧 Initialisation de la base de données BLAFFA REJET...');

  try {
    // Table users
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(64) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        is_admin BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        last_login TIMESTAMP
      )
    `);

    // Table user_settings : cookies + seuil + état du robot
    await query(`
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        cookies_json TEXT,
        threshold_minutes INTEGER DEFAULT 120,
        robot_active BOOLEAN DEFAULT FALSE,
        last_run_at TIMESTAMP,
        last_status TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Table rejections : historique détaillé des rejets
    await query(`
      CREATE TABLE IF NOT EXISTS rejections (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        request_number VARCHAR(64),
        deposit_id VARCHAR(64),
        user_phone VARCHAR(64),
        user_identifier VARCHAR(64),
        amount VARCHAR(32),
        bank_name VARCHAR(128),
        processing_time TEXT,
        threshold_used INTEGER,
        rejected_at TIMESTAMP DEFAULT NOW(),
        success BOOLEAN DEFAULT TRUE,
        error_msg TEXT
      )
    `);

    await query(`CREATE INDEX IF NOT EXISTS idx_rejections_user ON rejections(user_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_rejections_date ON rejections(rejected_at DESC)`);

    // Table robot_logs : journal du robot pour debug
    await query(`
      CREATE TABLE IF NOT EXISTS robot_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        level VARCHAR(16),
        message TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await query(`CREATE INDEX IF NOT EXISTS idx_logs_user_date ON robot_logs(user_id, created_at DESC)`);

    // Créer le compte admin par défaut s'il n'existe pas
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

    const existing = await query('SELECT id FROM users WHERE username = $1', [adminUsername]);
    if (existing.rows.length === 0) {
      const hash = await bcrypt.hash(adminPassword, 10);
      const ins = await query(
        'INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, TRUE) RETURNING id',
        [adminUsername, hash]
      );
      await query('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [ins.rows[0].id]);
      console.log(`✅ Compte admin créé : ${adminUsername} / ${adminPassword}`);
    } else {
      console.log(`ℹ️  Le compte admin "${adminUsername}" existe déjà.`);
    }

    console.log('✅ Base de données initialisée avec succès.');
  } catch (err) {
    console.error('❌ Erreur initialisation DB :', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

init();
