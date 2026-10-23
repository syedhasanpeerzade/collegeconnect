'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pg = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

/**
 * PostgreSQL (Supabase) adapter that mimics the small mysql2 surface this app
 * uses: pool.execute(sql, params), transactions via getConnection, insertId /
 * affectedRows, and `?` placeholders converted to $1..$n.
 *
 * Supabase provides PostgreSQL, so the data layer was ported from MySQL.
 * MySQL-only syntax is translated centrally here so the service layer keeps
 * its original, readable shape:
 *   CURDATE()                     -> CURRENT_DATE
 *   NOW()                         -> CURRENT_TIMESTAMP
 *   DATE_ADD(x, INTERVAL n UNIT)  -> (x + INTERVAL 'n units')
 *   DATE_SUB(x, INTERVAL n UNIT)  -> (x - INTERVAL 'n units')
 *   DATE_FORMAT(x, '%Y-%m')       -> TO_CHAR(x, 'YYYY-MM')
 *   GROUP_CONCAT(...)             -> string_agg(...)
 *   FIELD(a,'x','y')              -> CASE a WHEN 'x' THEN 1 ... END
 *   INSERT ... VALUES ...         -> gains RETURNING id so insertId works
 *   COUNT(*) ... FOR UPDATE       -> FOR UPDATE dropped (illegal in PG)
 *   LIMIT ? / OFFSET ?            -> $n::int
 * JS booleans are coerced to 1/0 because boolean-ish columns are SMALLINT.
 */

// pg returns int8/numeric/date/time as strings by default; normalize here so
// the service layer sees numbers and 'YYYY-MM-DD' / 'HH:MM:SS' like it did
// with mysql2.
pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));    // int8
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));    // numeric
pg.types.setTypeParser(1082, (v) => (v === null ? null : String(v)));        // date
pg.types.setTypeParser(1083, (v) => (v === null ? null : String(v)));        // time
pg.types.setTypeParser(1266, (v) => (v === null ? null : String(v)));        // timetz

const MYSQL_FORMAT_MAP = {
  '%Y': 'YYYY', '%y': 'YY', '%m': 'MM', '%c': 'FMMM', '%d': 'DD', '%e': 'FMDD',
  '%H': 'HH24', '%k': 'FH24', '%h': 'HH12', '%i': 'MI', '%s': 'SS',
};

function translateDateTimeFunctions(sql) {
  let out = sql.replace(/\bCURDATE\(\s*\)/gi, 'CURRENT_DATE');
  out = out.replace(/\bNOW\(\s*\)/gi, 'CURRENT_TIMESTAMP');
  out = out.replace(/\bDATE_ADD\(\s*([^,()]+?)\s*,\s*INTERVAL\s+(\d+)\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)S?\s*\)/gi,
    (_m, expr, n, unit) => `(${expr} + INTERVAL '${n} ${unit.toLowerCase()}s')`);
  out = out.replace(/\bDATE_SUB\(\s*([^,()]+?)\s*,\s*INTERVAL\s+(\d+)\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)S?\s*\)/gi,
    (_m, expr, n, unit) => `(${expr} - INTERVAL '${n} ${unit.toLowerCase()}s')`);
  out = out.replace(/\bDATE_FORMAT\(\s*([^,()]+?)\s*,\s*'([^']*)'\s*\)/gi, (_m, expr, fmt) => {
    const pgFmt = fmt.replace(/%[YymcdeHkhis]/g, (t) => MYSQL_FORMAT_MAP[t] || t);
    return `TO_CHAR(${expr}, '${pgFmt}')`;
  });
  return out;
}

function translateGroupConcat(sql) {
  let out = sql.replace(
    /\bGROUP_CONCAT\(\s*DISTINCT\s+([^()]+?)\s+ORDER\s+BY\s+([^()]+?)\s+SEPARATOR\s+'([^']*)'\s*\)/gi,
    (_m, expr, order, sep) => `string_agg(DISTINCT ${expr}, '${sep}' ORDER BY ${order})`
  );
  out = out.replace(
    /\bGROUP_CONCAT\(\s*([^()]+?)\s+SEPARATOR\s+'([^']*)'\s*\)/gi,
    (_m, expr, sep) => `string_agg(${expr}::text, '${sep}')`
  );
  out = out.replace(/\bGROUP_CONCAT\(\s*([^()]+?)\s*\)/gi, (_m, expr) => `string_agg(${expr}::text, ',')`);
  return out;
}

function translateField(sql) {
  return sql.replace(/\bFIELD\(\s*([^(),]+?)\s*,\s*((?:'[^']*'\s*,\s*)*'[^']*')\s*\)/gi, (_m, expr, list) => {
    const values = list.match(/'[^']*'/g) || [];
    const whens = values.map((v, i) => `WHEN ${v} THEN ${i + 1}`).join(' ');
    return `CASE ${expr} ${whens} ELSE ${values.length + 1} END`;
  });
}

/**
 * Full translation pipeline:
 *  1. MySQL function/expression translation
 *  2. structural fixes (COUNT FOR UPDATE, RETURNING id)
 *  3. quote-aware `?` -> $n (with ::int cast right after LIMIT/OFFSET)
 */
function translate(sql) {
  let out = translateDateTimeFunctions(sql);
  out = translateGroupConcat(out);
  out = translateField(out);

  // COUNT(*) cannot take FOR UPDATE row locks in Postgres
  if (/\bCOUNT\s*\(\s*\*\s*\)/i.test(out)) {
    out = out.replace(/\s+FOR\s+UPDATE\s*(;)?\s*$/i, '$1');
  }

  // INSERT ... VALUES (...) gains RETURNING id so insertId is populated
  if (/\bINSERT\s+INTO\b/i.test(out) && !/\bRETURNING\b/i.test(out) && /\bVALUES\b/i.test(out)) {
    out = `${out.replace(/\s+$/, '')} RETURNING id`;
  }

  let i = 0;
  let res = '';
  let inString = false;
  for (let k = 0; k < out.length; k++) {
    const ch = out[k];
    if (ch === "'" && out[k + 1] === "'") { res += "''"; k++; continue; }
    if (ch === "'") { inString = !inString; res += ch; continue; }
    if (ch === '?' && !inString) {
      i += 1;
      // LIMIT ? / OFFSET ? need integer casts in Postgres
      const before = res.slice(-12);
      if (/\b(LIMIT|OFFSET)\s*$/i.test(before)) res += `$${i}::int`;
      else res += `$${i}`;
      continue;
    }
    res += ch;
  }
  return res;
}

function prepareParams(params) {
  return (params || []).map((p) => {
    if (p === true) return 1;
    if (p === false) return 0;
    return p;
  });
}

class Conn {
  constructor(client, releaseFn) {
    this._client = client;
    this._release = releaseFn;
    this._released = false;
  }

  async execute(sql, params = []) {
    const text = translate(sql);
    try {
      const res = await this._client.query(text, prepareParams(params));
      return this._shape(res);
    } catch (e) {
      e.sqlText = sql;
      throw e;
    }
  }

  query(sql, params = []) {
    return this.execute(sql, params);
  }

  /**
   * mysql2 result convention:
   *   SELECT -> [rows, fields]
   *   INSERT/UPDATE/DELETE -> [ResultSetHeader { insertId, affectedRows }, fields]
   * The RETURNING id clause on INSERTs feeds insertId.
   */
  _shape(res) {
    const rows = res.rows || [];
    if (res.command === 'INSERT' || res.command === 'UPDATE' || res.command === 'DELETE') {
      const header = {
        affectedRows: res.rowCount || 0,
        insertId: res.command === 'INSERT' && rows[0] && rows[0].id !== undefined ? Number(rows[0].id) : null,
        changedRows: res.rowCount || 0,
        warningStatus: 0,
      };
      const shaped = [header, rows];
      shaped.rows = rows;
      shaped.affectedRows = header.affectedRows;
      shaped.insertId = header.insertId;
      return shaped;
    }
    const shaped = [rows, res.fields || []];
    shaped.rows = rows;
    shaped.affectedRows = 0;
    shaped.insertId = null;
    return shaped;
  }

  async beginTransaction() { await this._client.query('BEGIN'); }
  async commit() {
    await this._client.query('COMMIT');
    this._releaseOnce();
  }
  async rollback() {
    try { await this._client.query('ROLLBACK'); } catch (_e) { /* connection may already be broken */ }
    this._releaseOnce();
  }
  release() { /* no-op: mysql2 code calls release() after commit/rollback too */ }
  _releaseOnce() {
    if (!this._released) { this._released = true; this._release(); }
  }
}

class PoolAdapter {
  constructor(pool) {
    this._pool = pool;
  }

  async execute(sql, params = []) {
    const client = await this._pool.connect();
    try {
      const conn = new Conn(client, () => client.release());
      const out = await conn.execute(sql, params);
      conn._releaseOnce();
      return out;
    } catch (e) {
      client.release();
      throw e;
    }
  }

  query(sql, params = []) {
    return this.execute(sql, params);
  }

  /** Transaction-scoped connection, like mysql2's getConnection. */
  async getConnection() {
    const client = await this._pool.connect();
    return new Conn(client, () => client.release());
  }

  async end() {
    await this._pool.end();
  }
}

function buildConnectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const { DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, DB_PORT } = process.env;
  if (DB_USER && DB_NAME) {
    return `postgresql://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD || '')}@${DB_HOST || 'localhost'}:${DB_PORT || 5432}/${DB_NAME}`;
  }
  return null;
}

const connectionString = buildConnectionString();
if (!connectionString) {
  console.error('Set DATABASE_URL (Supabase connection string) or DB_HOST/DB_USER/DB_PASSWORD/DB_NAME in .env');
}

const needsSsl =
  /supabase|neon|render|amazonaws|azure|heroku/i.test(connectionString || '') ||
  String(process.env.PGSSL || '').toLowerCase() === 'require';

const pool = new pg.Pool({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: 10,
});

pool.on('error', (err) => console.error('[db pool error]', err.message));

// Keep a small fingerprint file for debugging which database is in use
try {
  fs.mkdirSync(path.join(__dirname, '..', '.current'), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, '..', '.current', 'db-info.txt'),
    `engine=postgres\nssl=${!!needsSsl}\n` +
    `database=${(/\/([^/?]+)(\?|$)/.exec(connectionString || '') || [])[1] || 'unknown'}\n` +
    `fingerprint=${connectionString ? crypto.createHash('sha256').update(connectionString).digest('hex').slice(0, 8) : 'none'}\n`
  );
} catch (_e) { /* non-fatal */ }

const adapter = new PoolAdapter(pool);
adapter._translate = translate; // exposed for tests/debugging
module.exports = adapter;
