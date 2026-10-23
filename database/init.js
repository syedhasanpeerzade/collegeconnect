'use strict';
/**
 * Applies database/schema.sql and (optionally) database/seed.sql to the
 * PostgreSQL database configured in .env (works with Supabase).
 *
 *   npm run db:init          schema only
 *   npm run db:init -- --seed   schema + demo data
 *   npm run db:seed             demo data only
 */
const fs = require('fs');
const path = require('path');
const pg = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectionString =
  process.env.DATABASE_URL ||
  (() => {
    const { DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, DB_PORT } = process.env;
    if (DB_USER && DB_NAME) {
      return `postgresql://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD || '')}@${DB_HOST || 'localhost'}:${DB_PORT || 5432}/${DB_NAME}`;
    }
    return null;
  })();

if (!connectionString) {
  console.error('ERROR: set DATABASE_URL in .env (Supabase connection string).');
  process.exit(1);
}

const needsSsl =
  /supabase|neon|render|amazonaws|azure|heroku/i.test(connectionString) ||
  String(process.env.PGSSL || '').toLowerCase() === 'require';

async function runFile(pool, file) {
  const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
  process.stdout.write(`Applying ${file} ... `);
  try {
    await pool.query(sql);
    console.log('OK');
  } catch (e) {
    console.log('FAILED');
    console.error(e.message);
    throw e;
  }
}

(async () => {
  const wantSeed = process.argv.includes('--seed') || process.argv[2] === 'seed';
  const pool = new pg.Pool({ connectionString, ssl: needsSsl ? { rejectUnauthorized: false } : false });

  try {
    const { rows } = await pool.query('SELECT version()');
    console.log(`Connected: ${rows[0].version.split(' ').slice(0, 2).join(' ')}`);
    await runFile(pool, 'schema.sql');
    if (wantSeed) await runFile(pool, 'seed.sql');
    console.log(wantSeed ? 'Database initialized and seeded.' : 'Database schema applied. Run "npm run db:seed" for demo data.');
  } catch (e) {
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
