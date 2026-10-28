'use strict';
const crypto = require('crypto');
const QRCode = require('qrcode');
const db = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { notify } = require('../utils/notify');

const COORDINATOR_ROLES = new Set(['ADMIN', 'FACULTY', 'ORGANIZER', 'CLUB_COORDINATOR']);

function ticketIdFromLookup(value) {
  const lookup = String(value);
  const id = Number(lookup);
  return /^\d+$/.test(lookup) && Number.isSafeInteger(id) && id <= 2147483647 ? id : -1;
}

function ticketDisplayStatus(ticketStatus, registrationStatus, eventDate, endTime) {
  const registration = String(registrationStatus || '').toUpperCase();
  const ticket = String(ticketStatus || '').toUpperCase();
  if (['PENDING', 'PENDING_APPROVAL', 'UNDER_REVIEW'].includes(registration) ||
      ['PENDING', 'PENDING_APPROVAL', 'UNDER_REVIEW'].includes(ticket)) return 'PENDING_APPROVAL';
  if (registration === 'REJECTED' || ticket === 'REJECTED') return 'REJECTED';
  if (registration === 'CANCELLED') return 'CANCELLED';

  if (ticket === 'VALID' && eventDate) {
    const eventEnd = new Date(`${eventDate}T${endTime || '23:59:59'}`);
    if (eventEnd < new Date()) return 'EXPIRED';
  }
  return ticket;
}

function generateTicketCode(eventId, regId) {
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `CC-TKT-${eventId}-${regId}-${rand}`;
}

async function generateQrDataUrl(ticketCode) {
  return QRCode.toDataURL(ticketCode, {
    width: 480,
    margin: 2,
    color: { dark: '#0645A5', light: '#FFFFFF' },
    errorCorrectionLevel: 'H',
  });
}

/**
 * Creates or reactivates a ticket when a student registers or re-registers.
 * Accepts transaction connection `conn`.
 */
async function createOrReactivateTicket(conn, registrationId, eventId, studentId) {
  const [existing] = await conn.execute(
    `SELECT id, ticket_code, status FROM event_tickets WHERE registration_id = ?`,
    [registrationId]
  );

  if (existing.length) {
    const t = existing[0];
    await conn.execute(
      `UPDATE event_tickets
       SET status = 'VALID', cancelled_at = NULL, cancelled_reason = NULL,
           checked_in_at = NULL, checked_in_by = NULL, updated_at = NOW()
       WHERE id = ?`,
      [t.id]
    );
    const qrDataUrl = await generateQrDataUrl(t.ticket_code);
    return { id: t.id, ticket_code: t.ticket_code, status: 'VALID', qr_data_url: qrDataUrl };
  }

  const code = generateTicketCode(eventId, registrationId);
  const [ins] = await conn.execute(
    `INSERT INTO event_tickets (ticket_code, registration_id, event_id, student_id, status, qr_code_data)
     VALUES (?, ?, ?, ?, 'VALID', ?)`,
    [code, registrationId, eventId, studentId, code]
  );
  const qrDataUrl = await generateQrDataUrl(code);
  return { id: ins.insertId, ticket_code: code, status: 'VALID', qr_data_url: qrDataUrl };
}

/**
 * Marks ticket as cancelled when registration is cancelled.
 */
async function cancelTicketByRegistration(conn, registrationId, reason = 'Student cancelled registration') {
  await conn.execute(
    `UPDATE event_tickets
     SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_reason = ?, updated_at = NOW()
     WHERE registration_id = ?`,
    [reason, registrationId]
  );
}

/**
 * Check if a user is authorized to coordinate an event.
 */
async function isUserEventCoordinator(eventId, user) {
  if (!user || !COORDINATOR_ROLES.has(user.role)) return false;

  const [evRows] = await db.execute(
    `SELECT id, organizer_id, club_id FROM events WHERE id = ?`,
    [eventId]
  );
  if (!evRows.length) return false;
  if (user.role === 'ADMIN') return true;
  const ev = evRows[0];

  if (ev.organizer_id === user.id) return true;

  // Assigned explicitly in event_coordinators
  const [coordRows] = await db.execute(
    `SELECT 1 FROM event_coordinators WHERE event_id = ? AND user_id = ?`,
    [eventId, user.id]
  );
  if (coordRows.length) return true;

  // If club event, club coordinator is authorized
  if (ev.club_id) {
    const [clubCoord] = await db.execute(
      `SELECT 1 FROM club_coordinators WHERE club_id = ? AND user_id = ?`,
      [ev.club_id, user.id]
    );
    if (clubCoord.length) return true;
  }

  return false;
}

/**
 * Get all tickets belonging to a student.
 */
async function getMyTickets(userId) {
  const [rows] = await db.execute(
    `SELECT t.id, t.ticket_code, t.status, t.checked_in_at, t.cancelled_at, t.created_at,
            r.public_id AS registration_number, r.registered_at, r.status AS registration_status,
            e.id AS event_id, e.title AS event_title, e.event_date, e.start_time, e.end_time,
            e.venue, e.category, e.poster_path,
            u.full_name AS student_name, u.student_id AS student_reg_no, u.email AS student_email,
            d.name AS department_name
     FROM event_tickets t
     JOIN event_registrations r ON r.id = t.registration_id
     JOIN events e ON e.id = t.event_id
     JOIN users u ON u.id = t.student_id
     LEFT JOIN departments d ON d.id = u.department_id
     WHERE t.student_id = ?
     ORDER BY e.event_date DESC, t.id DESC`,
    [userId]
  );

  const withQr = await Promise.all(rows.map(async (row) => {
    const qrDataUrl = await generateQrDataUrl(row.ticket_code);
    return {
      ...row,
      status: ticketDisplayStatus(row.status, row.registration_status, row.event_date, row.end_time),
      raw_status: row.status,
      qr_data_url: qrDataUrl,
    };
  }));

  return withQr;
}

/**
 * Get single ticket details.
 */
async function getTicketById(ticketId, user) {
  const [rows] = await db.execute(
    `SELECT t.id, t.ticket_code, t.status, t.checked_in_at, t.cancelled_at, t.cancelled_reason,
            t.created_at, r.public_id AS registration_number, r.registered_at,
            r.status AS registration_status,
            e.id AS event_id, e.title AS event_title, e.event_date, e.start_time, e.end_time,
            e.venue, e.category, e.poster_path, e.organizer_id,
            u.id AS student_id_val, u.full_name AS student_name, u.student_id AS student_reg_no,
            u.email AS student_email, u.phone AS student_phone, d.name AS department_name,
            c.full_name AS checked_in_by_name
     FROM event_tickets t
     JOIN event_registrations r ON r.id = t.registration_id
     JOIN events e ON e.id = t.event_id
     JOIN users u ON u.id = t.student_id
     LEFT JOIN departments d ON d.id = u.department_id
     LEFT JOIN users c ON c.id = t.checked_in_by
     WHERE t.id = ? OR t.ticket_code = ?`,
    [ticketId, ticketId]
  );

  if (!rows.length) throw new ApiError(404, 'Ticket not found');
  const t = rows[0];

  // Access check: student owns it OR coordinator/admin
  const isOwner = user && user.id === t.student_id_val;
  const isCoord = user && (await isUserEventCoordinator(t.event_id, user));
  if (!isOwner && !isCoord) {
    throw new ApiError(403, 'You do not have permission to view this ticket');
  }

  const qrDataUrl = await generateQrDataUrl(t.ticket_code);
  return {
    ...t,
    status: ticketDisplayStatus(t.status, t.registration_status, t.event_date, t.end_time),
    qr_data_url: qrDataUrl,
  };
}

/**
 * List events assigned to the coordinator (or all events for admin).
 */
async function getCoordinatorEvents(user) {
  if (!user || !COORDINATOR_ROLES.has(user.role)) {
    throw new ApiError(403, 'Only authorized event coordinators can view assigned events');
  }

  let sql;
  let params = [];

  if (user.role === 'ADMIN') {
    sql = `
      SELECT e.id, e.title, e.event_date, e.start_time, e.end_time, e.venue, e.category,
             e.poster_path, e.max_participants, e.status AS event_status,
             (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.id AND r.status = 'REGISTERED') AS total_registered,
             (SELECT COUNT(*) FROM event_tickets t WHERE t.event_id = e.id AND t.status = 'CHECKED_IN') AS total_checked_in
      FROM events e
      WHERE e.is_published = 1 AND e.status != 'CANCELLED'
      ORDER BY e.event_date ASC, e.start_time ASC
    `;
  } else {
    sql = `
      SELECT DISTINCT e.id, e.title, e.event_date, e.start_time, e.end_time, e.venue, e.category,
             e.poster_path, e.max_participants, e.status AS event_status,
             (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.id AND r.status = 'REGISTERED') AS total_registered,
             (SELECT COUNT(*) FROM event_tickets t WHERE t.event_id = e.id AND t.status = 'CHECKED_IN') AS total_checked_in
      FROM events e
      LEFT JOIN event_coordinators ec ON ec.event_id = e.id
      LEFT JOIN club_coordinators cc ON cc.club_id = e.club_id
      WHERE e.is_published = 1 AND e.status != 'CANCELLED'
        AND (e.organizer_id = ? OR ec.user_id = ? OR cc.user_id = ?)
      ORDER BY e.event_date ASC, e.start_time ASC
    `;
    params = [user.id, user.id, user.id];
  }

  const [rows] = await db.execute(sql, params);
  return rows.map((r) => {
    const reg = Number(r.total_registered) || 0;
    const chk = Number(r.total_checked_in) || 0;
    const remaining = Math.max(0, reg - chk);
    const pct = reg > 0 ? Math.round((chk / reg) * 100) : 0;
    return {
      ...r,
      total_registered: reg,
      total_checked_in: chk,
      remaining,
      attendance_percentage: pct,
    };
  });
}

/**
 * Verification workflow (step 1):
 * Coordinator scans QR or enters code manually.
 * Backend verifies against selected event and returns status without modifying ticket.
 */
async function verifyTicket(eventId, ticketCode, coordinatorUser) {
  if (!eventId) throw new ApiError(400, 'Event ID is required');
  if (!ticketCode) throw new ApiError(400, 'Ticket code is required');

  const isCoord = await isUserEventCoordinator(eventId, coordinatorUser);
  if (!isCoord) {
    throw new ApiError(403, 'You are not authorized to verify tickets for this event');
  }

  const code = String(ticketCode).trim().toUpperCase();

  const [tRows] = await db.execute(
    `SELECT t.id, t.ticket_code, t.status, t.checked_in_at, t.cancelled_at, t.cancelled_reason,
            t.event_id, e.title AS event_title, e.event_date, e.start_time, e.end_time, e.venue,
            r.status AS registration_status,
            u.id AS student_id, u.full_name AS student_name, u.student_id AS student_reg_no,
            u.email AS student_email, d.name AS department_name,
            c.full_name AS checked_in_by_name
     FROM event_tickets t
     JOIN event_registrations r ON r.id = t.registration_id
     JOIN events e ON e.id = t.event_id
     JOIN users u ON u.id = t.student_id
     LEFT JOIN departments d ON d.id = u.department_id
     LEFT JOIN users c ON c.id = t.checked_in_by
     WHERE UPPER(t.ticket_code) = ?`,
    [code]
  );

  // 1. Invalid ticket (does not exist)
  if (!tRows.length) {
    await db.execute(
      `INSERT INTO ticket_checkin_logs (event_id, coordinator_id, scan_method, status, notes)
       VALUES (?, ?, 'SCAN_OR_INPUT', 'INVALID', ?)`,
      [eventId, coordinatorUser.id, `Ticket code: ${code}`]
    );
    return {
      result: 'INVALID',
      message: 'INVALID TICKET',
      valid: false,
      can_confirm: false,
    };
  }

  const t = tRows[0];

  // 2. Ticket for another event
  if (Number(t.event_id) !== Number(eventId)) {
    await db.execute(
      `INSERT INTO ticket_checkin_logs (ticket_id, event_id, student_id, coordinator_id, scan_method, status, notes)
       VALUES (?, ?, ?, ?, 'SCAN_OR_INPUT', 'WRONG_EVENT', ?)`,
      [t.id, eventId, t.student_id, coordinatorUser.id, `Ticket belongs to event ${t.event_title} (#${t.event_id})`]
    );
    return {
      result: 'WRONG_EVENT',
      message: 'WRONG EVENT',
      valid: false,
      can_confirm: false,
      ticket: {
        ticket_code: t.ticket_code,
        student_name: t.student_name,
        student_reg_no: t.student_reg_no,
        actual_event: { id: t.event_id, title: t.event_title },
      },
    };
  }

  // 3. Already checked in
  if (t.status === 'CHECKED_IN') {
    await db.execute(
      `INSERT INTO ticket_checkin_logs (ticket_id, event_id, student_id, coordinator_id, scan_method, status, notes)
       VALUES (?, ?, ?, ?, 'SCAN_OR_INPUT', 'ALREADY_CHECKED_IN', ?)`,
      [t.id, eventId, t.student_id, coordinatorUser.id, `Original checkin: ${t.checked_in_at}`]
    );
    return {
      result: 'ALREADY_CHECKED_IN',
      message: 'TICKET ALREADY USED — ENTRY DENIED',
      valid: false,
      can_confirm: false,
      checked_in_at: t.checked_in_at,
      ticket: {
        id: t.id,
        ticket_code: t.ticket_code,
        student_name: t.student_name,
        student_reg_no: t.student_reg_no,
        student_email: t.student_email,
        department_name: t.department_name,
        event_title: t.event_title,
        checked_in_at: t.checked_in_at,
        checked_in_by: t.checked_in_by_name || 'Coordinator',
      },
    };
  }

  if (['PENDING', 'PENDING_APPROVAL', 'UNDER_REVIEW'].includes(String(t.registration_status || '').toUpperCase()) ||
      ['PENDING', 'PENDING_APPROVAL', 'UNDER_REVIEW'].includes(String(t.status || '').toUpperCase())) {
    await db.execute(
      `INSERT INTO ticket_checkin_logs (ticket_id, event_id, student_id, coordinator_id, scan_method, status, notes)
       VALUES (?, ?, ?, ?, 'SCAN_OR_INPUT', 'PENDING_APPROVAL', 'Registration or ticket requires approval')`,
      [t.id, eventId, t.student_id, coordinatorUser.id]
    );
    return {
      result: 'PENDING_APPROVAL',
      message: 'PENDING APPROVAL — ENTRY DENIED',
      valid: false,
      can_confirm: false,
      ticket: {
        ticket_code: t.ticket_code,
        student_name: t.student_name,
        registration_status: t.registration_status,
        event_title: t.event_title,
      },
    };
  }

  // 4. Cancelled ticket
  if (['CANCELLED', 'REJECTED'].includes(String(t.status || '').toUpperCase()) ||
      ['CANCELLED', 'REJECTED'].includes(String(t.registration_status || '').toUpperCase())) {
    await db.execute(
      `INSERT INTO ticket_checkin_logs (ticket_id, event_id, student_id, coordinator_id, scan_method, status, notes)
       VALUES (?, ?, ?, ?, 'SCAN_OR_INPUT', 'CANCELLED', ?)`,
      [t.id, eventId, t.student_id, coordinatorUser.id, t.cancelled_reason || 'Cancelled']
    );
    return {
      result: 'CANCELLED',
      message: 'TICKET CANCELLED — ENTRY DENIED',
      valid: false,
      can_confirm: false,
      ticket: {
        ticket_code: t.ticket_code,
        student_name: t.student_name,
        student_reg_no: t.student_reg_no,
        cancelled_at: t.cancelled_at,
        cancelled_reason: t.cancelled_reason,
      },
    };
  }

  // 5. Expired ticket
  const now = new Date();
  if (t.status === 'EXPIRED' || (t.event_date && new Date(`${t.event_date}T${t.end_time || '23:59:59'}`) < new Date(now.getTime() - 24 * 3600 * 1000))) {
    return {
      result: 'EXPIRED',
      message: 'TICKET EXPIRED — ENTRY DENIED',
      valid: false,
      can_confirm: false,
      ticket: {
        ticket_code: t.ticket_code,
        student_name: t.student_name,
        event_date: t.event_date,
      },
    };
  }

  if (String(t.registration_status || '').toUpperCase() !== 'REGISTERED' || t.status !== 'VALID') {
    return {
      result: 'INVALID',
      message: 'INVALID TICKET — REGISTRATION OR TICKET IS NOT VALID',
      valid: false,
      can_confirm: false,
    };
  }

  // 6. Valid unused ticket
  return {
    result: 'VALID',
    message: 'VALID TICKET',
    valid: true,
    can_confirm: true,
    ticket: {
      id: t.id,
      ticket_code: t.ticket_code,
      status: 'VALID',
      event_id: t.event_id,
      event_title: t.event_title,
      event_date: t.event_date,
      venue: t.venue,
      student_id: t.student_id,
      student_name: t.student_name,
      student_reg_no: t.student_reg_no,
      student_email: t.student_email,
      department_name: t.department_name,
    },
  };
}

/**
 * Validate and check in a ticket in one transaction. The registration is
 * locked before the ticket, matching the student cancellation workflow.
 */
async function scanTicket(eventId, ticketCodeOrId, coordinatorUser, scanMethod = 'QR_SCAN') {
  if (!eventId) throw new ApiError(400, 'Event ID is required');
  if (!ticketCodeOrId) throw new ApiError(400, 'Ticket code or ID is required');

  const isCoord = await isUserEventCoordinator(eventId, coordinatorUser);
  if (!isCoord) {
    throw new ApiError(403, 'You are not authorized to check in attendees for this event');
  }

  const lookup = String(ticketCodeOrId).trim();
  const ticketId = ticketIdFromLookup(lookup);
  const method = ['QR_SCAN', 'MANUAL_CODE', 'TABLE_VERIFY'].includes(scanMethod)
    ? scanMethod : 'QR_SCAN';
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const [matches] = await conn.execute(
      `SELECT id, registration_id
       FROM event_tickets
       WHERE id = ? OR UPPER(ticket_code) = UPPER(?)
       LIMIT 1`,
      [ticketId, lookup]
    );

    const recordScan = async (status, matchedTicketId = null, studentId = null, notes = null) => {
      await conn.execute(
        `INSERT INTO ticket_checkin_logs (ticket_id, event_id, student_id, coordinator_id, scan_method, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [matchedTicketId, eventId, studentId, coordinatorUser.id, method, status, notes]
      );
    };

    if (!matches.length) {
      await recordScan('INVALID_QR_CODE', null, null, 'No matching ticket was found');
      await conn.commit();
      return {
        result: 'INVALID_QR_CODE',
        message: 'INVALID QR CODE',
        valid: false,
        can_confirm: false,
      };
    }

    // Lock in the same order as registration cancellation/re-registration.
    const [registrations] = await conn.execute(
      `SELECT id, event_id, student_id, public_id, status
       FROM event_registrations
       WHERE id = ?
       FOR UPDATE`,
      [matches[0].registration_id]
    );
    const [tickets] = await conn.execute(
      `SELECT t.id, t.ticket_code, t.status, t.event_id, t.student_id,
              t.checked_in_at, t.cancelled_at, t.cancelled_reason,
              e.title AS event_title, e.event_date, e.end_time, e.venue, e.is_published,
              e.status AS event_status,
              u.full_name AS student_name, u.student_id AS student_reg_no,
              u.email AS student_email, d.name AS department_name,
              c.full_name AS checked_in_by_name
       FROM event_tickets t
       JOIN events e ON e.id = t.event_id
       JOIN users u ON u.id = t.student_id
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN users c ON c.id = t.checked_in_by
       WHERE t.id = ?
       FOR UPDATE OF t`,
      [matches[0].id]
    );

    if (!registrations.length || !tickets.length) {
      throw new ApiError(409, 'Ticket registration changed while scanning. Please scan again.');
    }

    const registration = registrations[0];
    const ticket = tickets[0];
    const registrationStatus = String(registration.status || '').toUpperCase();
    const ticketStatus = String(ticket.status || '').toUpperCase();
    const details = {
      id: ticket.id,
      ticket_id: ticket.id,
      ticket_code: ticket.ticket_code,
      status: ticket.status,
      registration_status: registration.status,
      registration_number: registration.public_id,
      student_id: ticket.student_id,
      student_name: ticket.student_name,
      student_reg_no: ticket.student_reg_no,
      student_email: ticket.student_email,
      department_name: ticket.department_name,
      event_id: ticket.event_id,
      event_title: ticket.event_title,
      event_date: ticket.event_date,
      venue: ticket.venue,
    };

    if (Number(ticket.event_id) !== Number(eventId) ||
        Number(registration.event_id) !== Number(eventId) ||
        Number(registration.student_id) !== Number(ticket.student_id)) {
      await recordScan('INVALID_QR_CODE', null, null, 'Ticket does not match the selected event');
      await conn.commit();
      return {
        result: 'INVALID_QR_CODE',
        message: 'INVALID QR CODE — TICKET IS NOT FOR THIS EVENT',
        valid: false,
        can_confirm: false,
      };
    }

    if (ticketStatus === 'CHECKED_IN') {
      await recordScan('ALREADY_CHECKED_IN', ticket.id, ticket.student_id, 'Ticket was already used');
      await conn.commit();
      return {
        result: 'ALREADY_CHECKED_IN',
        message: 'ALREADY CHECKED IN',
        valid: false,
        can_confirm: false,
        checked_in_at: ticket.checked_in_at,
        checked_in_by: ticket.checked_in_by_name || 'Coordinator',
        ticket: details,
      };
    }

    if (!ticket.is_published || ['CANCELLED', 'COMPLETED'].includes(ticket.event_status)) {
      await recordScan('INVALID_QR_CODE', ticket.id, ticket.student_id, 'Event is not available for entry');
      await conn.commit();
      return {
        result: 'INVALID_QR_CODE',
        message: 'INVALID QR CODE — EVENT IS NOT AVAILABLE',
        valid: false,
        can_confirm: false,
        ticket: details,
      };
    }

    if (['PENDING', 'PENDING_APPROVAL', 'UNDER_REVIEW'].includes(registrationStatus) ||
        ['PENDING', 'PENDING_APPROVAL', 'UNDER_REVIEW'].includes(ticketStatus)) {
      await recordScan('PENDING_APPROVAL', ticket.id, ticket.student_id, 'Registration or ticket requires approval');
      await conn.commit();
      return {
        result: 'PENDING_APPROVAL',
        message: 'PENDING APPROVAL — ENTRY DENIED',
        valid: false,
        can_confirm: false,
        ticket: details,
      };
    }

    if (['CANCELLED', 'REJECTED'].includes(registrationStatus) ||
        ['CANCELLED', 'REJECTED'].includes(ticketStatus)) {
      await recordScan('REJECTED_CANCELLED', ticket.id, ticket.student_id, 'Registration or ticket is rejected/cancelled');
      await conn.commit();
      return {
        result: 'REJECTED_CANCELLED',
        message: 'REJECTED/CANCELLED — ENTRY DENIED',
        valid: false,
        can_confirm: false,
        ticket: details,
      };
    }

    const eventEnd = ticket.event_date
      ? new Date(`${ticket.event_date}T${ticket.end_time || '23:59:59'}`)
      : null;
    if (ticketStatus === 'EXPIRED' || (eventEnd && eventEnd < new Date())) {
      await recordScan('INVALID_QR_CODE', ticket.id, ticket.student_id, 'Ticket has expired');
      await conn.commit();
      return {
        result: 'INVALID_QR_CODE',
        message: 'INVALID QR CODE — TICKET EXPIRED',
        valid: false,
        can_confirm: false,
        ticket: details,
      };
    }

    if (registrationStatus !== 'REGISTERED' || ticketStatus !== 'VALID') {
      await recordScan('INVALID_QR_CODE', ticket.id, ticket.student_id, `Unsupported ticket or registration status`);
      await conn.commit();
      return {
        result: 'INVALID_QR_CODE',
        message: 'INVALID QR CODE — TICKET IS NOT VALID',
        valid: false,
        can_confirm: false,
        ticket: details,
      };
    }

    const [updated, checkedInRows] = await conn.execute(
      `UPDATE event_tickets
       SET status = 'CHECKED_IN', checked_in_at = CURRENT_TIMESTAMP,
           checked_in_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND event_id = ? AND status = 'VALID'
       RETURNING checked_in_at`,
      [coordinatorUser.id, ticket.id, eventId]
    );

    if (updated.affectedRows !== 1) {
      throw new ApiError(409, 'Ticket check-in conflict. Please scan the ticket again.');
    }

    await recordScan('APPROVED_ENTRY_ALLOWED', ticket.id, ticket.student_id);
    await notify(conn, {
      recipientId: ticket.student_id,
      type: 'TICKET_CHECKED_IN',
      title: 'Ticket Checked In',
      message: `Your entry for "${ticket.event_title}" has been confirmed! Enjoy the event.`,
      relatedType: 'EVENT',
      relatedId: eventId,
      link: '/my-tickets.html',
    });
    await conn.commit();

    return {
      result: 'APPROVED_ENTRY_ALLOWED',
      message: 'APPROVED — ENTRY ALLOWED',
      valid: true,
      can_confirm: false,
      checked_in_at: checkedInRows[0].checked_in_at,
      checked_in_by: coordinatorUser.name || coordinatorUser.full_name || 'Coordinator',
      ticket: { ...details, status: 'CHECKED_IN' },
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Verification workflow (step 2):
 * Coordinator clicks "Confirm Entry".
 * Atomic check-in and database record.
 */
async function confirmEntry(eventId, ticketCodeOrId, coordinatorUser, scanMethod = 'QR_SCAN') {
  if (!eventId) throw new ApiError(400, 'Event ID is required');
  if (!ticketCodeOrId) throw new ApiError(400, 'Ticket code or ID is required');

  const isCoord = await isUserEventCoordinator(eventId, coordinatorUser);
  if (!isCoord) {
    throw new ApiError(403, 'You are not authorized to check in attendees for this event');
  }

  const lookup = String(ticketCodeOrId).trim();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const lookupId = ticketIdFromLookup(lookup);
    const [matches] = await conn.execute(
      `SELECT id, registration_id
       FROM event_tickets
       WHERE id = ? OR UPPER(ticket_code) = UPPER(?)
       LIMIT 1`,
      [lookupId, lookup]
    );
    if (!matches.length) throw new ApiError(404, 'Ticket not found');

    const [registrations] = await conn.execute(
      `SELECT id, event_id, student_id, status
       FROM event_registrations
       WHERE id = ?
       FOR UPDATE`,
      [matches[0].registration_id]
    );
    const [tRows] = await conn.execute(
      `SELECT t.id, t.ticket_code, t.status, t.event_id, t.student_id, t.checked_in_at,
              e.title AS event_title, e.event_date, e.end_time, e.is_published,
              e.status AS event_status,
              u.full_name AS student_name, u.student_id AS student_reg_no
       FROM event_tickets t
       JOIN events e ON e.id = t.event_id
       JOIN users u ON u.id = t.student_id
       WHERE t.id = ?
       FOR UPDATE OF t`,
      [matches[0].id]
    );

    if (!tRows.length || !registrations.length) {
      throw new ApiError(404, 'Ticket not found');
    }

    const t = tRows[0];
    const registration = registrations[0];

    if (Number(t.event_id) !== Number(eventId)) {
      throw new ApiError(400, `Ticket is for another event: "${t.event_title}"`);
    }

    if (Number(registration.event_id) !== Number(eventId) ||
        Number(registration.student_id) !== Number(t.student_id) ||
        String(registration.status || '').toUpperCase() !== 'REGISTERED') {
      throw new ApiError(400, 'Ticket registration is not approved for entry');
    }

    if (!t.is_published || ['CANCELLED', 'COMPLETED'].includes(t.event_status)) {
      throw new ApiError(400, 'Event is not available for entry');
    }

    if (t.status === 'CHECKED_IN') {
      throw new ApiError(409, `Ticket already used at ${new Date(t.checked_in_at).toLocaleTimeString()}`);
    }

    if (t.status === 'CANCELLED') {
      throw new ApiError(400, 'Ticket has been cancelled');
    }

    const eventEnd = t.event_date ? new Date(`${t.event_date}T${t.end_time || '23:59:59'}`) : null;
    if (t.status === 'EXPIRED' || (eventEnd && eventEnd < new Date())) {
      throw new ApiError(400, 'Ticket has expired');
    }

    // Atomic update
    const [upd] = await conn.execute(
      `UPDATE event_tickets
       SET status = 'CHECKED_IN', checked_in_at = CURRENT_TIMESTAMP, checked_in_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND event_id = ? AND status = 'VALID'`,
      [coordinatorUser.id, t.id, eventId]
    );

    if (upd.affectedRows === 0) {
      throw new ApiError(409, 'Ticket check-in conflict: ticket was already checked in');
    }

    // Audit log
    await conn.execute(
      `INSERT INTO ticket_checkin_logs (ticket_id, event_id, student_id, coordinator_id, scan_method, status)
       VALUES (?, ?, ?, ?, ?, 'SUCCESS')`,
      [t.id, eventId, t.student_id, coordinatorUser.id, scanMethod]
    );

    // Notify student
    await notify(conn, {
      recipientId: t.student_id,
      type: 'TICKET_CHECKED_IN',
      title: 'Ticket Checked In',
      message: `Your entry for "${t.event_title}" has been confirmed! Enjoy the event.`,
      relatedType: 'EVENT',
      relatedId: eventId,
      link: '/my-tickets.html',
    });

    await conn.commit();

    return {
      success: true,
      message: 'Entry confirmed successfully',
      ticket_id: t.id,
      ticket_code: t.ticket_code,
      student_name: t.student_name,
      student_reg_no: t.student_reg_no,
      event_title: t.event_title,
      checked_in_at: new Date().toISOString(),
      checked_in_by: coordinatorUser.name || coordinatorUser.full_name,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Get attendees list and attendance statistics for an event.
 */
async function getEventAttendees(eventId, user, { search = '', status = '' } = {}) {
  const isCoord = await isUserEventCoordinator(eventId, user);
  if (!isCoord) {
    throw new ApiError(403, 'You are not authorized to view attendees for this event');
  }

  // Get event details
  const [evRows] = await db.execute(
    `SELECT id, title, event_date, start_time, end_time, venue, max_participants, is_published, status
     FROM events WHERE id = ?`,
    [eventId]
  );
  if (!evRows.length) throw new ApiError(404, 'Event not found');
  const event = evRows[0];

  // Base query for attendees
  let sql = `
    SELECT t.id AS ticket_id, t.ticket_code,
           CASE
             WHEN r.status IN ('PENDING', 'PENDING_APPROVAL', 'UNDER_REVIEW') THEN 'PENDING_APPROVAL'
             WHEN r.status = 'REJECTED' OR t.status = 'REJECTED' THEN 'REJECTED_CANCELLED'
             ELSE t.status
           END AS ticket_status,
           r.status AS registration_status, t.checked_in_at,
           r.id AS registration_id, r.public_id AS registration_number, r.registered_at,
           u.id AS student_id, u.full_name AS student_name, u.student_id AS student_reg_no,
           u.email AS student_email, u.phone AS student_phone,
           d.name AS department_name, d.code AS department_code,
           c.full_name AS checked_in_by_name
    FROM event_registrations r
    JOIN users u ON u.id = r.student_id
    LEFT JOIN event_tickets t ON t.registration_id = r.id
    LEFT JOIN departments d ON d.id = u.department_id
    LEFT JOIN users c ON c.id = t.checked_in_by
    WHERE r.event_id = ?
  `;
  const params = [eventId];

  if (status) {
    if (status === 'CHECKED_IN') {
      sql += ` AND t.status = 'CHECKED_IN' AND r.status = 'REGISTERED'`;
    } else if (status === 'VALID') {
      sql += ` AND t.status = 'VALID' AND r.status = 'REGISTERED'`;
    } else if (status === 'CANCELLED') {
      sql += ` AND (t.status = 'CANCELLED' OR r.status = 'CANCELLED')`;
    } else if (status === 'PENDING_APPROVAL') {
      sql += ` AND (t.status IN ('PENDING', 'PENDING_APPROVAL', 'UNDER_REVIEW') OR r.status IN ('PENDING', 'PENDING_APPROVAL', 'UNDER_REVIEW'))`;
    } else if (status === 'REJECTED_CANCELLED') {
      sql += ` AND (r.status IN ('REJECTED', 'CANCELLED') OR t.status IN ('REJECTED', 'CANCELLED'))`;
    }
  }

  if (search) {
    sql += ` AND (u.full_name ILIKE ? OR u.student_id ILIKE ? OR u.email ILIKE ? OR t.ticket_code ILIKE ? OR r.public_id ILIKE ?)`;
    const s = `%${search}%`;
    params.push(s, s, s, s, s);
  }

  sql += ` ORDER BY t.checked_in_at DESC NULLS LAST, r.registered_at ASC`;

  const [attendees] = await db.execute(sql, params);

  // Overall statistics for event
  const [statRows] = await db.execute(
    `SELECT
       (SELECT COUNT(*) FROM event_registrations WHERE event_id = ? AND status = 'REGISTERED') AS total_registered,
       (SELECT COUNT(*) FROM event_tickets WHERE event_id = ? AND status = 'CHECKED_IN') AS checked_in,
       (SELECT COUNT(*)
        FROM event_registrations r
        LEFT JOIN event_tickets t ON t.registration_id = r.id
        WHERE r.event_id = ?
          AND (r.status IN ('CANCELLED', 'REJECTED') OR t.status IN ('CANCELLED', 'REJECTED'))) AS cancelled
    `,
    [eventId, eventId, eventId]
  );

  const totalRegistered = Number(statRows[0].total_registered) || 0;
  const checkedIn = Number(statRows[0].checked_in) || 0;
  const remaining = Math.max(0, totalRegistered - checkedIn);
  const percentage = totalRegistered > 0 ? Math.round((checkedIn / totalRegistered) * 100) : 0;

  // Recent check-in history logs
  const [recentLogs] = await db.execute(
    `SELECT l.id, l.scanned_at, l.scan_method, l.status, l.notes,
            u.full_name AS student_name, u.student_id AS student_reg_no,
            c.full_name AS coordinator_name, t.ticket_code, e.title AS event_title
     FROM ticket_checkin_logs l
     JOIN users c ON c.id = l.coordinator_id
     JOIN events e ON e.id = l.event_id
     LEFT JOIN event_tickets t ON t.id = l.ticket_id
     LEFT JOIN users u ON u.id = l.student_id
     WHERE l.event_id = ?
     ORDER BY l.scanned_at DESC
     LIMIT 25`,
    [eventId]
  );

  return {
    event,
    stats: {
      total_registered: totalRegistered,
      checked_in: checkedIn,
      remaining,
      attendance_percentage: percentage,
      cancelled: Number(statRows[0].cancelled) || 0,
    },
    attendees,
    recent_logs: recentLogs,
  };
}

/**
 * Generate CSV export of event attendees.
 */
async function exportEventAttendeesCSV(eventId, user) {
  const data = await getEventAttendees(eventId, user, {});
  const escapeCsv = (val) => {
    if (val === null || val === undefined) return '""';
    const s = String(val).replace(/"/g, '""');
    return `"${s}"`;
  };

  const headers = [
    'Ticket Code',
    'Registration ID',
    'Student Name',
    'Registration Number',
    'Email',
    'Department',
    'Registration Date',
    'Ticket Status',
    'Checked In At',
    'Checked In By',
  ];

  const rows = data.attendees.map((a) => [
    escapeCsv(a.ticket_code || '-'),
    escapeCsv(a.registration_number),
    escapeCsv(a.student_name),
    escapeCsv(a.student_reg_no || '-'),
    escapeCsv(a.student_email),
    escapeCsv(a.department_name || '-'),
    escapeCsv(a.registered_at ? new Date(a.registered_at).toLocaleString() : '-'),
    escapeCsv(a.ticket_status || 'REGISTERED'),
    escapeCsv(a.checked_in_at ? new Date(a.checked_in_at).toLocaleString() : '-'),
    escapeCsv(a.checked_in_by_name || '-'),
  ].join(','));

  return [headers.join(','), ...rows].join('\r\n');
}

/**
 * Assign a coordinator to an event.
 */
async function assignCoordinator(eventId, targetUserId, user) {
  if (user.role !== 'ADMIN') {
    const [ev] = await db.execute(`SELECT organizer_id FROM events WHERE id = ?`, [eventId]);
    if (!ev.length || ev[0].organizer_id !== user.id) {
      throw new ApiError(403, 'Only admins or the event organizer can assign coordinators');
    }
  }

  // Ensure target user exists
  const [targetUser] = await db.execute(
    `SELECT id, full_name, email, role FROM users WHERE id = ?`,
    [targetUserId]
  );
  if (!targetUser.length) throw new ApiError(404, 'User not found');
  if (!COORDINATOR_ROLES.has(targetUser[0].role)) {
    throw new ApiError(400, 'Only faculty, organizers, and coordinators can be assigned to event entry');
  }

  await db.execute(
    `INSERT INTO event_coordinators (event_id, user_id, assigned_by)
     VALUES (?, ?, ?)
     ON CONFLICT (event_id, user_id) DO NOTHING`,
    [eventId, targetUserId, user.id]
  );

  return { success: true, message: `Assigned ${targetUser[0].full_name} as coordinator` };
}

/**
 * Remove a coordinator from an event.
 */
async function removeCoordinator(eventId, targetUserId, user) {
  if (user.role !== 'ADMIN') {
    const [ev] = await db.execute(`SELECT organizer_id FROM events WHERE id = ?`, [eventId]);
    if (!ev.length || ev[0].organizer_id !== user.id) {
      throw new ApiError(403, 'Only admins or the event organizer can remove coordinators');
    }
  }

  await db.execute(
    `DELETE FROM event_coordinators WHERE event_id = ? AND user_id = ?`,
    [eventId, targetUserId]
  );
  return { success: true, message: 'Coordinator removed' };
}

/**
 * List coordinators assigned to an event.
 */
async function getEventCoordinators(eventId, user) {
  const isCoord = await isUserEventCoordinator(eventId, user);
  if (!isCoord) {
    throw new ApiError(403, 'Not authorized');
  }

  const [rows] = await db.execute(
    `SELECT ec.id, ec.event_id, ec.user_id, ec.created_at,
            u.full_name, u.email, u.role, u.student_id, d.name AS department_name
     FROM event_coordinators ec
     JOIN users u ON u.id = ec.user_id
     LEFT JOIN departments d ON d.id = u.department_id
     WHERE ec.event_id = ?
     ORDER BY ec.created_at ASC`,
    [eventId]
  );
  return rows;
}

/**
 * Cancel a ticket (Admin or owner).
 */
async function cancelTicket(ticketId, user, reason = 'Cancelled by administrator') {
  const [tRows] = await db.execute(
    `SELECT t.id, t.student_id, t.event_id, t.status, e.title AS event_title
     FROM event_tickets t
     JOIN events e ON e.id = t.event_id
     WHERE t.id = ?`,
    [ticketId]
  );
  if (!tRows.length) throw new ApiError(404, 'Ticket not found');
  const t = tRows[0];

  const isOwner = user.id === t.student_id;
  const isAdmin = user.role === 'ADMIN';
  if (!isOwner && !isAdmin) {
    throw new ApiError(403, 'Permission denied');
  }

  if (t.status === 'CANCELLED') throw new ApiError(400, 'Ticket is already cancelled');

  await db.execute(
    `UPDATE event_tickets
     SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_reason = ?, updated_at = NOW()
     WHERE id = ?`,
    [reason, ticketId]
  );

  return { success: true, message: `Ticket cancelled for "${t.event_title}"` };
}

/**
 * Admin overview of tickets and attendance across all events.
 */
async function getAdminOverview() {
  const [stats] = await db.execute(`
    SELECT
      (SELECT COUNT(*) FROM event_tickets) AS total_tickets_generated,
      (SELECT COUNT(*) FROM event_tickets WHERE status = 'VALID') AS total_valid_tickets,
      (SELECT COUNT(*) FROM event_tickets WHERE status = 'CHECKED_IN') AS total_checked_in,
      (SELECT COUNT(*) FROM event_tickets WHERE status = 'CANCELLED') AS total_cancelled,
      (SELECT COUNT(DISTINCT event_id) FROM event_tickets) AS events_with_tickets
  `);

  const [topEvents] = await db.execute(`
    SELECT e.id, e.title, e.event_date, e.venue,
           COUNT(t.id) AS tickets_issued,
           COUNT(CASE WHEN t.status = 'CHECKED_IN' THEN 1 END) AS checked_in_count,
           ROUND(100.0 * COUNT(CASE WHEN t.status = 'CHECKED_IN' THEN 1 END) / NULLIF(COUNT(t.id), 0)) AS attendance_rate
    FROM events e
    JOIN event_tickets t ON t.event_id = e.id
    GROUP BY e.id, e.title, e.event_date, e.venue
    ORDER BY checked_in_count DESC, tickets_issued DESC
    LIMIT 10
  `);

  return {
    overview: stats[0],
    top_events: topEvents,
  };
}

module.exports = {
  createOrReactivateTicket,
  cancelTicketByRegistration,
  isUserEventCoordinator,
  getMyTickets,
  getTicketById,
  getCoordinatorEvents,
  verifyTicket,
  scanTicket,
  confirmEntry,
  getEventAttendees,
  exportEventAttendeesCSV,
  assignCoordinator,
  removeCoordinator,
  getEventCoordinators,
  cancelTicket,
  getAdminOverview,
};
