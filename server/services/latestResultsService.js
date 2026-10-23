'use strict';
/**
 * "Latest Event Results" - the completed college event whose results were
 * recorded most recently, plus its verified result records (1st/2nd/3rd
 * place). Fully dynamic: whichever event has the newest verified result
 * becomes the featured section; nothing is hard-coded.
 */
const db = require('../config/db');
const { notify } = require('../utils/notify');

const RESULT_SELECT = `
  SELECT a.id, a.public_id, a.title, a.competition_name, a.category, a.achievement_year,
         a.position, a.department_id, a.club_id, a.event_id, a.verified_at,
         d.code AS department_code, d.name AS department_name,
         c.name AS club_name,
         (SELECT GROUP_CONCAT(w.winner_name SEPARATOR ', ') FROM achievement_winners w
            WHERE w.achievement_id = a.id AND w.winner_name IS NOT NULL) AS winner_names,
         (SELECT GROUP_CONCAT(w2.team_name SEPARATOR ', ') FROM achievement_winners w2
            WHERE w2.achievement_id = a.id AND w2.team_name IS NOT NULL) AS team_names,
         (SELECT GROUP_CONCAT(m.file_path) FROM achievement_media m
            WHERE m.achievement_id = a.id) AS media_paths
  FROM achievements a
  LEFT JOIN departments d ON d.id = a.department_id
  LEFT JOIN clubs c ON c.id = a.club_id
  WHERE a.verification_status = 'VERIFIED' AND a.is_archived = 0`;

/** Position rank used to label 1st / 2nd / 3rd within the featured results. */
const POSITION_RANK = { '1ST_PLACE': 1, '2ND_PLACE': 2, '3RD_PLACE': 3 };

/**
 * The latest completed event with published results.
 *
 * Selection rule (dynamic): the event linked to the verified achievement
 * record that was verified most recently. Falls back to the most recently
 * verified standalone result when records are not linked to an event row.
 * Only past/completed events qualify as "latest event"; upcoming ones are
 * never featured.
 */
const EVENT_SEED_SELECT = `
  SELECT a.id, a.public_id, a.title, a.competition_name, a.category, a.achievement_year,
         a.position, a.department_id, a.club_id, a.event_id, a.verified_at,
         d.code AS department_code, d.name AS department_name,
         c.name AS club_name,
         (SELECT GROUP_CONCAT(w.winner_name SEPARATOR ', ') FROM achievement_winners w
            WHERE w.achievement_id = a.id AND w.winner_name IS NOT NULL) AS winner_names,
         (SELECT GROUP_CONCAT(w2.team_name SEPARATOR ', ') FROM achievement_winners w2
            WHERE w2.achievement_id = a.id AND w2.team_name IS NOT NULL) AS team_names,
         (SELECT GROUP_CONCAT(m.file_path) FROM achievement_media m
            WHERE m.achievement_id = a.id) AS media_paths
  FROM achievements a
  LEFT JOIN departments d ON d.id = a.department_id
  LEFT JOIN clubs c ON c.id = a.club_id
  LEFT JOIN events e ON e.id = a.event_id
  WHERE a.verification_status = 'VERIFIED' AND a.is_archived = 0`;

async function latestEventResults() {
  // 1) Newest verified result linked to a college event
  const [evRows] = await db.execute(
    `${EVENT_SEED_SELECT} AND a.event_id IS NOT NULL
     ORDER BY a.verified_at DESC, a.id DESC
     LIMIT 1`
  );
  const seed = evRows[0] || null;

  if (seed && seed.event_id) {
    // Event facts come from the events row itself
    const [events] = await db.execute(
      `SELECT e.id, e.public_id, e.title, e.category, e.event_date, e.start_time, e.end_time,
              e.venue, e.poster_path, e.status,
              (e.event_date < CURRENT_DATE OR (e.event_date = CURRENT_DATE AND e.end_time < CURRENT_TIME)) AS is_past
       FROM events e WHERE e.id = ?`,
      [seed.event_id]
    );
    const ev = events[0];
    if (ev && ev.is_past) {
      const [results] = await db.execute(
        `${RESULT_SELECT} AND a.event_id = ?
         ORDER BY CASE a.position WHEN '1ST_PLACE' THEN 1 WHEN '2ND_PLACE' THEN 2 WHEN '3RD_PLACE' THEN 3 ELSE 9 END, a.id ASC`,
        [ev.id]
      );
      return shape({ event: ev, results, fallback: null });
    }
    // Linked event is upcoming (bad data) -> fall through to standalone results
  }

  // 2) Fallback: newest verified standalone result (no/pending event link)
  const [standalone] = await db.execute(
    `${RESULT_SELECT}
     ORDER BY a.verified_at DESC, a.id DESC
     LIMIT 8`
  );
  if (!standalone.length) return null;

  const [first] = standalone;
  const pseudoEvent = {
    id: null,
    public_id: null,
    title: first.competition_name,
    category: first.category,
    event_date: null,
    venue: null,
    poster_path: null,
    status: null,
  };
  return shape({ event: pseudoEvent, results: standalone.slice(0, 3), fallback: true });
}

function shape({ event, results }) {
  const byPos = (rank) => results.filter((r) => POSITION_RANK[r.position] === rank);
  const media = results.map((r) => (r.media_paths ? r.media_paths.split(',')[0] : '')).filter(Boolean);

  return {
    event: {
      id: event.id,
      public_id: event.public_id,
      title: event.title,
      category: event.category,
      event_date: event.event_date,
      venue: event.venue,
      poster_path: event.poster_path || media[0] || null,
      is_past: true,
    },
    winner: podium(byPos(1), 'winner'),
    runner_up: podium(byPos(2), 'runner_up'),
    third_place: podium(byPos(3), 'third_place'),
    results: results.map((r) => ({
      achievement_id: r.id,
      title: r.title,
      competition_name: r.competition_name,
      position: r.position,
      winner_names: r.winner_names || null,
      team_name: r.team_names || null,
      department_code: r.department_code || null,
      club_name: r.club_name || null,
    })),
  };
}

function podium(rows, _label) {
  if (!rows.length) return null;
  const r = rows[0];
  return {
    achievement_id: r.id,
    title: r.title,
    winner_names: r.winner_names || null,   // member names, e.g. "Ahmed, Rahul, Arjun"
    team_name: r.team_names || null,        // team name, e.g. "Team Innovators"
    department_code: r.department_code || null,
    club_name: r.club_name || null,
  };
}

module.exports = { latestEventResults, POSITION_RANK };
