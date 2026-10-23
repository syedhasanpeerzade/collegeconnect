'use strict';
/**
 * CollegeConnect API smoke tests.
 *
 * Prerequisites:
 *   - server running (npm start) on http://localhost:3000
 *   - database initialized + seeded (npm run db:init:seed)
 *
 * Run:  npm test          (or: BASE_URL=http://localhost:3000 node test/api.test.js)
 *
 * Exits non-zero if any check fails.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const DEMO_PASSWORD = 'Password@123';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${extra ? ' -> ' + extra : ''}`); }
}

async function api(method, path, { token, body, raw } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return { res, data: null };
  let data = null;
  try { data = await res.json(); } catch (_e) { /* non-JSON */ }
  return { res, data };
}

async function login(email) {
  const { res, data } = await api('POST', '/api/auth/login', { body: { email, password: DEMO_PASSWORD } });
  if (!data || !data.data || !data.data.token) {
    throw new Error(`login failed for ${email} (HTTP ${res.status}): ${JSON.stringify(data)}`);
  }
  return { token: data.data.token, user: data.data.user };
}

/**
 * Delete fixtures leaked by an earlier crashed/interrupted run.
 *
 * These checks create rows that only get cleaned up on the happy path, so a
 * run that dies halfway leaves junk in a real database - historically 20+
 * "Student Write Guard Test" achievements that were publicly visible in the
 * Hall of Fame. Sweeping by exact title at the start keeps that from piling up.
 */
async function sweepTestArtifacts(admin) {
  if (!admin) return 0;
  let removed = 0;

  const { data: achData } = await api('GET', '/api/achievements?status=VERIFIED&limit=500', { token: admin.token });
  const achievements = (achData && achData.data && achData.data.achievements) || (achData && achData.data) || [];
  for (const a of achievements) {
    if (a.title !== 'Student Write Guard Test') continue;
    const { res } = await api('DELETE', `/api/achievements/${a.id}`, { token: admin.token });
    if (res.status === 200) removed += 1;
  }

  // Event fixtures: the approval-guard drafts and the throwaway event the
  // registration flow mints (its title carries a timestamp, hence the prefix).
  const LEAKED_EVENT_TITLES = ['Early Publish Guard Test'];
  const LEAKED_EVENT_PREFIXES = ['Registration Flow Test'];
  const { data: evData } = await api('GET', '/api/admin/content/events', { token: admin.token });
  for (const e of (evData && evData.data) || []) {
    const title = String(e.title || '');
    const leaked = LEAKED_EVENT_TITLES.includes(title) || LEAKED_EVENT_PREFIXES.some((p) => title.startsWith(p));
    if (!leaked) continue;
    const { res } = await api('DELETE', `/api/events/${e.id}`, { token: admin.token });
    if (res.status === 200) removed += 1;
  }

  return removed;
}

/**
 * Demo accounts whose moderation counters this suite disturbs. The reporting
 * checks file a report (counted against the reporter) against another demo
 * account (counted against the target), so both sides are reset.
 */
const MODERATION_DEMO_EMAILS = ['student@collegeconnect.com', 'admin@collegeconnect.com'];

/**
 * Run `fn(client)` against the database, but ONLY for a local BASE_URL — so a
 * run pointed at a remote server can never reach in and modify another
 * database. Returns null when the sweep is not applicable.
 */
async function withLocalDb(fn) {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(BASE)) return null;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || !/^(postgres|postgresql):/i.test(connectionString)) return null;

  const { Client } = require('pg');
  const ssl = /supabase|neon|render|amazonaws|azure|heroku/i.test(connectionString)
    ? { rejectUnauthorized: false } : false;
  const client = new Client({ connectionString, ssl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Event-request fixtures have no delete endpoint, so the only way to keep them
 * out of the admin approval queue is a direct cleanup.
 * @returns {Promise<number|null>} rows removed, or null when skipped.
 */
async function sweepRequestFixtures() {
  return withLocalDb(async (client) => {
    const { rowCount } = await client.query(
      "DELETE FROM event_requests WHERE title IN ('Smoke Test Workshop', 'Early Publish Guard Test')"
    );
    return rowCount;
  });
}

/**
 * Undo the moderation side effects of the reporting checks.
 *
 * Filing a user report is covered on purpose, but leaving those reports in the
 * queue has a real cost: they accumulate against the same demo account and,
 * after the 10th in an hour, the anti-harassment auto-shield holds that
 * account's future posts and comments for review. That is the product working
 * correctly - the test just has to put things back.
 *
 * @returns {Promise<number|null>} rows reset, or null when skipped.
 */
async function sweepModerationFixtures() {
  return withLocalDb(async (client) => {
    const reports = await client.query("DELETE FROM user_reports WHERE detail = 'smoke'");
    const counters = await client.query(
      `DELETE FROM rate_limit_counters WHERE key = 'report_per_hour'
         AND user_id IN (SELECT id FROM users WHERE email = ANY($1::text[]))`,
      [MODERATION_DEMO_EMAILS]
    );
    // Only ever release a SYSTEM auto-shield on the demo accounts; a shield an
    // administrator applied by hand is left alone.
    const shields = await client.query(
      `UPDATE user_shield SET reason = 'CLEARED', set_by = 'ADMIN',
              note = 'Cleared after automated smoke-test report', created_at = NOW()
         WHERE reason = 'AUTOMATIC' AND set_by = 'SYSTEM'
           AND user_id IN (SELECT id FROM users WHERE email = ANY($1::text[]))`,
      [MODERATION_DEMO_EMAILS]
    );
    return reports.rowCount + counters.rowCount + shields.rowCount;
  });
}

async function main() {
  console.log(`\nCollegeConnect API smoke tests -> ${BASE}\n`);

  // ---- Infrastructure ----
  {
    const { res, data } = await api('GET', '/api/health');
    check('GET /api/health -> 200', res.status === 200 && data && data.success === true);
  }
  {
    const { res, data } = await api('GET', '/api/auth/departments');
    check('GET /api/auth/departments -> 200 with rows', res.status === 200 && Array.isArray(data && data.data) && data.data.length >= 5);
  }

  // ---- Auth + roles ----
  let student, admin, faculty, organizer, coordinator;
  try {
    student = await login('student@collegeconnect.com');
    check('login STUDENT returns token + role', student.user && student.user.role === 'STUDENT');
    admin = await login('admin@collegeconnect.com');
    check('login ADMIN returns token', !!admin.token);
    faculty = await login('faculty@collegeconnect.com');
    organizer = await login('organizer@collegeconnect.com');
    coordinator = await login('coordinator@collegeconnect.com');
  } catch (e) {
    check('demo logins', false, e.message);
  }

  // ---- Housekeeping: never leave fixture rows behind in the database ----
  if (admin) {
    const sweptApi = await sweepTestArtifacts(admin);
    const sweptReq = await sweepRequestFixtures();
    const sweptMod = await sweepModerationFixtures();
    const parts = [
      sweptApi ? `${sweptApi} record(s)` : null,
      sweptReq ? `${sweptReq} event request(s)` : null,
      sweptMod ? `${sweptMod} moderation row(s)` : null,
    ].filter(Boolean);
    if (parts.length) console.log(`  (cleaned up ${parts.join(' + ')} leaked by an earlier run)`);

    // Every sweep must be idempotent: run them again and nothing should remain.
    const leftApi = await sweepTestArtifacts(admin);
    const leftReq = await sweepRequestFixtures();
    const leftMod = await sweepModerationFixtures();
    check('no leaked test fixtures in the database',
      leftApi === 0 && (leftReq === null || leftReq === 0) && (leftMod === null || leftMod === 0),
      `records=${leftApi} event_requests=${leftReq} moderation=${leftMod}`);
  }

  if (student) {
    const { res, data } = await api('GET', '/api/auth/me', { token: student.token });
    check('GET /api/auth/me (authenticated)', res.status === 200 && data.data && data.data.email === 'student@collegeconnect.com');
  }
  {
    const { res } = await api('GET', '/api/auth/me');
    check('GET /api/auth/me without token -> 401', res.status === 401);
  }
  if (student) {
    const { res } = await api('GET', '/api/admin/users', { token: student.token });
    check('STUDENT blocked from /api/admin/users', res.status === 403);
  }
  {
    const { res } = await api('POST', '/api/auth/login', { body: { email: 'student@collegeconnect.com', password: 'wrong-password' } });
    check('wrong password rejected', res.status === 401);
  }

  // ---- Events ----
  let events = [];
  {
    const { res, data } = await api('GET', '/api/events');
    events = (data && data.data && data.data.events) || [];
    check('GET /api/events lists approved events', res.status === 200 && Array.isArray(events) && events.length >= 5);
  }
  {
    // Pick whatever category the live data actually has upcoming, then verify
    // the filter returns only rows of that category (seed-independent).
    const first = events[0];
    const cat = first ? first.category : 'SPORTS';
    const { res, data } = await api('GET', `/api/events?category=${encodeURIComponent(cat)}`);
    const list = (data && data.data && data.data.events) || [];
    check('events category filter works', res.status === 200 && list.every((e) => e.category === cat) && list.length >= 1);
  }
  {
    const { res, data } = await api('GET', '/api/events/categories');
    const cats = (data && data.data) || [];
    const keys = cats.map((c) => c.key);
    check('GET /api/events/categories lists 8 discovery groups', res.status === 200 && cats.length === 8
      && cats.every((c) => c.key && c.label && c.icon && c.description && Array.isArray(c.categories) && typeof c.upcoming_count === 'number')
      && ['SPORTS','TECH','CLUB_EVENT','CULTURAL','ACADEMIC','CAREER','ARTS','OTHER'].every((k) => keys.includes(k)));
  }
  {
    const { res, data } = await api('GET', '/api/events?category=TECH');
    const list = (data && data.data && data.data.events) || [];
    check('events group-key filter (TECH -> TECHNICAL/WORKSHOP/COMPETITION)', res.status === 200 && list.length >= 1
      && list.every((e) => ['TECHNICAL', 'WORKSHOP', 'COMPETITION'].includes(e.category)));
  }
  {
    const { res, data } = await api('GET', '/api/events?category=CULTURAL');
    const list = (data && data.data && data.data.events) || [];
    check('events multi-category group (CULTURAL -> CULTURAL/FEST)', res.status === 200 && list.length >= 1
      && list.every((e) => ['CULTURAL', 'FEST'].includes(e.category)));
  }
  // Registration needs a published event with seats open and a future deadline.
  // Seed data may have none left, so mint a throwaway one as admin instead of
  // skipping the flow. `tempEventId` is cleaned up at the end of the block.
  let target = events.find((e) => e.registration_count < e.max_participants && new Date(e.registration_deadline) > new Date());
  let tempEventId = null;
  if (student && admin && !target) {
    const deadline = new Date(Date.now() + 7 * 864e5);
    const mk = await api('POST', '/api/events', {
      token: admin.token,
      body: {
        title: `Registration Flow Test ${Date.now()}`, description: 'Automated registration flow test event.',
        category: 'WORKSHOP', venue: 'Test Hall',
        event_date: new Date(Date.now() + 9 * 864e5).toISOString().slice(0, 10),
        start_time: '10:00', end_time: '12:00', max_participants: 40,
        registration_deadline: deadline.toISOString().slice(0, 10),
      },
    });
    if (mk.res.status === 201 && mk.data.data && mk.data.data.id) {
      tempEventId = mk.data.data.id;
      target = { id: tempEventId, registration_count: 0, max_participants: 40, registration_deadline: deadline.toISOString() };
    }
  }
  if (student && target) {
    const { res, data } = await api('POST', `/api/events/${target.id}/register`, { token: student.token });
    check('student registers for event', res.status === 201 && data.data && /^CC-REG-\d{4}-\d{5}$/.test(data.data.registration_id), JSON.stringify(data));

    const { res: res2, data: data2 } = await api('POST', `/api/events/${target.id}/register`, { token: student.token });
    check('duplicate registration rejected (409)', res2.status === 409, JSON.stringify(data2));

    const { res: res3, data: data3 } = await api('GET', `/api/events/${target.id}`, { token: student.token });
    check('event detail shows REGISTERED state', res3.status === 200 && data3.data.registration_state === 'REGISTERED');

    const { res: res4 } = await api('DELETE', `/api/events/${target.id}/register`, { token: student.token });
    check('cancel registration', res4.status === 200);

    if (tempEventId) await api('DELETE', `/api/events/${tempEventId}`, { token: admin.token });
  } else {
    check('event registration flow', false, 'no registerable event or no student token');
  }
  {
    const { res, data } = await api('GET', '/api/events?date=2030-01-01');
    const list = (data && data.data && data.data.events) || [];
    check('events date filter returns empty state', res.status === 200 && list.length === 0);
  }

  // ---- Personalized interests + priority notifications ----
  if (student) {
    const opts = await api('GET', '/api/interests/options');
    check('interests options (10 keys, public)', opts.res.status === 200 && opts.data.data.length === 10);

    const st1 = await api('GET', '/api/interests/status', { token: student.token });
    check('interests status shape', st1.res.status === 200 && typeof st1.data.data.interests_configured === 'boolean' && Array.isArray(st1.data.data.interests));

    const save = await api('PUT', '/api/interests', { token: student.token, body: { interests: ['SPORTS', 'TECH', 'TECH_AI'] } });
    check('save interests', save.res.status === 200 && save.data.data.interests.length === 3);

    const empty = await api('PUT', '/api/interests', { token: student.token, body: { interests: [] } });
    check('empty interests rejected without skip flag', empty.res.status === 400);

    const rec = await api('GET', '/api/events/recommended', { token: student.token });
    const recEvents = (rec.data && rec.data.data && rec.data.data.events) || [];
    check('recommended events match interests', rec.res.status === 200
      && recEvents.every((e) => ['SPORTS', 'TECHNICAL', 'WORKSHOP', 'COMPETITION'].includes(e.category)));

    // Priority notification: create a SPORTS event as admin, expect a priority=1
    // notification for the student (who has SPORTS interest above).
    const adminLogin = admin || await login('admin@collegeconnect.com').catch(() => null);
    if (adminLogin) {
      const tomorrow = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
      const mk = await api('POST', '/api/events', {
        token: adminLogin.token,
        body: {
          title: `Prio-Notify Test ${Date.now()}`, description: 'Automated priority notification test event.',
          category: 'SPORTS', venue: 'Test Ground', event_date: tomorrow,
          start_time: '09:00', end_time: '17:00', max_participants: 50,
        },
      });
      check('admin creates event with category', mk.res.status === 201 && mk.data.data.id);
      if (mk.data.data && mk.data.data.id) {
        await new Promise((r) => setTimeout(r, 300)); // fan-out is async best-effort
        const notifs = await api('GET', '/api/notifications', { token: student.token });
        const prio = (notifs.data.data || []).find((n) => n.type === 'EVENT_INTEREST' && n.priority === 1 && /Prio-Notify Test/.test(n.message));
        check('priority notification created for matching student', !!prio);
        if (prio) await api('DELETE', `/api/events/${mk.data.data.id}`, { token: adminLogin.token });
      }
    }
  } else {
    check('interests flow', false, 'no student token');
  }

  // ---- Event requests (approval workflow) ----
  if (student && faculty) {
    const body = {
      title: 'Smoke Test Workshop', category: 'WORKSHOP', description: 'API smoke test proposal.',
      proposed_date: new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10),
      start_time: '10:00', end_time: '12:00', venue: 'Test Hall', expected_participants: 30,
      event_type: 'COLLEGE_WIDE',
    };
    const { res, data } = await api('POST', '/api/event-requests', { token: student.token, body });
    const reqId = data && data.data && data.data.id;
    check('student submits event request', res.status === 201 && /^REQ-\d{4}-\d{4}$/.test(data.data.public_id), JSON.stringify(data));

    const { res: r2 } = await api('PUT', `/api/event-requests/${reqId}/approve`, { token: faculty.token, body: { remarks: 'ok for smoke test' } });
    check('faculty approves request', r2.status === 200);

    // Approval now creates a DRAFT (unpublished) event; the student must
    // explicitly publish. Publishing before approval must be impossible.
    const { res: rd, data: dd } = await api('GET', `/api/events/requests/${reqId}`, { token: student.token });
    const draftEventId = dd.data.event_id;
    check('approval creates draft event (not yet public)', rd.status === 200 && !!draftEventId);

    const { res: r3, data: d3 } = await api('GET', `/api/events?search=${encodeURIComponent('Smoke Test Workshop')}`);
    const created = (d3.data && d3.data.events) || [];
    check('approved request NOT public until student publishes', r3.status === 200 && created.length === 0);

    const { res: rpub, data: dpub } = await api('PUT', `/api/events/requests/${reqId}/publish`, {
      token: student.token,
      body: { venue: 'Test Hall', max_participants: 40 },
    });
    check('student publishes approved application', rpub.status === 201 && dpub.data.event_id, JSON.stringify(dpub));

    const { res: r4, data: d4 } = await api('GET', `/api/events?search=${encodeURIComponent('Smoke Test Workshop')}`);
    const published = (d4.data && d4.data.events) || [];
    check('published event now visible on events page', r4.status === 200 && published.length === 1);

    // Publish-before-approval guard: submit a second request and try early
    const early = await api('POST', '/api/event-requests', { token: student.token, body: { ...body, title: 'Early Publish Guard Test' } });
    const earlyId = early.data.data.id;
    const { res: rGuard } = await api('PUT', `/api/events/requests/${earlyId}/publish`, { token: student.token, body: {} });
    check('publish before HOD approval blocked (403)', rGuard.status === 403);
    await api('DELETE', `/api/events/${draftEventId}`, { token: admin.token });
  }

  // ---- Clubs ----
  {
    const { res, data } = await api('GET', '/api/clubs');
    check('GET /api/clubs lists clubs', res.status === 200 && Array.isArray(data.data) && data.data.length >= 1);
  }
  if (student) {
    const { data: d1 } = await api('GET', '/api/clubs?search=campus');
    check('club search works', Array.isArray(d1.data) && d1.data.some((c) => /campus/i.test(c.name)));

    const clubs = (await api('GET', '/api/clubs')).data.data;
    const open = clubs.find((c) => c.recruitment_status === 'OPEN');
    const { res: r1, data: r1d } = await api('POST', `/api/clubs/${open.id}/apply`, {
      token: student.token,
      body: { why_join: 'Smoke test application.', experience: 'None yet.', skills: 'Testing', interests: 'QA', answers: [] },
    });
    check('club application accepted or duplicate-blocked', r1.status === 201 || (r1.status === 409 && /already/i.test(r1d.message)), JSON.stringify(r1d));

    const { res: r2 } = await api('GET', '/api/my-club-applications', { token: student.token });
    check('my-club-applications lists the application', r2.status === 200);
  }

  // ---- Complaints ----
  if (student && faculty) {
    const body = {
      title: 'Smoke test complaint', description: 'Created by automated test.',
      category: 'OTHER', location: 'Test location', priority: 'LOW',
    };
    const { res, data } = await api('POST', '/api/complaints', { token: student.token, body });
    const cid = data && data.data && data.data.id;
    check('complaint created', res.status === 201 && data.data && /^CC-CMP-\d{4}-\d{5}$/.test(data.data.public_id), JSON.stringify(data));

    const { res: r2 } = await api('PUT', `/api/complaints/${cid}/status`, {
      token: faculty.token, body: { status: 'UNDER_REVIEW', remarks: 'Looking into it.' },
    });
    check('faculty updates complaint status', r2.status === 200);

    const { res: r3, data: d3 } = await api('GET', `/api/complaints/${cid}`, { token: student.token });
    check('complaint detail has history timeline', r3.status === 200 && Array.isArray(d3.data.history) && d3.data.history.length >= 2);

    const { res: r4 } = await api('PUT', `/api/complaints/${cid}/status`, {
      token: faculty.token, body: { status: 'RESOLVED', remarks: 'Fixed.' },
    });
    const { res: r5 } = await api('POST', `/api/complaints/${cid}/feedback`, {
      token: student.token, body: { action: 'confirm', feedback: 'Thanks!', rating: 5 },
    });
    check('student feedback accepted', r5.status === 200, JSON.stringify(r4) + ' / ' + JSON.stringify(r5));
  }

  // ---- Announcements + notifications ----
  {
    const { res, data } = await api('GET', '/api/announcements');
    check('GET /api/announcements (public)', res.status === 200 && Array.isArray(data.data));
  }
  if (student) {
    const { res: r1, data: d1 } = await api('GET', '/api/notifications', { token: student.token });
    check('notifications feed', r1.status === 200 && Array.isArray(d1.data));
    const { res: r2, data: d2 } = await api('GET', '/api/notifications/unread-count', { token: student.token });
    check('unread count endpoint', r2.status === 200 && typeof d2.data.count === 'number');
    const { res: r3 } = await api('PUT', '/api/notifications/read-all', { token: student.token });
    check('mark all notifications read', r3.status === 200);
  }

  // ---- Achievements + previous winners ----
  {
    const { res, data } = await api('GET', '/api/achievements');
    const list = (data && data.data && data.data.achievements) || data.data || [];
    check('hall of fame shows verified achievements', res.status === 200 && Array.isArray(list) && list.every((a) => a.verification_status === 'VERIFIED'));
  }
  if (admin) {
    const { res: r2, data: d2 } = await api('GET', '/api/achievements?status=PENDING_VERIFICATION', { token: admin.token });
    const pending = (d2 && d2.data) || [];
    check('admin sees pending verification queue', r2.status === 200 && Array.isArray(pending));
  }
  if (student && admin) {
    // Students are read-only: backend must reject writes regardless of UI
    const payload = { title: 'Student Write Guard Test', competition_name: 'Guard Comp', category: 'OTHER' };
    const { res: rc } = await api('POST', '/api/achievements', { token: student.token, body: payload });
    check('STUDENT blocked from creating achievements (403)', rc.status === 403);
    const { res: re } = await api('PUT', '/api/achievements/1', { token: student.token, body: { title: 'Hacked Title Here' } });
    check('STUDENT blocked from editing achievements (403)', re.status === 403);
    const { res: rd } = await api('DELETE', '/api/achievements/1', { token: student.token });
    check('STUDENT blocked from deleting achievements (403)', rd.status === 403);
    // NOTE: this used to destructure only `res` and then read `rf.data.data`,
    // so the cleanup branch never ran and every test run permanently added a
    // "Student Write Guard Test" achievement to the public Hall of Fame.
    const { res: rf, data: rfData } = await api('POST', '/api/achievements', { token: faculty ? faculty.token : admin.token, body: payload });
    check('FACULTY/HOD can create achievements', rf.status === 201, JSON.stringify(rfData));
    if (rf.status === 201 && rfData && rfData.data && rfData.data.id) {
      const { res: rdel } = await api('DELETE', `/api/achievements/${rfData.data.id}`, { token: admin.token });
      check('HOD/admin can delete achievements', rdel.status === 200);
    } else {
      check('HOD/admin can delete achievements', false, 'create did not return an id to clean up');
    }
  }
  {
    const evId = 2; // any published event id works; minimal seed has no linked winners
    const { res, data } = await api('GET', `/api/events/${evId}/previous-winners`);
    const winners = (data && data.data) || [];
    check('event previous-winners endpoint', res.status === 200 && Array.isArray(winners));
  }

  // ---- Admin: users, stats, CSV, QR ----
  if (admin) {
    const { res: r1, data: d1 } = await api('GET', '/api/admin/dashboard/admin', { token: admin.token });
    check('admin dashboard stats', r1.status === 200 && d1.data.counts && typeof d1.data.counts.total_students === 'number');

    const { res: r2, data: d2 } = await api('GET', '/api/admin/users?role=STUDENT', { token: admin.token });
    check('admin user list + role filter', r2.status === 200 && Array.isArray(d2.data) && d2.data.length >= 1 && d2.data.every((u) => u.role === 'STUDENT'));

    for (const report of ['registrations', 'complaints', 'previous-winners']) {
      const { res } = await api('GET', `/api/admin/reports/${report}`, { token: admin.token, raw: true });
      const text = await res.text();
      check(`CSV report ${report} downloads`, res.status === 200 && text.length > 0);
    }

    const { res: rq } = await api('GET', '/api/qr/event-page', { raw: true });
    const buf = await rq.arrayBuffer();
    check('QR endpoint returns PNG', rq.status === 200 && (rq.headers.get('content-type') || '').includes('image/png') && buf.byteLength > 500);

    const { res: rm, data: rmData } = await api('GET', '/api/qr/event-page-meta');
    check('QR meta points to /events', rm.status === 200 && !!rmData && !!rmData.data && /\/events$/.test(rmData.data.url));
  }

  // ---- Social layer: feed, anonymous identity, comments, reactions, follow,
  //      save and reporting (the full student-facing flow). ----
  {
    // Feed is public but personalizes with auth; this was the endpoint that
    // used to 500 on the ORDER BY alias.
    const { res: rf, data: df } = await api('GET', '/api/social/feed?tab=foryou', { token: student.token });
    check('GET /api/social/feed (foryou) -> rows + hasMore',
      rf.status === 200 && Array.isArray(df.data.rows) && typeof df.data.hasMore === 'boolean');

    const { res: ro, data: dof } = await api('GET', '/api/social/feed?tab=official', { token: student.token });
    check('GET /api/social/feed (official) -> every row is official',
      ro.status === 200 && dof.data.rows.every((p) => Number(p.official) === 1));

    const { res: rd, data: dd } = await api('GET', '/api/social/discover', { token: student.token });
    check('GET /api/social/discover -> trending/events/communities',
      rd.status === 200 && Array.isArray(dd.data.trending_discussions) && Array.isArray(dd.data.upcoming_events)
      && Array.isArray(dd.data.popular_communities) && Array.isArray(dd.data.suggested_people));

    // Anonymous post: the server must never leak the real author.
    const { res: ra, data: da } = await api('POST', '/api/social/posts', {
      token: student.token,
      body: { kind: 'POST', content: 'smoke-test anonymous post', is_anonymous: '1' },
    });
    const anonPost = da && da.data;
    check('POST /api/social/posts (anonymous) -> identity stripped server-side',
      ra.status === 201 && !!anonPost && anonPost.is_anonymous === 1
      && anonPost.author_name === 'Anonymous Student' && anonPost.author_id == null
      && Number(anonPost.official) === 0);

    // Normal post, commented on and reacted to by a different account.
    const { res: rp, data: dp } = await api('POST', '/api/social/posts', {
      token: student.token,
      body: { kind: 'POST', content: 'smoke-test visible post' },
    });
    const post = dp && dp.data;
    check('POST /api/social/posts -> 201 with real author',
      rp.status === 201 && !!post && Number(post.author_id) === Number(student.user.id));

    if (post) {
      const { res: rc, data: dc } = await api('POST', `/api/social/posts/${post.id}/comments`, {
        token: admin.token, body: { content: 'smoke-test comment' },
      });
      const listed = ((dc.data || {}).comments || []).flatMap((c) => [c, ...(c.replies || [])]);
      check('POST comment by another account appears in the thread',
        rc.status === 201 && listed.some((c) => c.content === 'smoke-test comment'));

      const { res: rr, data: dr } = await api('PUT', '/api/social/reactions', {
        token: admin.token, body: { target_type: 'POST', target_id: post.id, value: 1 },
      });
      check('PUT reaction (like) -> reacted + like count 1',
        rr.status === 200 && dr.data.reacted === true && Number(dr.data.counts.likes) === 1);

      const { res: rr2, data: dr2 } = await api('PUT', '/api/social/reactions', {
        token: admin.token, body: { target_type: 'POST', target_id: post.id, value: 1 },
      });
      check('repeating the same reaction toggles it off',
        rr2.status === 200 && dr2.data.reacted === false && Number(dr2.data.counts.likes) === 0);

      const { res: rs } = await api('PUT', `/api/social/posts/${post.id}/save`, { token: student.token });
      const { res: rsv, data: dsv } = await api('GET', '/api/social/saved', { token: student.token });
      check('save post -> appears on /api/social/saved',
        rs.status === 200 && Array.isArray(dsv.data) && dsv.data.some((p) => Number(p.id) === Number(post.id)));

      // Report flow (idempotent: a repeat report answers 200 "already reported").
      const { res: rr3, data: dr3 } = await api('POST', '/api/reports/posts', {
        token: admin.token, body: { postId: Number(post.id), reason: 'SPAM', detail: '' },
      });
      check('POST /api/reports/posts -> report accepted',
        (rr3.status === 201 || rr3.status === 200) && !!dr3.data);
      const { res: rpend, data: dpend } = await api('GET', '/api/reports/pending?type=post', { token: admin.token });
      const queue = (dpend.data && dpend.data.rows) || [];
      check('admin sees the reported post in the moderation queue',
        rpend.status === 200 && queue.some((r) => Number(r.post_id) === Number(post.id)));

      const { res: rdel } = await api('DELETE', `/api/social/posts/${post.id}`, { token: student.token });
      check('author can delete their own post', rdel.status === 200);
    }
    if (anonPost) {
      await api('DELETE', `/api/social/posts/${anonPost.id}`, { token: student.token });
    }

    // Follow / unfollow + the follow lists that the profile page renders.
    const { res: rfol, data: dfol } = await api('PUT', `/api/social/users/${admin.user.id}/follow`, { token: student.token });
    check('PUT follow -> following = true', rfol.status === 200 && dfol.data.following === true);
    const { res: rfl, data: dfl } = await api('GET', `/api/social/users/${student.user.id}/following`, { token: student.token });
    check('GET following list includes the followed account',
      rfl.status === 200 && Array.isArray(dfl.data) && dfl.data.some((u) => Number(u.id) === Number(admin.user.id)));
    const { res: rfr, data: dfr } = await api('GET', `/api/social/users/${admin.user.id}/followers`, { token: student.token });
    check('GET followers list includes the follower',
      rfr.status === 200 && Array.isArray(dfr.data) && dfr.data.some((u) => Number(u.id) === Number(student.user.id)));
    const { res: runf, data: dunf } = await api('PUT', `/api/social/users/${admin.user.id}/follow`, { token: student.token });
    check('PUT follow again -> unfollowed', runf.status === 200 && dunf.data.following === false);

    // Anti-harassment: reporting a user account is accepted, then an admin can
    // resolve it. (The teardown resets the counters so this check cannot push
    // the demo account into the automatic shield.)
    const { res: rur, data: dur } = await api('POST', '/api/reports/users', {
      token: student.token, body: { targetId: Number(admin.user.id), reason: 'HARASSMENT', detail: 'smoke' },
    });
    check('POST /api/reports/users -> accepted', rur.status === 201 || rur.status === 200, JSON.stringify(dur));

    const { res: rurList, data: durList } = await api('GET', '/api/reports/pending?type=user', { token: admin.token });
    const userQueue = (durList && durList.data && durList.data.rows) || [];
    const mine2 = userQueue.find((r) => Number(r.target_id) === Number(admin.user.id) && r.detail === 'smoke');
    check('reported user appears in the admin moderation queue', !!mine2);
    if (mine2) {
      const { res: rres } = await api('PUT', '/api/reports/resolve', {
        token: admin.token,
        body: { reportId: mine2.id, reportType: 'user', action: 'DISMISSED', note: 'smoke test cleanup' },
      });
      check('admin can resolve a user report', rres.status === 200);
    }
  }

  // ---- Teardown: a successful run must leave the database as it found it ----
  if (admin) {
    const removedApi = await sweepTestArtifacts(admin);
    const removedReq = await sweepRequestFixtures();
    const removedMod = await sweepModerationFixtures();
    if (removedApi || removedReq || removedMod) {
      console.log(`  (teardown removed ${removedApi} record(s), ${removedReq || 0} event request(s), ${removedMod || 0} moderation row(s))`);
    }
    // Assert on a FRESH pass, so the assertion measures what is left behind
    // rather than counting the rows the cleanup just deleted.
    const leftApi = await sweepTestArtifacts(admin);
    const leftReq = await sweepRequestFixtures();
    const leftMod = await sweepModerationFixtures();
    check('database left clean after the run',
      leftApi === 0 && (leftReq === null || leftReq === 0) && (leftMod === null || leftMod === 0),
      `records=${leftApi} event_requests=${leftReq} moderation=${leftMod}`);
  }

  // ---- Summary ----
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('Failed checks:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('All smoke tests passed.\n');
}

main().catch((e) => { console.error('Test runner crashed:', e.stack); process.exit(1); });
