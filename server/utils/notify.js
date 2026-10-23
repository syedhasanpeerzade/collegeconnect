'use strict';

/**
 * Create a notification row. Never throws - notification failures
 * must not break the main operation (e.g. registration).
 *
 * priority: 1 = personalized/interest-matched (shown first, red dot in the UI)
 * dedupeKey: stable key grouping related notifications per recipient
 *            (e.g. "EVT-12-INTEREST"); a repeat insert with the same key is a
 *            no-op, which is how fan-outs avoid spamming students.
 */
async function notify(conn, {
  recipientId, type, title, message,
  relatedType = null, relatedId = null, link = null,
  priority = 0, dedupeKey = null,
}) {
  if (!recipientId) return;
  try {
    const dedupeClause = dedupeKey ? ' ON CONFLICT (recipient_id, dedupe_key) DO NOTHING' : '';
    await conn.execute(
      `INSERT INTO notifications (recipient_id, type, title, message, related_type, related_id, link, priority, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)${dedupeClause}`,
      [recipientId, type, title, message, relatedType, relatedId, link, priority, dedupeKey]
    );
  } catch (e) {
    console.error('notify failed:', e.message);
  }
}

module.exports = { notify };
