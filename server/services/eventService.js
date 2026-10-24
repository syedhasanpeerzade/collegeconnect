'use strict';
const db = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { nextPublicId, nextRequestId } = require('../utils/helpers');
const { notify } = require('../utils/notify');
const { notifyInterestedStudents } = require('./interestService');
const { createOrReactivateTicket, cancelTicketByRegistration } = require('./ticketService');

const EVENT_CATEGORIES = ['TECHNICAL','CULTURAL','SPORTS','WORKSHOP','SEMINAR','COMPETITION','FEST','CLUB_EVENT','CAREER','ARTS','OTHER'];
const EVENT_TYPES = ['COLLEGE_WIDE', 'DEPARTMENT', 'CLUB'];

/**
 * The 8 discovery categories shown on the Events Categories page.
 * Each UI group maps to one or more DB categories; the counts on the
 * category cards come from these groups (DB-driven, upcoming only).
 */
const EVENT_CATEGORY_GROUPS = [
  {
    key: 'SPORTS', label: 'Sports', icon: '🏆',
    description: 'Tournaments, matches and fitness sessions on the field and in the arena.',
    categories: ['SPORTS'],
  },
  {
    key: 'TECH', label: 'Coding & Tech', icon: '💻',
    description: 'Hackathons, coding competitions, tech workshops and AI/ML events.',
    categories: ['TECHNICAL', 'WORKSHOP', 'COMPETITION'],
  },
  {
    key: 'CLUB_EVENT', label: 'College Clubs', icon: '🏫',
    description: 'Club meetups, sessions and activities hosted by student organizations.',
    categories: ['CLUB_EVENT'],
  },
  {
    key: 'CULTURAL', label: 'Cultural Events', icon: '🎭',
    description: 'Fests, performances and celebrations of music, dance and drama.',
    categories: ['CULTURAL', 'FEST'],
  },
  {
    key: 'ACADEMIC', label: 'Academic Events', icon: '🎓',
    description: 'Seminars, guest lectures and symposiums to sharpen your academics.',
    categories: ['SEMINAR'],
  },
  {
    key: 'CAREER', label: 'Career & Placement', icon: '💼',
    description: 'Placement drives, internships, resume clinics and career talks.',
    categories: ['CAREER'],
  },
  {
    key: 'ARTS', label: 'Arts & Creativity', icon: '🎨',
    description: 'Exhibitions, open mics, photography and hands-on creative sessions.',
    categories: ['ARTS'],
  },
  {
    key: 'OTHER', label: 'Other Events', icon: '🌐',
    description: 'Everything else happening around campus that fits no single box.',
    categories: ['OTHER'],
  },
];

/** Upcoming (SCHEDULED/ONGOING, not ended) published counts per discovery category group. */
async function categoryCounts() {
  const [rows] = await db.execute(
    `SELECT e.category, COUNT(*) AS n
     FROM events e
     WHERE e.is_published = 1 AND e.status IN ('SCHEDULED','ONGOING')
       AND (e.event_date > CURRENT_DATE OR (e.event_date = CURRENT_DATE AND e.end_time >= CURRENT_TIME))
     GROUP BY e.category`
  );
  const byCat = Object.fromEntries(rows.map((r) => [r.category, Number(r.n)]));
  return EVENT_CATEGORY_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    icon: g.icon,
    description: g.description,
    categories: g.categories,
    upcoming_count: g.categories.reduce((sum, c) => sum + (byCat[c] || 0), 0),
  }));
}

// ---------------------------------------------------------------------------
// Public events browsing
// ---------------------------------------------------------------------------
async function listEvents({ search = '', category = '', date = '', sort = 'date_asc', limit = 60, offset = 0, scope = 'upcoming' }) {
  // `scope=past` powers the Events archive: previously held events plus every
  // record brought in by the bulk historical import. The default (upcoming)
  // filter is unchanged, so the main Events page behaves exactly as before.
  const where = ['e.is_published = 1'];
  if (scope === 'past') {
    where.push("(e.is_historical = 1 OR e.status IN ('COMPLETED','CANCELLED'))");
  } else {
    where.push("e.status IN ('SCHEDULED','ONGOING')");
  }
  const params = [];

  if (search) {
    where.push('(e.title LIKE ? OR e.description LIKE ? OR e.venue LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  if (category) {
    // Accepts one DB category, a discovery-group key, or a comma-separated mix.
    const cats = [...new Set(
      category.split(',').flatMap((token) => {
        const t = token.trim().toUpperCase();
        if (!t) return [];
        const group = EVENT_CATEGORY_GROUPS.find((g) => g.key === t);
        return group ? group.categories : [t];
      }).filter((c) => EVENT_CATEGORIES.includes(c))
    )];
    if (cats.length === 1) {
      where.push('e.category = ?');
      params.push(cats[0]);
    } else if (cats.length > 1) {
      where.push(`e.category IN (${cats.map(() => '?').join(',')})`);
      params.push(...cats);
    }
  }
  if (date) {
    where.push('e.event_date = ?');
    params.push(date);
  }

  const defaultOrder = scope === 'past' ? 'e.event_date DESC, e.start_time DESC' : 'e.event_date ASC, e.start_time ASC';
  const orderBy = {
    date_asc: 'e.event_date ASC, e.start_time ASC',
    date_desc: 'e.event_date DESC, e.start_time DESC',
    newest: 'e.created_at DESC',
    popular: 'reg_count DESC, e.event_date ASC',
  }[sort] || defaultOrder;

  const [rows] = await db.execute(
    `SELECT e.id, e.public_id, e.title, e.category, e.event_type, e.venue, e.event_date, e.start_time, e.end_time,
            e.max_participants, e.registration_deadline, e.poster_path, e.description,
            e.status, e.is_historical, e.source_url, e.academic_year,
            u.full_name AS organizer_name, u.account_type AS organizer_account_type,
            c.name AS club_name,
            CASE WHEN u.account_type IN ('college','club') AND u.verified = 1 THEN 1 ELSE 0 END AS is_official,
            (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.id AND r.status = 'REGISTERED') AS registration_count
     FROM events e
     LEFT JOIN users u ON u.id = e.organizer_id
     LEFT JOIN clubs c ON c.id = e.club_id
     WHERE ${where.join(' AND ')}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
    [...params, String(limit), String(offset)]
  );

  const [cnt] = await db.execute(`SELECT COUNT(*) AS total FROM events e WHERE ${where.join(' AND ')}`, params);
  return { events: rows, total: cnt[0].total };
}

const EVENT_DETAIL_SELECT = `
  SELECT e.*, u.full_name AS organizer_name, u.email AS organizer_email,
         u.account_type AS organizer_account_type, u.verified AS organizer_verified,
         CASE WHEN u.account_type IN ('college','club') AND u.verified = 1 THEN 1 ELSE 0 END AS is_official,
         f.full_name AS faculty_coordinator_name, c.name AS club_name,
         d.code AS department_code,
         (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.id AND r.status = 'REGISTERED') AS registration_count
  FROM events e
  LEFT JOIN users u ON u.id = e.organizer_id
  LEFT JOIN users f ON f.id = e.faculty_coordinator_id
  LEFT JOIN clubs c ON c.id = e.club_id
  LEFT JOIN departments d ON d.id = e.department_id`;

async function getEvent(id, userId) {
  const [rows] = await db.execute(`${EVENT_DETAIL_SELECT} WHERE e.id = ?`, [id]);
  const event = rows[0];
  if (!event || (!event.is_published && !userId)) {
    throw new ApiError(404, 'Event not found');
  }

  const now = new Date();
  const deadline = event.registration_deadline ? new Date(event.registration_deadline) : null;
  const seatsLeft = event.max_participants - event.registration_count;
  const isUpcoming = new Date(`${event.event_date}T${event.end_time}`) >= now;

  let regState = 'REGISTRATION_CLOSED';
  if (event.status === 'CANCELLED') regState = 'REGISTRATION_CLOSED';
  else if (!isUpcoming) regState = 'REGISTRATION_CLOSED';
  else if (deadline && now > deadline) regState = 'REGISTRATION_CLOSED';
  else if (seatsLeft <= 0) regState = 'REGISTRATION_FULL';
  else regState = 'REGISTER_NOW';

  let myRegistration = null;
  if (userId) {
    const [mine] = await db.execute(
      `SELECT id, public_id, status, registered_at, cancelled_at FROM event_registrations
       WHERE event_id = ? AND student_id = ? ORDER BY id DESC LIMIT 1`,
      [id, userId]
    );
    myRegistration = mine[0] || null;
    if (myRegistration && myRegistration.status === 'REGISTERED') regState = 'REGISTERED';
  }

  // Previous winners for recurring competitions (linked by competition name)
  const [winners] = await db.execute(
    `SELECT a.id, a.public_id, a.title, a.achievement_year, a.position, a.competition_name,
            w.winner_name, w.team_name
     FROM achievements a
     LEFT JOIN achievement_winners w ON w.achievement_id = a.id
     WHERE a.event_id = ? AND a.verification_status = 'VERIFIED' AND a.is_archived = 0
     ORDER BY a.achievement_year DESC`,
    [id]
  );

  delete event.created_from_request_id;
  return { ...event, seats_left: seatsLeft, registration_state: regState, my_registration: myRegistration, previous_winners: groupWinners(winners) };
}

function groupWinners(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.id)) {
      map.set(r.id, {
        achievement_id: r.id, public_id: r.public_id, title: r.title,
        year: r.achievement_year, position: r.position, competition_name: r.competition_name,
        winners: [],
      });
    }
    const a = map.get(r.id);
    if (r.winner_name) a.winners.push({ name: r.winner_name, team: r.team_name });
    else if (r.team_name) a.winners.push({ team: r.team_name });
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// Registration (transactional, capacity-safe)
// ---------------------------------------------------------------------------
async function registerStudent(eventId, userId) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Lock the event row so concurrent registrations see consistent capacity
    const [evRows] = await conn.execute(
      `SELECT id, title, max_participants, registration_deadline, event_date, end_time, status, is_published, organizer_id, club_id
       FROM events WHERE id = ? FOR UPDATE`,
      [eventId]
    );
    const ev = evRows[0];
    if (!ev) throw new ApiError(404, 'Event not found');
    if (!ev.is_published || ev.status === 'CANCELLED') throw new ApiError(400, 'Registration is closed');

    const now = new Date();
    if (new Date(`${ev.event_date}T${ev.end_time}`) < now) throw new ApiError(400, 'Registration is closed - event has ended');
    if (ev.registration_deadline && now > new Date(ev.registration_deadline)) {
      throw new ApiError(400, 'Registration is closed - deadline has passed');
    }

    const [cntRows] = await conn.execute(
      `SELECT COUNT(*) AS n FROM event_registrations WHERE event_id = ? AND status = 'REGISTERED' FOR UPDATE`,
      [eventId]
    );
    if (cntRows[0].n >= ev.max_participants) throw new ApiError(400, 'Registration is full - no seats remaining');

    const [dupe] = await conn.execute(
      `SELECT id, status FROM event_registrations WHERE event_id = ? AND student_id = ? FOR UPDATE`,
      [eventId, userId]
    );
    if (dupe.length) {
      if (dupe[0].status === 'REGISTERED') throw new ApiError(409, 'You are already registered for this event');
      // previously cancelled -> re-register
      await conn.execute(`UPDATE event_registrations SET status = 'REGISTERED', cancelled_at = NULL, registered_at = NOW() WHERE id = ?`, [dupe[0].id]);
      var regId = dupe[0].id;
    } else {
      const publicId = await nextPublicId(conn, 'event_registrations', 'public_id', 'CC-REG');
      const [ins] = await conn.execute(
        `INSERT INTO event_registrations (public_id, event_id, student_id) VALUES (?, ?, ?)`,
        [publicId, eventId, userId]
      );
      regId = ins.insertId;
    }

    const [pub] = await conn.execute('SELECT public_id FROM event_registrations WHERE id = ?', [regId]);

    // Automatically generate or reactivate ticket with unique ticket code & QR code
    const ticket = await createOrReactivateTicket(conn, regId, eventId, userId);

    // Notify the organizer (and club coordinator if it is a club event)
    await notify(conn, {
      recipientId: ev.organizer_id,
      type: 'NEW_CLUB_REGISTRATION',
      title: 'New event registration',
      message: `A student registered for "${ev.title}".`,
      relatedType: 'EVENT', relatedId: ev.id, link: '/events.html',
    });

    await conn.commit();
    return {
      registration_id: pub[0].public_id,
      event_title: ev.title,
      ticket: {
        id: ticket.id,
        ticket_code: ticket.ticket_code,
        status: ticket.status,
        qr_data_url: ticket.qr_data_url,
      },
    };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function cancelRegistration(eventId, userId) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT r.id, r.status, e.registration_deadline, e.event_date, e.title
       FROM event_registrations r JOIN events e ON e.id = r.event_id
       WHERE r.event_id = ? AND r.student_id = ? FOR UPDATE`,
      [eventId, userId]
    );
    const reg = rows[0];
    if (!reg) throw new ApiError(404, 'Registration not found');
    if (reg.status === 'CANCELLED') throw new ApiError(400, 'Registration is already cancelled');
    if (reg.registration_deadline && new Date() > new Date(reg.registration_deadline)) {
      throw new ApiError(400, 'Cannot cancel after the registration deadline');
    }
    await conn.execute(`UPDATE event_registrations SET status = 'CANCELLED', cancelled_at = NOW() WHERE id = ?`, [reg.id]);
    await cancelTicketByRegistration(conn, reg.id, 'Student cancelled registration');
    await conn.commit();
    return { event_title: reg.title };

  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function myRegistrations(userId) {
  const [rows] = await db.execute(
    `SELECT r.id, r.public_id, r.status, r.registered_at, r.cancelled_at,
            e.id AS event_id, e.title, e.event_date, e.start_time, e.venue, e.category, e.poster_path,
            e.registration_deadline
     FROM event_registrations r
     JOIN events e ON e.id = r.event_id
     WHERE r.student_id = ?
     ORDER BY e.event_date DESC, r.id DESC`,
    [userId]
  );
  return rows;
}

async function eventRegistrations(eventId) {
  const [rows] = await db.execute(
    `SELECT r.public_id, r.status, r.registered_at,
            u.full_name, u.student_id, u.email, d.code AS department
     FROM event_registrations r
     JOIN users u ON u.id = r.student_id
     LEFT JOIN departments d ON d.id = u.department_id
     WHERE r.event_id = ?
     ORDER BY r.registered_at ASC`,
    [eventId]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Event requests (proposal workflow)
// ---------------------------------------------------------------------------
async function createRequest(userId, payload) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const publicId = await nextRequestId(conn);
    const [r] = await conn.execute(
      `INSERT INTO event_requests
        (public_id, requester_id, title, description, objectives, rules, eligibility, contact_details, category, event_type,
         department_id, club_id, venue, proposed_date, start_time, end_time, expected_participants,
         required_facilities, estimated_budget, faculty_coordinator_id, poster_path, proposal_path, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
      [
        publicId, userId, payload.title, payload.description,
        payload.objectives || null,
        payload.rules || null, payload.eligibility || null, payload.contact_details || null,
        payload.category, payload.event_type || 'COLLEGE_WIDE',
        payload.department_id || null, payload.club_id || null,
        payload.venue, payload.proposed_date, payload.start_time, payload.end_time,
        payload.expected_participants || 50, payload.required_facilities || null,
        payload.estimated_budget || null, payload.faculty_coordinator_id || null,
        payload.poster_path || null, payload.proposal_path || null,
      ]
    );
    await conn.execute(
      `INSERT INTO event_request_history (request_id, old_status, new_status, remarks, changed_by)
       VALUES (?, NULL, 'PENDING', 'Request submitted', ?)`,
      [r.insertId, userId]
    );
    // Confirm to the student: waiting for HOD approval
    await notify(conn, {
      recipientId: userId, type: 'EVENT_REQUEST',
      title: 'Event application submitted',
      message: `\uD83D\uDD14 Event application submitted successfully. "${payload.title}" is awaiting HOD approval.`,
      relatedType: 'EVENT_REQUEST', relatedId: r.insertId, link: '/my-applications.html',
    });
    await conn.commit();
    return { id: r.insertId, public_id: publicId };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function listRequests(user, { status = '', mine = false }) {
  const where = [];
  const params = [];
  if (mine || user.role === 'ORGANIZER' || user.role === 'STUDENT') {
    where.push('r.requester_id = ?');
    params.push(user.id);
  }
  if (status) {
    where.push('r.status = ?');
    params.push(status);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await db.execute(
    `SELECT r.*, u.full_name AS requester_name, u.student_id AS requester_student_id, u.email AS requester_email,
            d.code AS department_code, c.name AS club_name,
            f.full_name AS faculty_name, rv.full_name AS reviewer_name
     FROM event_requests r
     LEFT JOIN users u ON u.id = r.requester_id
     LEFT JOIN departments d ON d.id = r.department_id
     LEFT JOIN clubs c ON c.id = r.club_id
     LEFT JOIN users f ON f.id = r.faculty_coordinator_id
     LEFT JOIN users rv ON rv.id = r.reviewed_by
     ${w}
     ORDER BY r.created_at DESC
     LIMIT 200`,
    params
  );
  return rows;
}

async function getRequest(id) {
  const [rows] = await db.execute(
    `SELECT r.*, u.full_name AS requester_name, u.email AS requester_email,
            d.code AS department_code, c.name AS club_name, f.full_name AS faculty_name,
            rv.full_name AS reviewer_name
     FROM event_requests r
     LEFT JOIN users u ON u.id = r.requester_id
     LEFT JOIN departments d ON d.id = r.department_id
     LEFT JOIN clubs c ON c.id = r.club_id
     LEFT JOIN users f ON f.id = r.faculty_coordinator_id
     LEFT JOIN users rv ON rv.id = r.reviewed_by
     WHERE r.id = ?`,
    [id]
  );
  if (!rows.length) throw new ApiError(404, 'Event request not found');
  const [history] = await db.execute(
    `SELECT h.*, u.full_name AS changed_by_name
     FROM event_request_history h LEFT JOIN users u ON u.id = h.changed_by
     WHERE h.request_id = ? ORDER BY h.created_at ASC`,
    [id]
  );
  return { ...rows[0], history };
}

/** Reviewer decision: approve | reject | request-changes. Approving publishes a real event. */
async function reviewRequest(requestId, reviewer, decision, remarks) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(`SELECT * FROM event_requests WHERE id = ? FOR UPDATE`, [requestId]);
    const req = rows[0];
    if (!req) throw new ApiError(404, 'Event request not found');
    if (['APPROVED', 'REJECTED'].includes(req.status)) {
      throw new ApiError(400, `Request is already ${req.status.toLowerCase()}`);
    }
    if (decision === 'approve' && req.status === 'CHANGES_REQUESTED') {
      throw new ApiError(400, 'Request needs to be resubmitted by the organizer first');
    }

    let newStatus;
    if (decision === 'approve') newStatus = 'APPROVED';
    else if (decision === 'reject') newStatus = 'REJECTED';
    else newStatus = 'CHANGES_REQUESTED';

    let eventId = req.event_id;
    if (newStatus === 'APPROVED' && !eventId) {
      // Create a DRAFT event (is_published = 0). The student unlocks the
      // publish step only after HOD approval - they finalize details and
      // publish from "My Event Applications".
      const pubId = await nextPublicId(conn, 'events', 'public_id', 'CC-EVT');
      const [ins] = await conn.execute(
        `INSERT INTO events
          (public_id, created_from_request_id, title, description, rules, eligibility, contact_details, category,
           event_type, department_id, club_id, venue, event_date, start_time, end_time, max_participants,
           registration_deadline, organizer_id, faculty_coordinator_id, status, is_published)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SCHEDULED', 0)`,
        [
          pubId, req.id, req.title, req.description, req.rules, req.eligibility, req.contact_details,
          req.category, req.event_type, req.department_id, req.club_id, req.venue,
          req.proposed_date, req.start_time, req.end_time, req.expected_participants,
          // deadline = 2 days before the event, at 23:59
          (() => { const d = new Date(`${req.proposed_date}T00:00:00`); d.setDate(d.getDate() - 2); return d.toISOString().slice(0, 19).replace('T', ' '); })(),
          req.requester_id, req.faculty_coordinator_id,
        ]
      );
      eventId = ins.insertId;
    }

    await conn.execute(
      `UPDATE event_requests SET status = ?, review_remarks = ?, reviewed_by = ?, reviewed_at = NOW(), event_id = ? WHERE id = ?`,
      [newStatus, remarks || null, reviewer.id, eventId, requestId]
    );
    await conn.execute(
      `INSERT INTO event_request_history (request_id, old_status, new_status, remarks, changed_by)
       VALUES (?, ?, ?, ?, ?)`,
      [requestId, req.status, newStatus, remarks || null, reviewer.id]
    );

    const messages = {
      APPROVED: ['EVENT_APPROVED', 'Your event has been approved!', `\uD83C\uDF89 Your event "${req.title}" has been approved by the HOD! You can now organize and publish the event from My Event Applications.`],
      REJECTED: ['EVENT_REJECTED', 'Your event application was rejected', `Your event application "${req.title}" was rejected. View the HOD's reason in My Event Applications. Reason: ${remarks || 'Not specified'}`],
      CHANGES_REQUESTED: ['CHANGES_REQUESTED', 'Changes requested', `Review remarks were added to your request "${req.title}". Please edit and resubmit.`],
    };
    const [t, title, msg] = messages[newStatus];
    await notify(conn, { recipientId: req.requester_id, type: t, title, message: msg, relatedType: 'EVENT_REQUEST', relatedId: requestId, link: '/organizer/event-requests.html' });

    await conn.commit();

    // Priority notifications to interested students go out when the event is
    // actually PUBLISHED by the organizer (publishRequestEvent), not at approval.
    return { status: newStatus, event_id: eventId };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** Organizer resubmits after CHANGES_REQUESTED. */
async function resubmitRequest(requestId, userId, payload) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(`SELECT * FROM event_requests WHERE id = ? FOR UPDATE`, [requestId]);
    const req = rows[0];
    if (!req) throw new ApiError(404, 'Event request not found');
    if (req.requester_id !== userId) throw new ApiError(403, 'You can only edit your own requests');
    if (req.status !== 'CHANGES_REQUESTED') throw new ApiError(400, 'Only requests with requested changes can be edited');

    await conn.execute(
      `UPDATE event_requests SET title = ?, description = ?, rules = ?, eligibility = ?, contact_details = ?,
        category = ?, event_type = ?, department_id = ?, club_id = ?, venue = ?, proposed_date = ?,
        start_time = ?, end_time = ?, expected_participants = ?, required_facilities = ?, estimated_budget = ?,
        faculty_coordinator_id = ?, status = 'PENDING', review_remarks = NULL
       WHERE id = ?`,
      [
        payload.title, payload.description, payload.rules || null, payload.eligibility || null,
        payload.contact_details || null, payload.category, payload.event_type || 'COLLEGE_WIDE',
        payload.department_id || null, payload.club_id || null, payload.venue, payload.proposed_date,
        payload.start_time, payload.end_time, payload.expected_participants || 50,
        payload.required_facilities || null, payload.estimated_budget || null,
        payload.faculty_coordinator_id || null, requestId,
      ]
    );
    await conn.execute(
      `INSERT INTO event_request_history (request_id, old_status, new_status, remarks, changed_by)
       VALUES (?, 'CHANGES_REQUESTED', 'PENDING', 'Edited and resubmitted', ?)`,
      [requestId, userId]
    );
    await conn.commit();
    return { status: 'PENDING' };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Student publishes their APPROVED proposal: finalizes details and makes the
 * event visible/registerable. Backend-enforced: only the requester, only an
 * APPROVED request, only when the draft event exists unpublished.
 */
async function publishRequestEvent(requestId, userId, payload = {}) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute('SELECT * FROM event_requests WHERE id = ? FOR UPDATE', [requestId]);
    const req = rows[0];
    if (!req) throw new ApiError(404, 'Event request not found');
    if (req.requester_id !== userId) throw new ApiError(403, 'You can only publish your own approved applications');
    if (req.status !== 'APPROVED') throw new ApiError(403, 'HOD approval is required before this event can be published');
    if (!req.event_id) throw new ApiError(400, 'No draft event is linked to this application');

    const [evRows] = await conn.execute('SELECT * FROM events WHERE id = ? FOR UPDATE', [req.event_id]);
    const ev = evRows[0];
    if (!ev) throw new ApiError(404, 'Draft event not found');
    if (ev.is_published) throw new ApiError(400, 'This event is already published');

    // Optional finalization of details before publishing
    const sets = ['is_published = 1'];
    const params = [];
    for (const f of ['venue', 'event_date', 'start_time', 'end_time', 'max_participants', 'description']) {
      if (payload[f] !== undefined && payload[f] !== null && payload[f] !== '') {
        sets.push(`${f} = ?`);
        params.push(f === 'max_participants' ? parseInt(payload[f], 10) || ev.max_participants : payload[f]);
      }
    }
    if (payload.registration_deadline !== undefined) {
      sets.push('registration_deadline = ?');
      params.push(payload.registration_deadline || null);
    }
    params.push(ev.id);
    await conn.execute(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`, params);

    await conn.execute(
      `INSERT INTO event_request_history (request_id, old_status, new_status, remarks, changed_by)
       VALUES (?, 'APPROVED', 'PUBLISHED', 'Event published by the organizer', ?)`,
      [requestId, userId]
    );
    await conn.commit();

    // Interest-based priority notifications (best-effort, after commit)
    notifyInterestedStudents({ id: ev.id, category: ev.category });

    return { event_id: ev.id, public_id: ev.public_id, title: payload.title || ev.title };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Previous winners for a recurring event (linked achievements).
 * Public: verified only.
 */
async function previousWinners(eventId) {
  const [rows] = await db.execute(
    `SELECT a.id, a.public_id, a.title, a.achievement_year AS year, a.position, a.competition_name,
            w.winner_name, w.team_name, w.role
     FROM achievements a
     LEFT JOIN achievement_winners w ON w.achievement_id = a.id
     WHERE a.event_id = ? AND a.verification_status = 'VERIFIED' AND a.is_archived = 0
     ORDER BY a.achievement_year DESC, w.id ASC`,
    [eventId]
  );
  return groupWinners(rows);
}

module.exports = {
  listEvents, getEvent, registerStudent, cancelRegistration, myRegistrations, eventRegistrations,
  createRequest, listRequests, getRequest, reviewRequest, resubmitRequest, previousWinners,
  publishRequestEvent,
  categoryCounts,
  EVENT_CATEGORIES, EVENT_TYPES, EVENT_CATEGORY_GROUPS,
};
