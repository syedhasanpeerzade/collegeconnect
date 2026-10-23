'use strict';

/**
 * Idempotent migration runner for the achievement management feature
 * (adds administrative columns to `achievements` + `achievement_stats` view).
 * Usage: node database/migrate-achievement-management.js
 * (server.js also runs this automatically on boot, before the app boots.)
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const ssl = /supabase|neon|render|amazonaws|azure|heroku/i.test(connectionString)
    ? { rejectUnauthorized: false } : false;

  const client = new Client({ connectionString, ssl });
  await client.connect();
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'migrate-achievement-management.sql'), 'utf8');
    await client.query(sql);
    console.log('Migration OK: achievement management (columns + achievement_stats view)');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Achievement-management migration failed:', e.message);
    process.exit(1);
  });
} else {
  module.exports = main();
}
