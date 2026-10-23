'use strict';
/**
 * Admin content management: the admin's power tools for curating what
 * appears on the site — full event list (including unpublished), publish
 * toggles, club create/delete, and department CRUD.
 */
const db = require('../config/db');
const { ApiError } = require('../utils/ApiError');

const CLUB_CATEGORIES = ['TECHNICAL', 'CULTURAL', 'SPORTS', 'ACADEMIC', 'SOCIAL_SERVICE', 'OTHER'];

/** Every event regardless of publish state, with organizer + counts. */
async function listAllEvents() {
  const [rows] = await db.execute(
    `SELECT e.id, e.public_id, e.title, e.category, e.event_type, e.event_date, e.start_time, e.end_time,
            e.venue, e.status, e.is_published, e.max_participants, e.registration_deadline,
            u.full_name AS organizer_name,
            (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.id AND r.status = 'REGISTERED') AS registration_count
     FROM events e
     LEFT JOIN users u ON u.id = e.organizer_id
     ORDER BY e.event_date DESC, e.created_at DESC
     LIMIT 500`
  );
  return rows;
}

/** Publish or unpublish an event (unpublished events vanish from the public list). */
async function setEventPublished(id, isPublished) {
  const [rows] = await db.execute('SELECT title, is_published FROM events WHERE id = ?', [id]);
  if (!rows.length) throw new ApiError(404, 'Event not found');
  await db.execute('UPDATE events SET is_published = ? WHERE id = ?', [isPublished ? 1 : 0, id]);
  return { title: rows[0].title, is_published: isPublished ? 1 : 0 };
}

/** Create a club. */
async function createClub({ name, category, description, objectives, eligibility }, logoPath) {
  if (!name || !description) throw new ApiError(400, 'Club name and description are required');
  if (!CLUB_CATEGORIES.includes(category)) throw new ApiError(400, 'Invalid club category');
  const [dupe] = await db.execute('SELECT id FROM clubs WHERE LOWER(name) = LOWER(?)', [name]);
  if (dupe.length) throw new ApiError(409, 'A club with this name already exists');
  const [r] = await db.execute(
    `INSERT INTO clubs (name, category, description, objectives, eligibility, logo_path)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name, category, description, objectives || null, eligibility || null, logoPath || null]
  );
  return { id: r.insertId };
}

/** Update basic club info (admin variant; coordinator uses PUT /api/clubs/:id). */
async function updateClub(id, { name, category, description, objectives, eligibility, recruitment_status }, logoPath) {
  const [rows] = await db.execute('SELECT id FROM clubs WHERE id = ?', [id]);
  if (!rows.length) throw new ApiError(404, 'Club not found');
  await db.execute(
    `UPDATE clubs SET name = ?, category = ?, description = ?, objectives = ?, eligibility = ?,
       recruitment_status = COALESCE(?, recruitment_status), logo_path = COALESCE(?, logo_path)
     WHERE id = ?`,
    [name, category, description, objectives || null, eligibility || null, recruitment_status || null, logoPath || null, id]
  );
  return { id };
}

/** Delete a club. Members/applications cascade; events keep existing but are detached. */
async function deleteClub(id) {
  const [rows] = await db.execute('SELECT name FROM clubs WHERE id = ?', [id]);
  if (!rows.length) throw new ApiError(404, 'Club not found');
  await db.execute('DELETE FROM clubs WHERE id = ?', [id]);
  return { name: rows[0].name };
}

/** Department list with usage counts. */
async function listDepartments() {
  const [rows] = await db.execute(
    `SELECT d.id, d.code, d.name,
            (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id) AS users_count,
            (SELECT COUNT(*) FROM events e WHERE e.department_id = d.id) AS events_count
     FROM departments d ORDER BY d.name`
  );
  return rows;
}

async function createDepartment({ code, name }) {
  if (!code || !name) throw new ApiError(400, 'Department code and name are required');
  const [dupe] = await db.execute('SELECT id FROM departments WHERE UPPER(code) = UPPER(?)', [code]);
  if (dupe.length) throw new ApiError(409, 'A department with this code already exists');
  const [r] = await db.execute('INSERT INTO departments (code, name) VALUES (?, ?)', [code.toUpperCase(), name]);
  return { id: r.insertId };
}

async function updateDepartment(id, { code, name }) {
  const [rows] = await db.execute('SELECT id FROM departments WHERE id = ?', [id]);
  if (!rows.length) throw new ApiError(404, 'Department not found');
  await db.execute('UPDATE departments SET code = ?, name = ? WHERE id = ?', [code.toUpperCase(), name, id]);
  return { id };
}

async function deleteDepartment(id) {
  const [rows] = await db.execute('SELECT name FROM departments WHERE id = ?', [id]);
  if (!rows.length) throw new ApiError(404, 'Department not found');
  await db.execute('DELETE FROM departments WHERE id = ?', [id]);
  return { name: rows[0].name };
}

module.exports = {
  listAllEvents, setEventPublished,
  createClub, updateClub, deleteClub, CLUB_CATEGORIES,
  listDepartments, createDepartment, updateDepartment, deleteDepartment,
};
