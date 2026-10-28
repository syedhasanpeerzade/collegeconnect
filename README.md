# CollegeConnect

**One Platform for Your Campus** — a centralized college management platform for event discovery and registration, event organization and approval, club recruitment, complaint tracking, announcements, notifications, an achievements hall of fame, and admin analytics.

---

## Project overview

CollegeConnect replaces scattered notice boards, WhatsApp groups, and paper forms with one portal:

| Module | What it does |
| --- | --- |
| Events | Browse approved events, register with capacity + deadline enforcement, cancel, view "My Registrations" |
| Event requests | Students/organizers submit proposals; faculty/admin approve, reject, or request changes; every transition is logged |
| Permanent QR code | One college-wide QR code pointing at `/events` — never changes when events change, only when the app URL does |
| Clubs | Browse clubs, view details, apply with custom coordinator-defined questions, track applications and memberships |
| Complaints | Full lifecycle SUBMITTED → UNDER REVIEW → ASSIGNED → IN PROGRESS → RESOLVED → CLOSED with history, feedback, reopen |
| Announcements | Admin/faculty publish categorized notices with expiry and audience targeting |
| Notifications | In-app notification feed with unread counts for every workflow event |
| Achievements | Verified hall of fame by year/category, linked to events/clubs, previous-winners on event pages |
| Admin | User management, statistics, charts, CSV reports |

## Technology stack

- **Frontend:** HTML5, CSS3, vanilla JavaScript (Fetch API), responsive layout — no frameworks
- **Backend:** Node.js, Express.js, REST APIs, MVC-style structure with a service layer
- **Database:** PostgreSQL (hosted on Supabase), accessed through `pg` with a thin mysql2-style adapter (`server/config/db.js`) that keeps the service SQL simple; transactions, foreign keys, unique constraints, indexes
- **Packages:** express, pg, bcryptjs, jsonwebtoken, multer, cors, dotenv, qrcode, jsqr, express-validator, helmet, morgan

> **Note on the database:** the original specification called for MySQL. MySQL was unavailable in the target environment, so the data layer was ported to PostgreSQL hosted on Supabase. Application SQL remains simple and readable; MySQL-only expressions (CURDATE, GROUP_CONCAT, DATE_FORMAT, etc.) are translated centrally in `server/config/db.js`. All schema constraints (PKs, FKs, UNIQUE, CHECK, indexes) have Postgres equivalents.

## Architecture

```
client/            static frontend (HTML/CSS/JS), role-specific folders
server/
  server.js        Express app, helmet, cors, static serving, route wiring
  config/db.js     pg pool + SQL adapter (placeholders, functions, insertId)
  routes/          REST route definitions + express-validator rules
  controllers/     request/response handling
  services/        business logic (auth, events, clubs, complaints, ...)
  middleware/      JWT auth, role authorization, multer uploads, error handler
  utils/           ApiError, response helpers, public-ID generators, notify
  uploads/         uploaded files (posters, proposals, complaints, media)
database/
  schema.sql       PostgreSQL schema (tables, keys, constraints, indexes)
  seed.sql         demo data (clearly labeled demo achievements/winners)
  init.js          applies schema/seed over the Supabase connection
```

Roles: `STUDENT`, `ORGANIZER`, `CLUB_COORDINATOR`, `FACULTY`, `ADMIN` — JWT authentication with role middleware on every protected route.

## Database structure

18 tables: `departments, users, clubs, club_coordinators, events, event_requests, event_request_history, event_registrations, club_members, club_applications, club_custom_questions, club_application_answers, complaints, complaint_updates, announcements, achievements, achievement_winners, achievement_media, notifications`.

Duplicate prevention is enforced **at the database level** (`UNIQUE(event_id, student_id)` on registrations, `UNIQUE(club_id, student_id)` on applications/memberships) **and** in backend transaction logic (row locks + capacity checks).

## Installation

Requirements: Node.js 18+, a Supabase project (or any PostgreSQL 13+).

```bash
# 1. install dependencies
npm install

# 2. configure environment
cp .env.example .env
#   - DATABASE_URL: Supabase -> Project Settings -> Database -> Connection string (URI)
#   - JWT_SECRET:   any long random string
#   - APP_URL:      public base URL; the QR code points to APP_URL/events

# 3. create schema and load demo data
npm run db:init:seed

# 4. run
npm start          # http://localhost:3000
```

Useful scripts: `npm run db:init` (schema only), `npm run db:seed` (data only), `npm run db:init:seed` (schema + demo data), `npm test` (API smoke tests; requires the server to be running or spins it up itself).

> ⚠️ `npm run db:init` **drops and recreates all tables** — any existing data is erased. If you run it by mistake, `npm run db:init:seed` restores the demo data. If the port is busy on `npm start`, another server instance is already running (stop it, or set a different `PORT` in `.env`).

## Demo accounts

Password for every demo account: **Password@123**

| Role | Email |
| --- | --- |
| Admin | admin@collegeconnect.com / admin2@collegeconnect.com |
| Faculty | faculty@collegeconnect.com / faculty2@collegeconnect.com |
| Organizer | organizer@collegeconnect.com / organizer2@… / organizer3@… |
| Club coordinator | coordinator@collegeconnect.com / coordinator2@collegeconnect.com |
| Student | student@collegeconnect.com / meera@… / rohan@… / +7 more |

All seeded achievements, winners, and competition results are **demo data** and do not represent real college results.

## API documentation

All responses follow `{ "success": true/false, "message": "...", "data": ... }`. Authenticated calls send `Authorization: Bearer <token>`.

### Auth
```
POST   /api/auth/register        student self-registration
POST   /api/auth/login           returns JWT + role-based redirect target
POST   /api/auth/logout          client-side token discard (stateless JWT)
GET    /api/auth/me              current user profile
GET    /api/auth/departments     public list for the register form
POST   /api/auth/forgot-password issues a short-lived reset token
POST   /api/auth/reset-password  completes the reset with the token
POST   /api/auth/change-password authenticated password change
```

### Events & registration
```
GET    /api/events                        search/category/date/sort/pagination (public)
GET    /api/events/categories             8 discovery groups + live upcoming counts (public)
GET    /api/events/recommended            "Recommended For You" (student interests; auth)
GET    /api/events/:id                    full details + registration state + previous winners
POST   /api/events/:id/register           transactional registration (capacity + duplicate safe)
DELETE /api/events/:id/register           cancel registration
GET    /api/events/:id/registrations      organizer/faculty/admin view
GET    /api/my-registrations              the student's registrations
```

### Event coordinator check-in
```
GET    /api/tickets/coordinator/events                 assigned events and live attendance
POST   /api/tickets/scan                               authoritative validation + atomic check-in
GET    /api/tickets/events/:eventId/attendees          searchable roster, attendance, and scan history
GET    /api/tickets/events/:eventId/export             authorized attendee CSV
```
The coordinator dashboard is `/coordinator/event-checkin.html`. It scans the existing student ticket QR,
or accepts a ticket code/ID manually. A scan is validated and recorded in one server transaction; in the
existing registration workflow, `REGISTERED` is the approved state, and only it with a `VALID` ticket is
admitted. Pending, rejected, cancelled,
expired, wrong-event, and already-used passes are denied. Ticket and registration records are locked
before the check-in update, so concurrent scans cannot admit the same pass twice. Coordinator access is
restricted to assigned/owned events (or administrators), and the student registration flow is unchanged.
Camera scanning requires HTTPS (except localhost); online access is required for every authoritative
validation and check-in.

Events discovery: `/events.html` opens an Events Categories page (8 clickable cards with
live upcoming counts: Sports, Coding & Tech, College Clubs, Cultural, Academic,
Career & Placement, Arts & Creativity, Other). Selecting a category filters events via
`?category=<GROUP>` (groups map to one or more DB categories, e.g. Coding & Tech →
TECHNICAL/WORKSHOP/COMPETITION). The list view offers All | Upcoming | This Week |
Registered filter pills and a name search. Category values accepted by `GET /api/events`
are DB categories (TECHNICAL, CULTURAL, SPORTS, WORKSHOP, SEMINAR, COMPETITION, FEST,
CLUB_EVENT, CAREER, ARTS, OTHER) or group keys (SPORTS, TECH, CLUB_EVENT, CULTURAL,
ACADEMIC, CAREER, ARTS, OTHER). Optional demo data for the discovery flow:
`npm run db:seed:events` (idempotent sample events, safe to re-run).

### Notifications
```
GET    /api/notifications                 feed, priority (interest-matched) items first
GET    /api/notifications/unread-count    { count, priority }
PUT    /api/notifications/read-all        mark everything read
PUT    /api/notifications/:id/read        mark one read
```

### Personalized interests (priority notifications)
```
GET    /api/interests/options             10 selectable interest cards (public)
GET    /api/interests/status              { role, interests_configured, interests[] }
PUT    /api/interests                     save { interests: [...], skip? }
```

First student login opens `onboarding.html` ("What are you interested in?"); skippable,
editable later from Profile -> My Interests. Interests map to event categories; when an
event is created (directly or via request approval), students whose interests match get a
**priority notification** (`notifications.priority = 1`, rendered with a red dot and PRIORITY
badge, sorted first) containing the event title, category emoji, date and venue plus
View Event / Register Now actions. Fan-out is deduped by `UNIQUE (recipient_id, dedupe_key)`
so re-runs never spam. Matching upcoming events also power the dashboard's
"Recommended For You" section. Migration: `node database/migrate-interests.js`
(idempotent; also runs automatically on server boot).

### Event requests (approval workflow)
```
POST   /api/event-requests                        submit proposal (REQ-YYYY-NNNN)
GET    /api/event-requests                        mine (organizer) or queue (faculty/admin)
GET    /api/event-requests/:id                    details + history
PUT    /api/event-requests/:id/resubmit           after CHANGES_REQUESTED
PUT    /api/event-requests/:id/approve            faculty/admin -> creates + publishes event
PUT    /api/event-requests/:id/reject             with remarks
PUT    /api/event-requests/:id/request-changes    with remarks
```

### Clubs & applications
```
GET    /api/clubs                         browse active clubs (public)
GET    /api/clubs/:id                     details, members, events, questions (public)
POST   /api/clubs/:id/apply               apply with answers to custom questions
GET    /api/clubs/:id/applications        coordinator view
PUT    /api/club-applications/:id/approve creates membership + notification
PUT    /api/club-applications/:id/reject  with reason
GET    /api/my-club-applications          student's applications and memberships
POST   /api/clubs/:id/questions           coordinator adds custom question
```

### Complaints
```
POST   /api/complaints                    submit (CC-CMP-YYYY-NNNN)
GET    /api/complaints                    mine / queue by role
GET    /api/complaints/:id                details + status history
PUT    /api/complaints/:id/status         faculty/admin transitions
POST   /api/complaints/:id/feedback       student confirms resolution + rating
```

### Announcements, notifications, achievements
```
GET/POST/PUT/DELETE /api/announcements    admin/faculty manage, expiry-aware listing
GET  /api/notifications                    feed; PUT /api/notifications/:id/read;
PUT  /api/notifications/read-all           unread count via GET /api/notifications/unread-count
GET  /api/achievements                     hall of fame (verified only for public)
GET  /api/achievements/:id                 detail + winners + media
POST/PUT/DELETE /api/achievements...       admin/faculty/coordinator management
PUT  /api/achievements/:id/verify|reject   verification workflow
GET  /api/achievements/year/:year          by-year listing
POST /api/achievements/:id/winners         add winners; DELETE .../winners/:wid
```

### Admin
```
GET    /api/admin/dashboard               statistics + chart datasets
GET    /api/admin/users                   search/filter users
PUT    /api/admin/users/:id/status        activate/deactivate
PUT    /api/admin/users/:id/role          change role
POST   /api/admin/staff                   provision staff accounts
GET    /api/admin/departments             reference list
GET    /api/admin/reports/:key            CSV exports (registrations, clubs, complaints,
                                          event-requests, departments, event-categories,
                                          achievements, previous-winners)
```

### Latest event results (Achievements page)
```
GET    /api/latest-results                featured latest completed event + winners (public)
```
The Achievements page shows a search bar, then a featured "🏆 LATEST ACHIEVEMENT" card for the
most recently verified completed event (1st/2nd/3rd with team/member names, department/club,
and View Full Results), followed by Previous Achievements in an Instagram Explore-style grid.
The featured event is chosen dynamically: the verified result record with the newest
`verified_at` whose linked event is in the past — as new events complete and results are
verified, the section updates automatically. Demo data: `npm run db:seed:results` (idempotent).

### QR code
```
GET /api/qr/event-page     PNG of the one permanent QR code (points to APP_URL/events)
GET /api/qr/event-page-meta JSON with the destination URL
```

The QR code encodes **only** the events page URL (`APP_URL/events`) — never a specific event. Scanning shows all approved events, so the printed code works all year. Regenerate automatically when `APP_URL` changes; download or print it from **Admin → College Event QR Code**.

## Security notes

- bcryptjs password hashing (10 rounds); JWT (7 day expiry) with `authenticate` and `authorize(...roles)` middleware
- express-validator on all write endpoints; parameterized SQL everywhere
- helmet security headers; CORS restricted by `CORS_ORIGIN`; 1 MB body limit
- Coordinator check-in validates assignments and database state on the server; Supabase `anon` and
  `authenticated` roles are denied direct access to registration, ticket, assignment, and check-in tables
  by the idempotent ticketing migration. Browser check-in always goes through the authenticated API.
- Multer uploads: MIME + extension allow-list, 5 MB cap, random safe filenames, files served as static attachments with script types neutralized
- No password hashes, secrets, or stack traces in responses

**Storage limitation:** uploads live on the server disk (`server/uploads/`). For production, move to object storage (S3/Supabase Storage) and store only URLs in the database.

## Achievements module

Achievements carry a verification workflow (`SUBMITTED → PENDING_VERIFICATION → VERIFIED/REJECTED`); only verified, non-archived records appear publicly. Winners support both individuals (optionally linked user accounts) and teams, with department, position, and year. Recurring competitions link achievements to events, powering the 🏆 Previous Winners section and "defend the title" view on event pages. Faculty verify; admin manages and archives.

## Folder structure

See [Architecture](#architecture). Role-specific pages live under `client/organizer|coordinator|faculty|admin/`; shared UI primitives in `client/css/styles.css`, `client/js/api.js`, `client/js/ui.js`.

## Future improvements

- Email delivery for password resets and notifications
- Object storage for uploads
- Refresh tokens + token revocation list
- WebSocket/push notifications
- Event waitlists and team-based registration
- Automated end-to-end browser tests
