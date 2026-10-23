'use strict';
/**
 * Idempotent migration runner for content reporting + moderation (Phase 4).
 * Usage: node database/migrate-reports.js
 * (server.js also runs this automatically on boot via migrate-reports.js)
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
    const sql = fs.readFileSync(path.join(__dirname, 'migrate-reports.sql'), 'utf8');
    await client.query(sql);
    console.log('Migration OK: content reporting + moderation (post/comment/user reports, shields, rate-limit counters)');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('Reports migration failed:', e.message); process.exit(1); });
} else {
  module.exports = main();
}
