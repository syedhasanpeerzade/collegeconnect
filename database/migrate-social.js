'use strict';
/**
 * Idempotent migration runner for the social layer (Phase 1).
 * Usage: node database/migrate-social.js
 * (server.js also runs this automatically on boot.)
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
    const sql = fs.readFileSync(path.join(__dirname, 'migrate-social.sql'), 'utf8');
    await client.query(sql);
    console.log('Migration OK: social layer (account_type/verified, posts, comments, reactions, follows, polls, communities)');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('Social migration failed:', e.message); process.exit(1); });
} else {
  // Required (e.g. by server.js boot): expose the migration promise so the
  // caller can await / sequence it instead of racing other migrations.
  module.exports = main();
}
