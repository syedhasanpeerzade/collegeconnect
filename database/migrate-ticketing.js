'use strict';
/**
 * Idempotent migration runner for Two-Sided Event Ticketing System:
 * - Creates event_tickets, event_coordinators, and ticket_checkin_logs
 * - Backfills tickets for existing event_registrations
 *
 * Usage: node database/migrate-ticketing.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');

function generateTicketCode(eventId, regId) {
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `CC-TKT-${eventId}-${regId}-${rand}`;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const ssl = /supabase|neon|render|amazonaws|azure|heroku/i.test(connectionString)
    ? { rejectUnauthorized: false } : false;

  const client = new Client({ connectionString, ssl });
  await client.connect();
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'migrate-ticketing.sql'), 'utf8');
    await client.query(sql);

    // Backfill tickets for existing registrations that don't have one yet
    const { rows: unbackfilled } = await client.query(`
      SELECT r.id AS reg_id, r.event_id, r.student_id, r.status, r.registered_at
      FROM event_registrations r
      LEFT JOIN event_tickets t ON t.registration_id = r.id
      WHERE t.id IS NULL
    `);

    for (const r of unbackfilled) {
      const code = generateTicketCode(r.event_id, r.reg_id);
      const ticketStatus = r.status === 'CANCELLED' ? 'CANCELLED' : 'VALID';
      await client.query(`
        INSERT INTO event_tickets (ticket_code, registration_id, event_id, student_id, status, qr_code_data, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (registration_id) DO NOTHING
      `, [code, r.reg_id, r.event_id, r.student_id, ticketStatus, code, r.registered_at || new Date()]);
    }

    console.log(`Migration OK: event ticketing system (tickets, coordinators, checkin logs; backfilled ${unbackfilled.length} tickets)`);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Ticketing migration failed:', e.message);
    process.exit(1);
  });
} else {
  module.exports = main();
}
