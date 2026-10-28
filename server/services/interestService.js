'use strict';
/**
 * Personalized Event Preferences & Priority Notifications.
 *
 * - 10 interest keys (UI discovery groups + TECH_AI + WORKSHOP_SEMINAR)
 * - Each interest maps to one or more DB event categories
 * - Priority notifications: on event creation, students whose interests
 *   match the event's categories get a priority=1 notification (deduped by
 *   (recipient, dedupe_key) so repeated fan-outs never spam).
 */
const db = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { notify } = require('../utils/notify');

/** UI interest definitions shown on onboarding + profile (client copy kept in sync). */
const INTERESTS = [
  { key: 'SPORTS', label: 'Sports', icon: '🏆', description: 'Tournaments, matches and fitness sessions.', categories: ['SPORTS'] },
  { key: 'TECH', label: 'Coding & Hackathons', icon: '💻', description: 'Hackathons, coding competitions and build sprints.', categories: ['TECHNICAL', 'COMPETITION'] },
  { key: 'CLUB_EVENT', label: 'College Clubs', icon: '🏫', description: 'Club meetups, sessions and activities.', categories: ['CLUB_EVENT'] },
  { key: 'CULTURAL', label: 'Cultural Events', icon: '🎭', description: 'Fests, performances and celebrations.', categories: ['CULTURAL', 'FEST'] },
  { key: 'ARTS', label: 'Arts & Creativity', icon: '🎨', description: 'Exhibitions, open mics and creative sessions.', categories: ['ARTS'] },
  { key: 'TECH_AI', label: 'Technology & AI', icon: '🤖', description: 'AI/ML demos, robotics and emerging tech.', categories: ['TECHNICAL', 'WORKSHOP', 'COMPETITION'] },
  { key: 'ACADEMIC', label: 'Academic Events', icon: '🎓', description: 'Seminars, guest lectures and symposiums.', categories: ['SEMINAR'] },
  { key: 'CAREER', label: 'Career & Placement', icon: '💼', description: 'Placement drives, internships and career talks.', categories: ['CAREER'] },
  { key: 'WORKSHOP_SEMINAR', label: 'Workshops & Seminars', icon: '📢', description: 'Hands-on workshops and expert talks.', categories: ['WORKSHOP', 'SEMINAR'] },
  { key: 'OTHER', label: 'Other', icon: '🌐', description: 'Everything else around campus.', categories: ['ALL'] },
];

const INTEREST_KEYS = INTERESTS.map((i) => i.key);
const ALL_CATEGORIES = ['TECHNICAL', 'CULTURAL', 'SPORTS', 'WORKSHOP', 'SEMINAR', 'COMPETITION', 'FEST', 'CLUB_EVENT', 'CAREER', 'ARTS', 'OTHER'];

/** Categories an interest set covers. 'ALL' matches every event category. */
function categoriesForInterests(keys) {
  const set = new Set();
  for (const k of keys || []) {
    const def = INTERESTS.find((i) => i.key === k);
    if (!def) continue;
    if (def.categories.includes('ALL')) ALL_CATEGORIES.forEach((c) => set.add(c));
    else def.categories.forEach((c) => set.add(c));
  }
  return [...set];
}

/** Emoji + friendly label per DB category (used in notification messages). */
const CATEGORY_META = {
  SPORTS: ['🏆', 'Sports'], TECHNICAL: ['💻', 'Coding & Tech'], WORKSHOP: ['📢', 'Workshop'],
  SEMINAR: ['🎓', 'Seminar'], COMPETITION: ['💻', 'Competition'], CULTURAL: ['🎭', 'Cultural'],
  FEST: ['🎭', 'Fest'], CLUB_EVENT: ['🏫', 'College Clubs'], CAREER: ['💼', 'Career & Placement'],
  ARTS: ['🎨', 'Arts & Creativity'], OTHER: ['🌐', 'Other'],
};

// ---------------------------------------------------------------------------
// Save / skip / status
// ---------------------------------------------------------------------------

/** Replace a student's interests atomically and mark onboarding done. */
async function saveInterests(userId, interestKeys, { skipped = false } = {}) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const wanted = [...new Set((interestKeys || []).map(String))].filter((k) => INTEREST_KEYS.includes(k));
    if (!skipped && !wanted.length) {
      throw new ApiError(400, 'Select at least one interest, or choose "Skip for now"');
    }

    await conn.execute('DELETE FROM student_interests WHERE student_id = ?', [userId]);
    for (const k of wanted) {
      await conn.execute(
        'INSERT INTO student_interests (student_id, interest_key) VALUES (?, ?)',
        [userId, k]
      );
    }
    await conn.execute('UPDATE users SET interests_configured = 1 WHERE id = ?', [userId]);

    await conn.commit();
    return { interests: wanted, skipped: skipped && !wanted.length };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** Onboarding state for the logged-in user. */
async function getStatus(userId) {
  const [flags] = await db.execute(
    'SELECT role, interests_configured FROM users WHERE id = ?', [userId]
  );
  const u = flags[0];
  if (!u) throw new ApiError(404, 'User not found');
  const [rows] = await db.execute(
    'SELECT interest_key FROM student_interests WHERE student_id = ? ORDER BY interest_key', [userId]
  );
  return {
    role: u.role,
    interests_configured: !!u.interests_configured,
    interests: rows.map((r) => r.interest_key),
  };
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

/** Upcoming events whose category matches any of the student's interests. */
async function recommendedEvents(userId, { limit = 6 } = {}) {
  const [ints] = await db.execute(
    'SELECT interest_key FROM student_interests WHERE student_id = ?', [userId]
  );
  const categories = categoriesForInterests(ints.map((r) => r.interest_key));
  if (!categories.length) return { interests: [], events: [] };

  const placeholders = categories.map(() => '?').join(',');
  const [rows] = await db.execute(
    `SELECT e.id, e.public_id, e.title, e.category, e.event_type, e.venue, e.event_date, e.start_time, e.end_time,
            e.max_participants, e.registration_deadline, e.poster_path, e.description,
            u.full_name AS organizer_name, c.name AS club_name,
            (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.id AND r.status = 'REGISTERED') AS registration_count
     FROM events e
     LEFT JOIN users u ON u.id = e.organizer_id
     LEFT JOIN clubs c ON c.id = e.club_id
     WHERE e.is_published = 1 AND e.status IN ('SCHEDULED','ONGOING')
       AND (e.event_date > CURRENT_DATE OR (e.event_date = CURRENT_DATE AND e.end_time >= CURRENT_TIME))
       AND e.category IN (${placeholders})
       AND NOT EXISTS (SELECT 1 FROM event_registrations mr WHERE mr.event_id = e.id AND mr.student_id = ? AND mr.status <> 'CANCELLED')
     ORDER BY e.event_date ASC, e.start_time ASC
     LIMIT ?`,
    [...categories, userId, String(limit)]
  );
  return { interests: ints.map((r) => r.interest_key), events: rows };
}

// ---------------------------------------------------------------------------
// Priority notification fan-out
// ---------------------------------------------------------------------------

/**
 * Notify students whose interests match the event's categories.
 * priority=1 for matching students (red dot, sorted first in the feed).
 * dedupeKey=(recipient, "EVT-<id>-INTEREST") guarantees one notification per
 * student per event no matter how many times the fan-out runs.
 * Best-effort: never breaks event creation.
 */
async function notifyInterestedStudents(event, conn) {
  const dbh = conn || db;
  try {
    const cats = [event.category].filter(Boolean);
    if (!cats.length) return { notified: 0 };

    // Load all (student, interest) pairs and match in JS - portable and small.
    const [pairs] = await dbh.execute('SELECT student_id, interest_key FROM student_interests');
    const matchSet = new Set();
    for (const p of pairs) {
      const def = INTERESTS.find((i) => i.key === p.interest_key);
      if (!def) continue;
      const hit = def.categories.includes('ALL')
        ? true
        : def.categories.some((c) => cats.includes(c));
      if (hit) matchSet.add(p.student_id);
    }
    if (!matchSet.size) return { notified: 0 };

    const [evRows] = await dbh.execute(
      'SELECT title, category, event_date, venue FROM events WHERE id = ?', [event.id]
    );
    const ev = evRows[0] || event;
    const [emoji, label] = CATEGORY_META[ev.category] || ['🔔', ev.category];
    const dateStr = ev.event_date
      ? new Date(ev.event_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
      : '';
    const title = 'New event matching your interest!';
    const message =
      `${ev.title}\n` +
      `${emoji} ${label}\n` +
      (dateStr ? `📅 ${dateStr}\n` : '') +
      (ev.venue ? `📍 ${ev.venue}` : '');

    const dedupeKey = `EVT-${event.id}-INTEREST`;
    // The UNIQUE (recipient_id, dedupe_key) constraint + ON CONFLICT DO NOTHING
    // inside notify() makes duplicate fan-outs a harmless no-op.
    for (const studentId of matchSet) {
      await notify(dbh, {
        recipientId: studentId,
        type: 'EVENT_INTEREST',
        title,
        message,
        relatedType: 'EVENT',
        relatedId: event.id,
        link: `/event-details.html?id=${event.id}`,
        priority: 1,
        dedupeKey,
      });
    }
    return { notified: matchSet.size };
  } catch (e) {
    console.error('notifyInterestedStudents failed (non-fatal):', e.message);
    return { notified: 0 };
  }
}

module.exports = {
  INTERESTS, INTEREST_KEYS, categoriesForInterests,
  saveInterests, getStatus, recommendedEvents, notifyInterestedStudents,
  CATEGORY_META,
};
