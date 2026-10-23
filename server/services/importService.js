'use strict';
/**
 * Bulk historical import.
 *
 * Parses an admin-uploaded CSV into previewable rows, validates every field
 * against the REAL table constraints, detects duplicates, and only then
 * inserts the rows the admin selected into the existing tables:
 *
 *   EVENTS / WORKSHOPS / FESTS -> events       (distinguished by `category`)
 *   ANNOUNCEMENTS              -> announcements
 *   ACHIEVEMENTS               -> achievements (+ achievement_winners)
 *
 * Nothing is invented: a blank cell stays NULL, and an ambiguous or malformed
 * date is rejected with a message instead of being guessed. Times that the
 * schema requires but the CSV omits fall back to a default AND are reported
 * per row as a note, so the admin sees the assumption before importing.
 */
const db = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { nextPublicId } = require('../utils/helpers');

// ---------------------------------------------------------------------------
// Allowed values - these mirror the CHECK constraints in database/schema.sql
// ---------------------------------------------------------------------------
const EVENT_CATEGORIES = ['TECHNICAL', 'CULTURAL', 'SPORTS', 'WORKSHOP', 'SEMINAR', 'COMPETITION', 'FEST', 'CLUB_EVENT', 'CAREER', 'ARTS', 'OTHER'];
const ANNOUNCEMENT_CATEGORIES = ['GENERAL', 'EVENT', 'CLUB', 'ACADEMIC', 'URGENT'];
const ANNOUNCEMENT_AUDIENCES = ['ALL', 'STUDENTS', 'FACULTY', 'STAFF'];
const ACHIEVEMENT_CATEGORIES = ['TECHNICAL', 'SPORTS', 'CULTURAL', 'ACADEMIC', 'HACKATHON', 'INNOVATION', 'RESEARCH', 'LEADERSHIP', 'SOCIAL_SERVICE', 'OTHER'];
const ACHIEVEMENT_POSITIONS = ['1ST_PLACE', '2ND_PLACE', '3RD_PLACE', 'WINNER', 'RUNNER_UP', 'FINALIST', 'PARTICIPATION', 'OTHER'];
const ORGANIZER_KINDS = ['college', 'club', 'student'];

const DEFAULT_START_TIME = '09:00:00';
const DEFAULT_END_TIME = '17:00:00';
const MAX_ROWS = 2000;

// ---------------------------------------------------------------------------
// CSV parsing (RFC 4180: quoted fields, embedded commas/newlines, ""-escapes)
// ---------------------------------------------------------------------------
function detectDelimiter(text) {
  const firstLine = String(text).split(/\r?\n/).find((l) => l.trim()) || '';
  const counts = [
    [',', (firstLine.match(/,/g) || []).length],
    [';', (firstLine.match(/;/g) || []).length],
    ['\t', (firstLine.match(/\t/g) || []).length],
  ].sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

/** Parse CSV text into a matrix of cell strings. */
function parseCsv(text) {
  const src = String(text).replace(/^\uFEFF/, ''); // strip Excel BOM
  const delimiter = detectDelimiter(src);
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else { inQuotes = false; }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delimiter) { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  row.push(cell);
  rows.push(row);

  // Drop a trailing all-empty record produced by a final newline.
  return rows.filter((r, idx) => idx === 0 || r.some((c) => String(c).trim() !== ''));
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",;\n\r\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(columns, rows) {
  const head = columns.join(',');
  const body = rows.map((r) => r.map(csvEscape).join(','));
  return [head, ...body].join('\r\n');
}

// ---------------------------------------------------------------------------
// Field coercion / validation
// ---------------------------------------------------------------------------
function calendarOk(y, m, d) {
  if (!(y >= 1900 && y <= 2200)) return false;
  if (!(m >= 1 && m <= 12)) return false;
  if (!(d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Strict date parsing. Accepts ISO (YYYY-MM-DD) and unambiguous DD-MM-YYYY.
 * Refuses to guess: DD/MM where both parts are <= 12 is reported as ambiguous.
 */
function parseDateValue(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return { ok: false, error: 'Date is required' };

  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(v);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (!calendarOk(y, mo, d)) return { ok: false, error: `"${v}" is not a real calendar date` };
    return { ok: true, value: `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
  }

  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(v);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3];
    if (a <= 12 && b <= 12) {
      return { ok: false, error: `Ambiguous date "${v}" (could be ${a}/${b} or ${b}/${a}) - please write it as YYYY-MM-DD` };
    }
    if (b > 12) return { ok: false, error: `Date "${v}" looks like MM/DD/YYYY - please write it as YYYY-MM-DD` };
    if (!calendarOk(y, b, a)) return { ok: false, error: `"${v}" is not a real calendar date` };
    return { ok: true, value: `${String(y).padStart(4, '0')}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}` };
  }

  return { ok: false, error: `Date "${v}" is not understood - use YYYY-MM-DD` };
}

/** Date + optional time (used for announcements.published_at). */
function parseDateTimeValue(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return { ok: false, error: 'Publication date is required' };
  const parts = v.split(/[ T]/);
  const d = parseDateValue(parts[0]);
  if (!d.ok) return d;
  if (parts.length === 1) return { ok: true, value: `${d.value} 00:00:00` };
  const t = parseTimeValue(parts[1]);
  if (!t.ok) return t;
  return { ok: true, value: `${d.value} ${t.value}` };
}

function parseTimeValue(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return { ok: true, value: null };
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (!m) return { ok: false, error: `Time "${v}" is not understood - use HH:MM (24-hour)` };
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return { ok: false, error: `Time "${v}" is out of range` };
  return { ok: true, value: `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00` };
}

function isHttpUrl(v) {
  return /^https?:\/\/\S+$/i.test(String(v || '').trim());
}

function validateMediaRef(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return { ok: true, value: null };
  if (isHttpUrl(v) || /^\/uploads\/[\w./-]+$/i.test(v)) return { ok: true, value: v };
  return { ok: false, error: `Media reference "${v}" must be an http(s) URL or a /uploads/... path` };
}

function validateSourceUrl(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return { ok: true, value: null };
  if (isHttpUrl(v)) return { ok: true, value: v };
  return { ok: false, error: `Source URL "${v}" must start with http:// or https://` };
}

function validateAcademicYear(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return { ok: true, value: null };
  if (/^\d{4}(-\d{2,4})?$/.test(v)) return { ok: true, value: v };
  return { ok: false, error: `Academic year "${v}" should look like 2023-24 or 2023` };
}

function requiredText(raw, label, maxLen) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return { ok: false, error: `${label} is required` };
  if (maxLen && v.length > maxLen) return { ok: false, error: `${label} is longer than ${maxLen} characters` };
  return { ok: true, value: v };
}

function optionalText(raw, maxLen) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return { ok: true, value: null };
  if (maxLen && v.length > maxLen) return { ok: false, error: `Value is longer than ${maxLen} characters` };
  return { ok: true, value: v };
}

function enumValue(raw, allowed, label, { required = true, fallback = null } = {}) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) {
    if (required) return { ok: false, error: `${label} is required` };
    return { ok: true, value: fallback };
  }
  const up = v.toUpperCase().replace(/[\s-]+/g, '_');
  if (!allowed.includes(up)) {
    return { ok: false, error: `${label} "${v}" is not allowed. Use one of: ${allowed.join(', ')}` };
  }
  return { ok: true, value: up };
}

function intValue(raw, label, { min = null, max = null, fallback = null, required = false } = {}) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) {
    if (required) return { ok: false, error: `${label} is required` };
    return { ok: true, value: fallback };
  }
  const n = Number(v);
  if (!Number.isInteger(n)) return { ok: false, error: `${label} "${v}" must be a whole number` };
  if (min != null && n < min) return { ok: false, error: `${label} must be ${min} or more` };
  if (max != null && n > max) return { ok: false, error: `${label} must be ${max} or less` };
  return { ok: true, value: n };
}

// ---------------------------------------------------------------------------
// Record-type specs: the column contract for each CSV template
// ---------------------------------------------------------------------------
const EVENT_COLUMNS = [
  { key: 'title', label: 'Title', required: true, example: 'Annual Science Exhibition 2023' },
  { key: 'category', label: 'Category', required: true, example: 'TECHNICAL' },
  { key: 'event_date', label: 'Event Date', required: true, example: '2023-02-18' },
  { key: 'description', label: 'Description', required: true, example: 'Exhibition of student science projects.' },
  { key: 'venue', label: 'Venue', required: true, example: 'Main Auditorium' },
  { key: 'start_time', label: 'Start Time', required: false, example: '09:30' },
  { key: 'end_time', label: 'End Time', required: false, example: '16:00' },
  { key: 'max_participants', label: 'Max Participants', required: false, example: '150' },
  { key: 'organizer_kind', label: 'Organizer Kind', required: false, example: 'college' },
  { key: 'academic_year', label: 'Academic Year', required: false, example: '2022-23' },
  { key: 'source_url', label: 'Source URL', required: false, example: 'https://college.edu/archive/science-2023' },
  { key: 'media_url', label: 'Media / Image URL', required: false, example: 'https://college.edu/img/science-2023.jpg' },
  { key: 'department_code', label: 'Department Code', required: false, example: 'CSE' },
];

const ANNOUNCEMENT_COLUMNS = [
  { key: 'title', label: 'Title', required: true, example: 'Semester Results Published' },
  { key: 'description', label: 'Description', required: true, example: 'Results for the 2023 even semester are now available.' },
  { key: 'category', label: 'Category', required: true, example: 'ACADEMIC' },
  { key: 'published_at', label: 'Published At', required: true, example: '2023-06-12' },
  { key: 'audience', label: 'Audience', required: false, example: 'ALL' },
  { key: 'expiry_date', label: 'Expiry Date', required: false, example: '' },
  { key: 'academic_year', label: 'Academic Year', required: false, example: '2022-23' },
  { key: 'source_url', label: 'Source URL', required: false, example: 'https://college.edu/notices/results' },
  { key: 'media_url', label: 'Attachment URL', required: false, example: '' },
];

const ACHIEVEMENT_COLUMNS = [
  { key: 'title', label: 'Title', required: true, example: '1st Place - State Robotics Challenge' },
  { key: 'competition_name', label: 'Competition Name', required: true, example: 'State Robotics Challenge 2023' },
  { key: 'category', label: 'Category', required: true, example: 'TECHNICAL' },
  { key: 'position', label: 'Position', required: true, example: '1ST_PLACE' },
  { key: 'achievement_year', label: 'Achievement Year', required: true, example: '2023' },
  { key: 'event_date', label: 'Event Date', required: false, example: '2023-03-04' },
  { key: 'description', label: 'Description', required: false, example: 'Team built an autonomous line-following robot.' },
  { key: 'winner_name', label: 'Winner Name / Team', required: false, example: 'Ayesha Khan' },
  { key: 'academic_year', label: 'Academic Year', required: false, example: '2022-23' },
  { key: 'source_url', label: 'Source URL', required: false, example: 'https://college.edu/archive/robotics-2023' },
  { key: 'department_code', label: 'Department Code', required: false, example: 'CSE' },
];

const TYPE_SPECS = {
  EVENTS: {
    label: 'Historical college events',
    columns: EVENT_COLUMNS,
    defaultCategory: null,
    categoryWhitelist: EVENT_CATEGORIES,
    duplicateLabel: 'an event with the same title and date already exists',
  },
  WORKSHOPS: {
    label: 'Workshops and seminars',
    columns: EVENT_COLUMNS,
    defaultCategory: 'WORKSHOP',
    categoryWhitelist: ['WORKSHOP', 'SEMINAR'],
    duplicateLabel: 'a workshop/seminar with the same title and date already exists',
  },
  FESTS: {
    label: 'College fests and celebrations',
    columns: EVENT_COLUMNS,
    defaultCategory: 'FEST',
    categoryWhitelist: ['FEST', 'CULTURAL'],
    duplicateLabel: 'a fest with the same title and date already exists',
  },
  ANNOUNCEMENTS: {
    label: 'College announcements',
    columns: ANNOUNCEMENT_COLUMNS,
    duplicateLabel: 'an announcement with the same title and published date already exists',
  },
  ACHIEVEMENTS: {
    label: 'Student and college achievements',
    columns: ACHIEVEMENT_COLUMNS,
    duplicateLabel: 'an achievement with the same title, competition and year already exists',
  },
};

function specFor(type) {
  const key = String(type || '').trim().toUpperCase();
  const spec = TYPE_SPECS[key];
  if (!spec) {
    throw new ApiError(400, `Unknown import type "${type}". Use one of: ${Object.keys(TYPE_SPECS).join(', ')}`);
  }
  return { key, spec };
}

function listTypes() {
  return Object.entries(TYPE_SPECS).map(([key, spec]) => ({
    key,
    label: spec.label,
    columns: spec.columns.map((c) => ({ key: c.key, label: c.label, required: !!c.required, example: c.example || '' })),
  }));
}

// ---------------------------------------------------------------------------
// Header mapping
// ---------------------------------------------------------------------------
function normaliseHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Build a header -> column-key map so "Event Date", "event_date" and "DATE" all work. */
function mapHeaders(spec, headerRow) {
  const lookup = new Map();
  spec.columns.forEach((c) => {
    lookup.set(normaliseHeader(c.key), c.key);
    lookup.set(normaliseHeader(c.label), c.key);
  });
  // A few friendly aliases the templates do not spell out.
  const aliases = {
    date: 'event_date', eventdate: 'event_date', publicationdate: 'published_at',
    publisheddate: 'published_at', sourceurl: 'source_url', source: 'source_url',
    year: 'achievement_year', image: 'media_url', imageurl: 'media_url',
    media: 'media_url', url: 'source_url', winner: 'winner_name', team: 'winner_name',
    organizer: 'organizer_kind', dept: 'department_code', department: 'department_code',
    competition: 'competition_name', positionplace: 'position', maxseats: 'max_participants',
  };
  Object.entries(aliases).forEach(([a, key]) => lookup.set(a, key));

  const mapping = headerRow.map((h) => lookup.get(normaliseHeader(h)) || null);
  const mapped = new Set(mapping.filter(Boolean));
  const missing = spec.columns.filter((c) => c.required && !mapped.has(c.key)).map((c) => c.label);
  return { mapping, missing };
}

// ---------------------------------------------------------------------------
// Row validation
// ---------------------------------------------------------------------------
/**
 * Validate one raw CSV row. `ctx` carries resolved lookups (departments, clubs)
 * so we do not hit the database per cell.
 * @returns { errors: string[], notes: string[], data: object }
 */
function validateRow(type, raw, ctx) {
  const errors = [];
  const notes = [];
  const data = {};
  const take = (res, field) => {
    if (res.ok) data[field] = res.value;
    else if (res.error) errors.push(res.error);
  };

  if (type === 'ANNOUNCEMENTS') {
    take(requiredText(raw.title, 'Title', 200), 'title');
    take(requiredText(raw.description, 'Description'), 'description');
    take(enumValue(raw.category, ANNOUNCEMENT_CATEGORIES, 'Category'), 'category');
    take(parseDateTimeValue(raw.published_at), 'published_at');
    take(enumValue(raw.audience, ANNOUNCEMENT_AUDIENCES, 'Audience', { required: false, fallback: 'ALL' }), 'audience');
    const exp = String(raw.expiry_date || '').trim();
    if (exp) take(parseDateValue(exp), 'expiry_date');
    else data.expiry_date = null;
    take(validateSourceUrl(raw.source_url), 'source_url');
    take(validateAcademicYear(raw.academic_year), 'academic_year');
    take(validateMediaRef(raw.media_url), 'attachment_path');
    if (!exp) notes.push('No expiry date - this announcement will stay visible in the archive.');
    return { errors, notes, data };
  }

  if (type === 'ACHIEVEMENTS') {
    take(requiredText(raw.title, 'Title', 200), 'title');
    take(requiredText(raw.competition_name, 'Competition name', 200), 'competition_name');
    take(enumValue(raw.category, ACHIEVEMENT_CATEGORIES, 'Category'), 'category');
    take(enumValue(raw.position, ACHIEVEMENT_POSITIONS, 'Position'), 'position');
    take(intValue(raw.achievement_year, 'Achievement year', { min: 1990, max: 2100, required: true }), 'achievement_year');
    const ed = String(raw.event_date || '').trim();
    if (ed) take(parseDateValue(ed), 'event_date');
    else data.event_date = null;
    take(optionalText(raw.description), 'description');
    take(validateSourceUrl(raw.source_url), 'source_url');
    take(validateAcademicYear(raw.academic_year), 'academic_year');
    data.winner_name = String(raw.winner_name || '').trim() || null;
    if (String(raw.department_code || '').trim()) {
      const code = String(raw.department_code).trim().toUpperCase();
      const id = ctx.departments.get(code);
      if (id) data.department_id = id;
      else errors.push(`Department code "${code}" does not exist`);
    }
    return { errors, notes, data };
  }

  // EVENTS / WORKSHOPS / FESTS -> events
  const spec = TYPE_SPECS[type];
  take(requiredText(raw.title, 'Title', 160), 'title');
  take(requiredText(raw.description, 'Description'), 'description');
  take(requiredText(raw.venue, 'Venue', 160), 'venue');
  take(parseDateValue(raw.event_date), 'event_date');

  const rawCat = String(raw.category || '').trim();
  if (!rawCat && spec.defaultCategory) {
    data.category = spec.defaultCategory;
    notes.push(`No category given - defaulted to ${spec.defaultCategory} for a ${spec.label.toLowerCase()} import.`);
  } else if (!rawCat) {
    errors.push('Category is required');
  } else {
    const up = rawCat.toUpperCase().replace(/[\s-]+/g, '_');
    if (!spec.categoryWhitelist.includes(up)) {
      errors.push(`Category "${rawCat}" is not allowed for this import type. Use one of: ${spec.categoryWhitelist.join(', ')}`);
    } else {
      data.category = up;
    }
  }

  const st = parseTimeValue(raw.start_time);
  const et = parseTimeValue(raw.end_time);
  if (!st.ok) errors.push(st.error);
  if (!et.ok) errors.push(et.error);
  if (st.ok && et.ok) {
    data.start_time = st.value || DEFAULT_START_TIME;
    data.end_time = et.value || DEFAULT_END_TIME;
    if (!st.value) notes.push(`No start time given - ${DEFAULT_START_TIME.slice(0, 5)} used (schema requires a time).`);
    if (!et.value) notes.push(`No end time given - ${DEFAULT_END_TIME.slice(0, 5)} used (schema requires a time).`);
    if (data.start_time >= data.end_time) errors.push('End time must be after the start time');
  }
  take(intValue(raw.max_participants, 'Max participants', { min: 1, max: 100000, fallback: 100 }), 'max_participants');
  take(enumValue(raw.organizer_kind, ORGANIZER_KINDS, 'Organizer kind', { required: false, fallback: 'college' }), 'organizer_kind');
  take(validateSourceUrl(raw.source_url), 'source_url');
  take(validateAcademicYear(raw.academic_year), 'academic_year');
  take(validateMediaRef(raw.media_url), 'poster_path');
  if (String(raw.department_code || '').trim()) {
    const code = String(raw.department_code).trim().toUpperCase();
    const id = ctx.departments.get(code);
    if (id) data.department_id = id;
    else errors.push(`Department code "${code}" does not exist`);
  }
  return { errors, notes, data };
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------
function dupKey(type, data) {
  if (!data.title) return null;
  if (type === 'ANNOUNCEMENTS') {
    return `${data.title.toLowerCase()}|${String(data.published_at || '').slice(0, 10)}`;
  }
  if (type === 'ACHIEVEMENTS') {
    return `${data.title.toLowerCase()}|${String(data.competition_name || '').toLowerCase()}|${data.achievement_year}`;
  }
  return `${data.title.toLowerCase()}|${data.event_date}`;
}

/** Existing rows already in the database keyed the same way. */
async function loadExistingKeys(type, dataList) {
  const keys = new Set();
  const rows = dataList.filter(Boolean);

  if (type === 'ANNOUNCEMENTS') {
    for (const d of rows) {
      const [r] = await db.execute(
        'SELECT id FROM announcements WHERE lower(title) = lower(?) AND published_at::date = ?::date',
        [d.title, String(d.published_at).slice(0, 10)]
      );
      if (r.length) keys.add(dupKey(type, d));
    }
    return keys;
  }
  if (type === 'ACHIEVEMENTS') {
    for (const d of rows) {
      const [r] = await db.execute(
        'SELECT id FROM achievements WHERE lower(title) = lower(?) AND lower(competition_name) = lower(?) AND achievement_year = ?',
        [d.title, d.competition_name, d.achievement_year]
      );
      if (r.length) keys.add(dupKey(type, d));
    }
    return keys;
  }
  for (const d of rows) {
    const [r] = await db.execute(
      'SELECT id FROM events WHERE lower(title) = lower(?) AND event_date = ?::date',
      [d.title, d.event_date]
    );
    if (r.length) keys.add(dupKey(type, d));
  }
  return keys;
}

async function loadLookups() {
  const [depts] = await db.execute('SELECT id, code FROM departments');
  return {
    departments: new Map(depts.map((d) => [String(d.code).toUpperCase(), d.id])),
  };
}

// ---------------------------------------------------------------------------
// Preview: parse + validate + flag duplicates. Writes NOTHING.
// ---------------------------------------------------------------------------
async function analyseCsv({ type, text }) {
  const { key, spec } = specFor(type);
  const matrix = parseCsv(text);
  if (matrix.length < 2) throw new ApiError(400, 'The CSV needs a header row and at least one data row');
  if (matrix.length - 1 > MAX_ROWS) throw new ApiError(400, `This CSV has ${matrix.length - 1} rows; the limit is ${MAX_ROWS} per import`);

  const headerRow = matrix[0];
  const { mapping, missing } = mapHeaders(spec, headerRow);
  if (missing.length) throw new ApiError(400, `CSV is missing required column(s): ${missing.join(', ')}`);

  const ctx = await loadLookups();
  const preview = [];
  const seen = new Map(); // in-file duplicate detection

  matrix.slice(1).forEach((cells, idx) => {
    const raw = {};
    mapping.forEach((colKey, i) => { if (colKey) raw[colKey] = cells[i]; });

    const { errors, notes, data } = validateRow(key, raw, ctx);
    let status = errors.length ? 'invalid' : 'valid';

    if (status === 'valid') {
      const k = dupKey(key, data);
      if (k && seen.has(k)) {
        status = 'duplicate';
        notes.push(`Repeats row ${seen.get(k)} in this same file.`);
      } else if (k) {
        seen.set(k, idx + 2);
      }
    }

    preview.push({
      row_number: idx + 2, // 1-based, counted with the header
      status,
      errors,
      notes,
      values: raw,       // echoed back so the admin can fix and re-import
      parsed: status === 'valid' ? data : null,
    });
  });

  // Database-level duplicates (one query per valid row; imports are reviewed
  // in small batches, and this keeps the duplicate rule explicit).
  const validRows = preview.filter((p) => p.status === 'valid');
  if (validRows.length) {
    const existing = await loadExistingKeys(key, validRows.map((p) => p.parsed));
    preview.forEach((p) => {
      if (p.status !== 'valid') return;
      const k = dupKey(key, p.parsed);
      if (k && existing.has(k)) {
        p.status = 'duplicate';
        p.notes.push(spec.duplicateLabel);
      }
    });
  }

  return {
    type: key,
    label: spec.label,
    columns: spec.columns,
    rows: preview,
    summary: summarise(preview),
  };
}

function summarise(rows) {
  return {
    total: rows.length,
    valid: rows.filter((r) => r.status === 'valid').length,
    invalid: rows.filter((r) => r.status === 'invalid').length,
    duplicate: rows.filter((r) => r.status === 'duplicate').length,
  };
}

// ---------------------------------------------------------------------------
// Commit: re-validate server-side, then insert the selected valid rows.
// ---------------------------------------------------------------------------
async function commitImport(user, payload = {}) {
  const { key, spec } = specFor(payload.type);
  const incoming = Array.isArray(payload.rows) ? payload.rows : [];
  if (!incoming.length) throw new ApiError(400, 'No rows were submitted');
  if (incoming.length > MAX_ROWS) throw new ApiError(400, `Too many rows (${incoming.length}); the limit is ${MAX_ROWS}`);

  const ctx = await loadLookups();
  const filename = payload.filename ? String(payload.filename).slice(0, 255) : null;
  const batchSourceUrl = payload.sourceUrl ? String(payload.sourceUrl).slice(0, 500) : null;
  const batchAcademicYear = payload.academicYear ? String(payload.academicYear).slice(0, 12) : null;

  // The client never gets to decide what is valid: re-run the exact same rules.
  const prepared = [];
  const failed = [];
  const results = [];
  const seenInFile = new Map();

  incoming.forEach((row, i) => {
    const rowNumber = Number(row.row_number) || i + 2;
    if (row.selected === false) {
      results.push({ row_number: rowNumber, outcome: 'skipped', message: 'Not selected' });
      return;
    }
    const raw = row.values || {};
    const { errors, notes, data } = validateRow(key, raw, ctx);
    if (errors.length) {
      failed.push({ row_number: rowNumber, errors });
      results.push({ row_number: rowNumber, outcome: 'failed', message: errors.join(' ') });
      return;
    }
    const k = dupKey(key, data);
    if (k && seenInFile.has(k)) {
      failed.push({ row_number: rowNumber, errors: ['Duplicate inside this file'] });
      results.push({ row_number: rowNumber, outcome: 'duplicate', message: `Same record as row ${seenInFile.get(k)}` });
      return;
    }
    if (k) seenInFile.set(k, rowNumber);
    prepared.push({ rowNumber, data, notes });
  });

  const conn = await db.getConnection();
  const created = [];
  let skipped = results.filter((r) => r.outcome === 'skipped').length;
  let duplicates = results.filter((r) => r.outcome === 'duplicate').length;
  let batchId = null;
  let batchRef = null;

  try {
    await conn.beginTransaction();

    // Official records must be attributable to an official account so the
    // existing OFFICIAL badge logic picks them up unchanged.
    const [collegeRows] = await conn.execute(
      "SELECT id FROM users WHERE account_type = 'college' AND verified = 1 ORDER BY id LIMIT 1"
    );
    const collegeId = collegeRows.length ? collegeRows[0].id : null;
    const organizerFor = (kind) => (kind === 'college' && collegeId ? collegeId : user.id);

    // Ledger row first, so every imported record can point at its batch.
    const [seq] = await conn.execute('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM import_batches');
    batchRef = `IMP-${new Date().getFullYear()}-${String(seq[0].n).padStart(4, '0')}`;
    const [batchIns] = await conn.execute(
      `INSERT INTO import_batches
         (batch_ref, record_type, source_filename, source_url, academic_year, total_rows, imported_by, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [batchRef, key, filename, batchSourceUrl, batchAcademicYear, incoming.length, user.id, null]
    );
    batchId = batchIns.insertId;

    for (const item of prepared) {
      const d = item.data;

      // Duplicate check again, inside the transaction: another admin may have
      // imported the same record between preview and commit.
      const existing = await loadExistingKeys(key, [d]);
      if (existing.size) {
        duplicates += 1;
        results.push({ row_number: item.rowNumber, outcome: 'duplicate', message: spec.duplicateLabel });
        continue;
      }

      if (key === 'ANNOUNCEMENTS') {
        const [ins] = await conn.execute(
          `INSERT INTO announcements
             (title, description, category, audience, published_at, expiry_date, attachment_path,
              created_by, source_url, academic_year, is_historical, import_batch_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          [d.title, d.description, d.category, d.audience, d.published_at, d.expiry_date,
           d.attachment_path, organizerFor('college'), d.source_url, d.academic_year, batchId]
        );
        created.push({ type: 'ANNOUNCEMENTS', id: ins.insertId, title: d.title });
      } else if (key === 'ACHIEVEMENTS') {
        const publicId = await nextPublicId(conn, 'achievements', 'public_id', 'CC-ACH');
        const [ins] = await conn.execute(
          `INSERT INTO achievements
             (public_id, title, competition_name, category, description, achievement_year, position,
              event_date, department_id, verification_status, verified_by, verified_at, created_by,
              source_url, academic_year, is_historical, import_batch_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'VERIFIED', ?, NOW(), ?, ?, ?, 1, ?)`,
          [publicId, d.title, d.competition_name, d.category, d.description, d.achievement_year,
           d.position, d.event_date, d.department_id || null, user.id, user.id,
           d.source_url, d.academic_year, batchId]
        );
        const achievementId = ins.insertId;
        // `achievement_winners` now has something to show in the Hall of Fame.
        if (d.winner_name) {
          await conn.execute(
            `INSERT INTO achievement_winners (achievement_id, winner_name, department_id, role)
             VALUES (?, ?, ?, 'INDIVIDUAL')`,
            [achievementId, d.winner_name, d.department_id || null]
          );
        }
        created.push({ type: 'ACHIEVEMENTS', id: achievementId, title: d.title });
      } else {
        const publicId = await nextPublicId(conn, 'events', 'public_id', 'CC-EVT');
        const [ins] = await conn.execute(
          `INSERT INTO events
             (public_id, title, description, category, event_type, department_id, venue, event_date,
              start_time, end_time, max_participants, registration_deadline, poster_path, organizer_id,
              status, is_published, source_url, academic_year, is_historical, import_batch_id)
           VALUES (?, ?, ?, ?, 'COLLEGE_WIDE', ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'COMPLETED', 1, ?, ?, 1, ?)`,
          [publicId, d.title, d.description, d.category, d.department_id || null, d.venue, d.event_date,
           d.start_time, d.end_time, d.max_participants, d.poster_path, organizerFor(d.organizer_kind),
           d.source_url, d.academic_year, batchId]
        );
        created.push({ type: 'EVENTS', id: ins.insertId, title: d.title });
      }
      results.push({ row_number: item.rowNumber, outcome: 'imported', message: 'Imported' });
    }

    await conn.execute(
      `UPDATE import_batches
          SET imported_rows = ?, duplicate_rows = ?, skipped_rows = ?, failed_rows = ?
        WHERE id = ?`,
      [created.length, duplicates, skipped, failed.length, batchId]
    );

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  }

  results.sort((a, b) => a.row_number - b.row_number);
  return {
    batch_ref: batchRef,
    batch_id: batchId,
    type: key,
    label: spec.label,
    imported: created.length,
    duplicates,
    skipped,
    failed: failed.length,
    total: incoming.length,
    created,
    results,
    failures: failed,
  };
}

async function history({ limit = 25 } = {}) {
  const [rows] = await db.execute(
    `SELECT b.id, b.batch_ref, b.record_type, b.source_filename, b.source_url, b.academic_year,
            b.total_rows, b.imported_rows, b.duplicate_rows, b.skipped_rows, b.failed_rows,
            b.created_at, u.full_name AS imported_by_name
       FROM import_batches b
       LEFT JOIN users u ON u.id = b.imported_by
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT ?`,
    [String(Math.min(100, Math.max(1, parseInt(limit, 10) || 25)))]
  );
  return rows;
}

/** Records created by one batch, so an admin can review an import afterwards. */
async function batchRecords(batchId) {
  const id = parseInt(batchId, 10);
  if (!id) throw new ApiError(400, 'A valid batch id is required');
  const [events] = await db.execute(
    'SELECT id, public_id, title, event_date FROM events WHERE import_batch_id = ? ORDER BY event_date DESC',
    [id]
  );
  const [anns] = await db.execute(
    'SELECT id, title, published_at FROM announcements WHERE import_batch_id = ? ORDER BY published_at DESC',
    [id]
  );
  const [achs] = await db.execute(
    'SELECT id, public_id, title, achievement_year FROM achievements WHERE import_batch_id = ? ORDER BY achievement_year DESC',
    [id]
  );
  return { events, announcements: anns, achievements: achs };
}

module.exports = {
  listTypes,
  typeSpecs: TYPE_SPECS,
  parseCsv,
  toCsv,
  parseDateValue,
  parseTimeValue,
  parseDateTimeValue,
  analyseCsv,
  commitImport,
  history,
  batchRecords,
  EVENT_CATEGORIES,
  ANNOUNCEMENT_CATEGORIES,
  ANNOUNCEMENT_AUDIENCES,
  ACHIEVEMENT_CATEGORIES,
  ACHIEVEMENT_POSITIONS,
};
