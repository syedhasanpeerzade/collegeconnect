'use strict';
/**
 * Applies database/seed-latest-results.sql (idempotent demo results).
 * Usage: node database/seed-latest-results.js
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
    await client.query(fs.readFileSync(path.join(__dirname, 'seed-latest-results.sql'), 'utf8'));
    const { rows } = await client.query(
      `SELECT a.public_id, a.title, a.position FROM achievements a WHERE a.public_id LIKE 'CC-SMP-RES%' ORDER BY a.id`
    );
    console.log('Demo results seeded:');
    rows.forEach((r) => console.log(' ', r.position, '-', r.title));
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
