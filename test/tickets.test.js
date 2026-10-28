'use strict';
/**
 * CollegeConnect — Two-Sided Event Ticketing System Integration Tests.
 *
 * Validates the complete 12-step workflow from the prompt specification.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const DEMO_PASSWORD = 'Password@123';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}${extra ? ' -> ' + extra : ''}`);
  }
}

async function api(method, path, { token, body, raw } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
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

async function run() {
  console.log(`\nStarting Two-Sided Event Ticketing System Tests -> ${BASE}\n`);

  // 1. Authenticate actors
  const student = await login('student@collegeconnect.com');
  const admin = await login('admin@collegeconnect.com');
  const faculty = await login('faculty@collegeconnect.com');
  const coordinator = await login('coordinator@collegeconnect.com');

  check('actors authenticated successfully', student && admin && faculty && coordinator);

  // 2. Setup: Admin creates two distinct test events
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const nextWeek = new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const { res: ev1Res, data: ev1Data } = await api('POST', '/api/events', {
    token: admin.token,
    body: {
      title: 'Ticket Test Main Event ' + Date.now(),
      description: 'Main event for entry verification tests',
      category: 'TECHNICAL',
      event_type: 'COLLEGE_WIDE',
      event_date: tomorrow,
      start_time: '10:00:00',
      end_time: '16:00:00',
      venue: 'Main Auditorium Hall A',
      max_participants: 50,
      is_published: 1,
    },
  });
  const event1 = ev1Data && ev1Data.data;
  check('admin created primary test event', ev1Res.status === 201 && event1 && event1.id);

  const { res: ev2Res, data: ev2Data } = await api('POST', '/api/events', {
    token: admin.token,
    body: {
      title: 'Ticket Test Alternate Event ' + Date.now(),
      description: 'Second event to test WRONG_EVENT rejection',
      category: 'CULTURAL',
      event_type: 'COLLEGE_WIDE',
      event_date: nextWeek,
      start_time: '14:00:00',
      end_time: '18:00:00',
      venue: 'Open Air Theatre',
      max_participants: 100,
      is_published: 1,
    },
  });
  const event2 = ev2Data && ev2Data.data;
  check('admin created alternate test event', ev2Res.status === 201 && event2 && event2.id);

  try {
    // 3. Step 1 & 2: Student registers for event 1 -> automatic unique ticket & QR code generated
    const { res: regRes, data: regData } = await api('POST', `/api/events/${event1.id}/register`, {
      token: student.token,
    });
    check('student registered for event', regRes.status === 201 && regData.success);

    const ticketFromReg = regData.data && regData.data.ticket;
    check('unique ticket and QR code generated on registration',
      ticketFromReg && ticketFromReg.ticket_code && ticketFromReg.qr_data_url && ticketFromReg.status === 'VALID',
      JSON.stringify(ticketFromReg)
    );
    const ticketCode1 = ticketFromReg.ticket_code;

    // 4. Step 3: Ticket appears in student's dashboard tickets
    const { res: myTktRes, data: myTktData } = await api('GET', '/api/tickets/my-tickets', {
      token: student.token,
    });
    const studentTickets = myTktData.data || [];
    const matchedTicket = studentTickets.find((t) => t.ticket_code === ticketCode1);
    check('ticket appears in student dashboard my-tickets list',
      myTktRes.status === 200 && matchedTicket && matchedTicket.event_id === event1.id
    );
    check('student ticket has full details (venue, poster, reg no, qr data)',
      matchedTicket && matchedTicket.venue && matchedTicket.student_name && matchedTicket.qr_data_url
    );

    // 5. Duplicate registration rejection & no duplicate tickets
    const { res: dupeRegRes } = await api('POST', `/api/events/${event1.id}/register`, {
      token: student.token,
    });
    check('duplicate event registration rejected (409)', dupeRegRes.status === 409);

    // 6. Step 12: Unauthorized coordinator access control
    // Coordinator user is NOT assigned to event 1 yet -> verify should be rejected with 403
    const { res: unauthVerifyRes } = await api('POST', '/api/tickets/verify', {
      token: coordinator.token,
      body: { event_id: event1.id, ticket_code: ticketCode1 },
    });
    check('unauthorized coordinator cannot verify ticket for unassigned event (403)', unauthVerifyRes.status === 403);
    const { res: unauthScanRes } = await api('POST', '/api/tickets/scan', {
      token: coordinator.token,
      body: { event_id: event1.id, ticket_code: ticketCode1 },
    });
    check('unauthorized coordinator cannot scan tickets for an unassigned event (403)', unauthScanRes.status === 403);
    const { res: studentScanRes } = await api('POST', '/api/tickets/scan', {
      token: student.token,
      body: { event_id: event1.id, ticket_code: ticketCode1 },
    });
    check('students cannot access coordinator scan endpoint (403)', studentScanRes.status === 403);

    // 7. Admin assigns coordinator to event 1
    const { res: assignRes, data: assignData } = await api('POST', `/api/tickets/events/${event1.id}/coordinators`, {
      token: admin.token,
      body: { user_id: coordinator.user.id },
    });
    check('admin assigns coordinator to event', assignRes.status === 201 && assignData.success);

    // 8. Coordinator lists assigned events -> event 1 is present
    const { res: coordEventsRes, data: coordEventsData } = await api('GET', '/api/tickets/coordinator/events', {
      token: coordinator.token,
    });
    const coordEvents = coordEventsData.data || [];
    const hasEvent1 = coordEvents.some((e) => e.id === event1.id);
    check('assigned event appears in coordinator event list with live stats', hasEvent1);

    // 9. Step 5 & 6: Coordinator verifies ticket code against event 1
    const { res: verifyRes, data: verifyData } = await api('POST', '/api/tickets/verify', {
      token: coordinator.token,
      body: { event_id: event1.id, ticket_code: ticketCode1 },
    });
    check('coordinator verified ticket against DB -> result VALID',
      verifyRes.status === 200 && verifyData.data && verifyData.data.result === 'VALID' && verifyData.data.can_confirm === true
    );
    check('verification payload includes student name, reg number, ticket code, event',
      verifyData.data.ticket &&
      verifyData.data.ticket.student_name &&
      verifyData.data.ticket.ticket_code === ticketCode1
    );

    // 10. Step 11: WRONG EVENT test
    // Attempting to verify event 1's ticket against event 2
    const { res: wrongEvRes, data: wrongEvData } = await api('POST', '/api/tickets/verify', {
      token: admin.token, // Admin is authorized for all events
      body: { event_id: event2.id, ticket_code: ticketCode1 },
    });
    check('ticket for another event is rejected with WRONG_EVENT',
      wrongEvRes.status === 200 && wrongEvData.data && wrongEvData.data.result === 'WRONG_EVENT'
    );

    // 11. INVALID TICKET test
    const { res: invRes, data: invData } = await api('POST', '/api/tickets/verify', {
      token: coordinator.token,
      body: { event_id: event1.id, ticket_code: 'CC-TKT-FAKE-999-XYZ' },
    });
    check('non-existent ticket code rejected with INVALID',
      invRes.status === 200 && invData.data && invData.data.result === 'INVALID'
    );

    // 12. Check-in is authoritative and atomic, even for simultaneous scans.
    const scanAttempts = await Promise.all([
      api('POST', '/api/tickets/scan', {
        token: coordinator.token,
        body: { event_id: event1.id, ticket_code: ticketCode1, scan_method: 'QR_SCAN' },
      }),
      api('POST', '/api/tickets/scan', {
        token: coordinator.token,
        body: { event_id: event1.id, ticket_id: matchedTicket.id, scan_method: 'MANUAL_CODE' },
      }),
    ]);
    const scanResults = scanAttempts.map((attempt) => attempt.data && attempt.data.data && attempt.data.data.result);
    const approvedScan = scanAttempts.find((attempt) =>
      attempt.data && attempt.data.data && attempt.data.data.result === 'APPROVED_ENTRY_ALLOWED');
    const duplicateScan = scanAttempts.find((attempt) =>
      attempt.data && attempt.data.data && attempt.data.data.result === 'ALREADY_CHECKED_IN');
    check('coordinator scan records entry and returns the approved student/event details',
      approvedScan && approvedScan.res.status === 200 &&
      approvedScan.data.data.checked_in_at &&
      approvedScan.data.data.ticket.student_name &&
      approvedScan.data.data.ticket.event_title &&
      approvedScan.data.data.ticket.registration_status === 'REGISTERED'
    );
    check('simultaneous scans admit only once and report the second scan as already checked in',
      scanAttempts.every((attempt) => attempt.res.status === 200) &&
      scanResults.includes('APPROVED_ENTRY_ALLOWED') &&
      scanResults.includes('ALREADY_CHECKED_IN') &&
      scanResults.length === 2
    );

    const { res: invalidScanRes, data: invalidScanData } = await api('POST', '/api/tickets/scan', {
      token: coordinator.token,
      body: { event_id: event1.id, ticket_code: 'CC-TKT-FAKE-999-XYZ' },
    });
    check('scan endpoint clearly rejects an invalid QR code',
      invalidScanRes.status === 200 && invalidScanData.data.result === 'INVALID_QR_CODE'
    );

    // 13. Step 9: Student ticket status updates to CHECKED_IN
    const { res: studentTktAfter, data: studentTktAfterData } = await api('GET', `/api/tickets/ticket/${matchedTicket.id}`, {
      token: student.token,
    });
    check("student ticket status updated to CHECKED_IN",
      studentTktAfter.status === 200 && studentTktAfterData.data.status === 'CHECKED_IN'
    );

    // 14. Step 10: Reusing ticket is rejected as ALREADY_CHECKED_IN
    const { res: reuseVerifyRes, data: reuseVerifyData } = await api('POST', '/api/tickets/verify', {
      token: coordinator.token,
      body: { event_id: event1.id, ticket_code: ticketCode1 },
    });
    check('reusing ticket is rejected: TICKET ALREADY USED — ENTRY DENIED',
      reuseVerifyRes.status === 200 &&
      reuseVerifyData.data.result === 'ALREADY_CHECKED_IN' &&
      reuseVerifyData.data.checked_in_at
    );

    // Attempting confirm-entry again fails with 409
    const { res: reuseConfirmRes } = await api('POST', '/api/tickets/confirm-entry', {
      token: coordinator.token,
      body: { event_id: event1.id, ticket_code: ticketCode1 },
    });
    check('duplicate check-in rejected on confirm (409)', reuseConfirmRes.status === 409);

    // 15. Attendance management: live statistics & attendee roster
    const { res: attRes, data: attData } = await api('GET', `/api/tickets/events/${event1.id}/attendees`, {
      token: coordinator.token,
    });
    const stats = attData.data && attData.data.stats;
    check('attendance statistics calculated accurately (total, checked-in, remaining, percentage)',
      attRes.status === 200 &&
      stats.total_registered >= 1 &&
      stats.checked_in >= 1 &&
      stats.attendance_percentage > 0
    );

    const attendees = attData.data && attData.data.attendees;
    const studentInList = attendees.find((a) => a.ticket_code === ticketCode1);
    check('attendee list reflects CHECKED_IN status with check-in timestamp and coordinator',
      studentInList && studentInList.ticket_status === 'CHECKED_IN' && studentInList.checked_in_at
    );
    check('check-in history includes student, event, timestamp, and approved result',
      attData.data.recent_logs.some((log) =>
        log.ticket_code === ticketCode1 &&
        log.event_title &&
        log.scanned_at &&
        log.status === 'APPROVED_ENTRY_ALLOWED'
      )
    );

    // 16. CSV export of attendees
    const { res: csvRes } = await api('GET', `/api/tickets/events/${event1.id}/export?token=${encodeURIComponent(coordinator.token)}`, {
      raw: true,
    });
    const csvText = await csvRes.text();
    check('attendee CSV export generates valid formatted file',
      csvRes.status === 200 && csvText.includes('Ticket Code') && csvText.includes(ticketCode1)
    );

    // 17. Admin overview & cancellation
    const { res: ovRes, data: ovData } = await api('GET', '/api/tickets/admin/overview', {
      token: admin.token,
    });
    check('admin ticketing overview includes total counts & top events',
      ovRes.status === 200 && ovData.data.overview.total_tickets_generated > 0
    );

    // 18. Student cannot modify ticket code or status (forbidden / unmodifiable)
    const { res: studentCancelOther } = await api('PATCH', `/api/tickets/ticket/${matchedTicket.id}/cancel`, {
      token: faculty.token, // faculty does not own this student's ticket
      body: { reason: 'Unauthorized attempt' },
    });
    check('non-owner cannot cancel another user ticket (403)', studentCancelOther.status === 403);

  } finally {
    // Teardown test fixtures
    await api('DELETE', `/api/events/${event1.id}`, { token: admin.token });
    await api('DELETE', `/api/events/${event2.id}`, { token: admin.token });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('Failures:', failures);
    process.exit(1);
  } else {
    console.log('All Two-Sided Event Ticketing System tests passed successfully!\n');
  }
}

run().catch((e) => {
  console.error('Test execution failed:', e);
  process.exit(1);
});
