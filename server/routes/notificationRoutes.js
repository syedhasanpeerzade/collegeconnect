'use strict';
const router = require('express').Router();
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { asyncHandler, ok } = require('../utils/helpers');

router.get('/', authenticate, asyncHandler(async (req, res) => {
  const [rows] = await db.execute(
    `SELECT id, type, title, message, related_type, related_id, link, is_read, priority, created_at
     FROM notifications WHERE recipient_id = ?
     ORDER BY priority DESC, created_at DESC
     LIMIT 200`,
    [req.user.id]
  );
  ok(res, 'Notifications', rows);
}));

router.get('/unread-count', authenticate, asyncHandler(async (req, res) => {
  const [rows] = await db.execute(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(CASE WHEN priority = 1 THEN 1 ELSE 0 END), 0)::int AS p
     FROM notifications WHERE recipient_id = ? AND is_read = 0`,
    [req.user.id]
  );
  ok(res, 'Unread count', { count: rows[0].n, priority: rows[0].p });
}));

router.put('/read-all', authenticate, asyncHandler(async (req, res) => {
  await db.execute('UPDATE notifications SET is_read = 1 WHERE recipient_id = ?', [req.user.id]);
  ok(res, 'All notifications marked as read');
}));

router.put('/:id/read', authenticate, asyncHandler(async (req, res) => {
  const [r] = await db.execute(
    'UPDATE notifications SET is_read = 1 WHERE id = ? AND recipient_id = ?',
    [parseInt(req.params.id, 10), req.user.id]
  );
  if (!r.affectedRows) return res.status(404).json({ success: false, message: 'Notification not found' });
  ok(res, 'Notification marked as read');
}));

module.exports = router;
