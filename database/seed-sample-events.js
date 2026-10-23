'use strict';
/**
 * Applies database/seed-sample-events.sql to the database (idempotent).
 * Usage: node database/seed-sample-events.js   (or npm run db:seed:events)
 *
 * Uses a raw pg client (not the app's mysql2-emulating adapter) because the
 * adapter auto-appends RETURNING id to INSERTs, which is invalid inside a
 * DO $$ ... $$ block.
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
    const sql = fs.readFileSync(path.join(__dirname, 'seed-sample-events.sql'), 'utf8');
    await client.query(sql);
    const { rows } = await client.query(
      `SELECT category, COUNT(*)::int AS n FROM events WHERE public_id LIKE 'CC-SMP-EVT%' GROUP BY category ORDER BY category`
    );
    console.log('Sample events seeded:', rows.map((r) => `${r.category}=${r.n}`).join(', '));
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
