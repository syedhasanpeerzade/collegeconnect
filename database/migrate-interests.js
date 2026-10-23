'use strict';
/**
 * Idempotent migration runner for the interests/priority-notifications feature.
 * Usage: node database/migrate-interests.js
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
    const sql = fs.readFileSync(path.join(__dirname, 'migrate-interests.sql'), 'utf8');
    await client.query(sql);
    console.log('Migration OK: student_interests + notifications.priority/dedupe_key + users.interests_configured');
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error('Migration failed:', e.message); process.exit(1); });
