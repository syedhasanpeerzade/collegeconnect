'use strict';
const db = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { asyncHandler, ok, nextPublicId } = require('../utils/helpers');
const { notify } = require('../utils/notify');
const { notifyInterestedStudents } = require('../services/interestService');

function parseEventPayload(body) {
  return {
    title: String(body.title || '').trim(),
    description: String(body.description || '').trim(),
    rules: body.rules || null,
    eligibility: body.eligibility || null,
    contact_details: body.contact_details || null,
    category: body.category,
    event_type: body.event_type || 'COLLEGE_WIDE',
    department_id: body.department_id || null,
    club_id: body.club_id || null,
    venue: String(body.venue || '').trim(),
    event_date: body.event_date,
    start_time: body.start_time,
    end_time: body.end_time,
    max_participants: parseInt(body.max_participants, 10) || 100,
    registration_deadline: body.registration_deadline || null,
    faculty_coordinator_id: body.faculty_coordinator_id || null,
    poster_path: body.poster_path || null,
    // Draft vs published: admins may save an event unpublished. Only published
    // events appear in public listings (the existing is_published flag is the
    // single source of truth — no separate draft table, no duplication).
    is_published: (body.is_published === 0 || body.is_published === '0' || body.is_published === false) ? 0 : 1,
  };
}

function validateEventDates(p) {
  // TIMESTAMPTZ columns come back from pg as JS Date objects, so normalize
  // dates to plain 'YYYY-MM-DD' before validating (keeps this check working
  // for both freshly posted strings and rows read back from the database).
  const toDay = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v == null ? '' : v).slice(0, 10));
  const toTime = (v) => (v instanceof Date ? null : String(v == null ? '' : v).slice(0, 8));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDay(p.event_date))) throw new ApiError(400, 'Event date must be a valid date (YYYY-MM-DD)');
  if (!toTime(p.start_time)) throw new ApiError(400, 'Start time is required (HH:MM)');
  if (!toTime(p.end_time)) throw new ApiError(400, 'End time is required (HH:MM) — the schedule needs a closing hour');
  if (toTime(p.end_time) <= toTime(p.start_time)) throw new ApiError(400, 'End time must be after the start time');
  if (p.registration_deadline && !/^\d{4}-\d{2}-\d{2}$/.test(toDay(p.registration_deadline))) throw new ApiError(400, 'Registration deadline must be a valid date (YYYY-MM-DD)');
  if (p.registration_deadline && toDay(p.registration_deadline) > toDay(p.event_date)) throw new ApiError(400, 'Registration deadline cannot be after the event date');
}

const create = asyncHandler(async (req, res) => {
  const p = parseEventPayload(req.body);
  if (!p.title || !p.description || !p.venue || !p.event_date) {
    throw new ApiError(400, 'Title, description, venue and date are required');
  }
  validateEventDates(p);
  if (req.files && req.files.poster) p.poster_path = `/uploads/posters/${req.files.poster[0].filename}`;

  const publicId = await nextPublicId(db, 'events', 'public_id', 'CC-EVT');
  const [r] = await db.execute(
    `INSERT INTO events (public_id, title, description, rules, eligibility, contact_details, category, event_type,
      department_id, club_id, venue, event_date, start_time, end_time, max_participants, registration_deadline,
      organizer_id, faculty_coordinator_id, status, is_published)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SCHEDULED', ?)`,
    [publicId, p.title, p.description, p.rules, p.eligibility, p.contact_details, p.category, p.event_type,
     p.department_id, p.club_id, p.venue, p.event_date, p.start_time, p.end_time, p.max_participants,
     p.registration_deadline, req.user.id, p.faculty_coordinator_id, p.is_published]
  );
  ok(res, p.is_published ? 'Event created and published' : 'Event saved as draft', { id: r.insertId, public_id: publicId }, 201);

  // Priority notifications for students whose interests match this category
  // (committed transaction; best-effort fan-out with dedupe). Drafts notify
  // nobody — the fan-out runs again on publish.
  if (p.is_published) notifyInterestedStudents({ id: r.insertId, category: p.category });
});

const update = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const [rows] = await db.execute('SELECT * FROM events WHERE id = ?', [id]);
  const ev = rows[0];
  if (!ev) throw new ApiError(404, 'Event not found');
  if (req.user.role === 'ORGANIZER' && ev.organizer_id !== req.user.id) {
    throw new ApiError(403, 'You can only edit your own events');
  }  const p = parseEventPayload(req.body);
  validateEventDates(p);
  if (req.files && req.files.poster) p.poster_path = `/uploads/posters/${req.files.poster[0].filename}`;

  await db.execute(
    `UPDATE events SET title = ?, description = ?, rules = ?, eligibility = ?, contact_details = ?,
      category = ?, event_type = ?, department_id = ?, club_id = ?, venue = ?, event_date = ?,
      start_time = ?, end_time = ?, max_participants = ?, registration_deadline = ?,
      faculty_coordinator_id = ?, poster_path = COALESCE(?, poster_path), is_published = ?
     WHERE id = ?`,
    [p.title, p.description, p.rules, p.eligibility, p.contact_details, p.category, p.event_type,
     p.department_id, p.club_id, p.venue, p.event_date, p.start_time, p.end_time, p.max_participants,
     p.registration_deadline, p.faculty_coordinator_id, p.poster_path, p.is_published, id]
  );

  // Notify registered students about the update — but only when the event is
  // published (draft edits are invisible, so they must not ping anyone).
  if (p.is_published) {
    const [regs] = await db.execute(
      `SELECT student_id FROM event_registrations WHERE event_id = ? AND status = 'REGISTERED'`, [id]
    );
    for (const r of regs) {
      await notify(db, {
        recipientId: r.student_id, type: 'EVENT_UPDATE',
        title: 'Event updated', message: `"${p.title}" details were updated. Please review the latest schedule.`,
        relatedType: 'EVENT', relatedId: id, link: `/event-details.html?id=${id}`,
      });
    }
  }
  ok(res, p.is_published ? 'Event updated' : 'Event updated (saved as draft)');
});

// Cancel or publish toggle. is_published controls visibility (draft vs live);
// status tracks the event lifecycle. Draft <-> publish toggles do not change
// the lifecycle status, so a draft can be finished and later published as-is.
const setStatus = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const status = req.body.status;
  const [rows] = await db.execute('SELECT title FROM events WHERE id = ?', [id]);
  if (!rows.length) throw new ApiError(404, 'Event not found');

  if (status === 'PUBLISHED' || status === 'DRAFT') {
    const pub = status === 'PUBLISHED' ? 1 : 0;
    if (pub) {
      // Publishing a draft must pass the same validation as creation.
      const [evRows] = await db.execute('SELECT title, venue, event_date, start_time, end_time, registration_deadline FROM events WHERE id = ?', [id]);
      validateEventDates(evRows[0]);
    }
    await db.execute('UPDATE events SET is_published = ? WHERE id = ?', [pub, id]);
    // First-time publish fans out interest notifications exactly once.
    if (pub) notifyInterestedStudents({ id, category: (await db.execute('SELECT category FROM events WHERE id = ?', [id]))[0][0].category });
    return ok(res, status === 'PUBLISHED' ? 'Event published' : 'Event saved as draft');
  }

  if (!['SCHEDULED', 'ONGOING', 'COMPLETED', 'CANCELLED'].includes(status)) {
    throw new ApiError(400, 'Invalid status');
  }

  await db.execute('UPDATE events SET status = ? WHERE id = ?', [status, id]);
  if (status === 'CANCELLED') {
    const [regs] = await db.execute(
      `SELECT student_id FROM event_registrations WHERE event_id = ? AND status = 'REGISTERED'`, [id]
    );
    for (const r of regs) {
      await notify(db, {
        recipientId: r.student_id, type: 'EVENT_CANCELLED',
        title: 'Event cancelled', message: `"${rows[0].title}" has been cancelled. Your registration is void.`,
        relatedType: 'EVENT', relatedId: id, link: `/event-details.html?id=${id}`,
      });
    }
  }
  ok(res, `Event marked as ${status.toLowerCase()}`);
});

const remove = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const [rows] = await db.execute('SELECT title FROM events WHERE id = ?', [id]);
  if (!rows.length) throw new ApiError(404, 'Event not found');
  await db.execute('DELETE FROM events WHERE id = ?', [id]);
  ok(res, `Event "${rows[0].title}" deleted`);
});

/**
 * Status counts for the admin event dashboard (draft, published by lifecycle,
 * cancelled, completed, upcoming). One source of truth: the events table.
 */
const stats = asyncHandler(async (_req, res) => {
  const [rows] = await db.execute(
    `SELECT
       COUNT(*)::int AS total,
       COALESCE(SUM(CASE WHEN is_published = 0 THEN 1 ELSE 0 END), 0)::int AS drafts,
       COALESCE(SUM(CASE WHEN is_published = 1 AND status = 'SCHEDULED' THEN 1 ELSE 0 END), 0)::int AS scheduled,
       COALESCE(SUM(CASE WHEN is_published = 1 AND status = 'ONGOING' THEN 1 ELSE 0 END), 0)::int AS ongoing,
       COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END), 0)::int AS completed,
       COALESCE(SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END), 0)::int AS cancelled,
       COALESCE(SUM(CASE WHEN is_published = 1 AND status IN ('SCHEDULED','ONGOING')
         AND event_date >= CURRENT_DATE THEN 1 ELSE 0 END), 0)::int AS upcoming
     FROM events`
  );
  ok(res, 'Event statistics', rows[0]);
});

module.exports = { create, update, setStatus, remove, stats };
