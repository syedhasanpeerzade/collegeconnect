'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { errorHandler } = require('./middleware/errorHandler');

const app = express();

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: false, // static site loads its own scripts
  crossOriginResourcePolicy: { policy: 'same-site' },
}));
app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

// Redirect legacy /myspace or /myspace.html to /dashboard.html
app.get(['/myspace', '/myspace.html'], (req, res) => res.redirect(301, '/dashboard.html'));

// Static frontend
const clientDir = path.join(__dirname, '..', 'client');
app.use(express.static(clientDir, { extensions: ['html'] }));
// Uploaded files served as static attachments (never executed)
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'text/plain'); // neutralize uploaded scripts
    }
  },
}));

// API routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/events', require('./routes/eventRoutes'));
app.use('/api/events', require('./routes/adminEventRoutes'));
app.use('/api/clubs', require('./routes/clubRoutes'));
app.use('/api/complaints', require('./routes/complaintRoutes'));
app.use('/api/announcements', require('./routes/announcementRoutes'));
app.use('/api/notifications', require('./routes/notificationRoutes'));
app.use('/api/interests', require('./routes/interestRoutes'));
app.use('/api/latest-results', require('./routes/latestResultsRoutes'));
app.use('/api/achievements', require('./routes/achievementRoutes'));
app.use('/api/qr', require('./routes/qrRoutes'));
// Bulk historical import (admin only). Mounted before /api/admin so
// /api/admin/import/* can never be shadowed by another admin route.
app.use('/api/admin/import', require('./routes/importRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/admin/content', require('./routes/adminContentRoutes'));
// Social layer (feed, posts, likes, comments, follows, polls, communities)
app.use('/api/social', require('./routes/socialRoutes'));
app.use('/api/reports', require('./routes/reportRoutes'));
// Event Ticketing system (two-sided: student tickets, coordinator verification, admin management)
app.use('/api/tickets', require('./routes/ticketRoutes'));
// Spec-compliant path aliases (event-requests, my-registrations, my-club-applications)
app.use('/api', require('./routes/specAliasRoutes'));

app.get('/api/health', (req, res) => res.json({ success: true, message: 'CollegeConnect API is running', data: { time: new Date().toISOString() } }));

// 404 for unknown API routes
app.use('/api', (req, res) => res.status(404).json({ success: false, message: 'API route not found' }));
// 404 for unknown pages -> friendly page
app.use((req, res) => res.status(404).sendFile(path.join(clientDir, '404.html')));

app.use(errorHandler);

// PORT=0 (or blank) from the host environment falls back to 3000
const PORT = parseInt(process.env.PORT, 10) || 3000;
if (require.main === module) {
  // Idempotent schema migrations MUST run sequentially before the app boots.
  // Each runner exposes its migration promise (or exits on failure when run
  // standalone). Firing them off as bare require()s raced them concurrently,
  // which caused real boot failures: deadlocks on ALTER-heavy migrations
  // ("Import migration failed: deadlock detected") and a racing
  // achievement-management migration that lost its transaction.
  (async () => {
    try {
      await require('../database/migrate-social.js');
      await require('../database/migrate-reports.js');
      await require('../database/migrate-import.js');
      await require('../database/migrate-achievement-winners.js');
      await require('../database/migrate-achievement-management.js');
      await require('../database/migrate-ticketing.js');
    } catch (e) {

      console.error('Boot migration failed:', e.message);
      process.exit(1);
    }
    const server = app.listen(PORT, () => {
      console.log(`CollegeConnect running at ${process.env.APP_URL || `http://localhost:${PORT}`} (port ${PORT})`);
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Stop the other program using it (or set PORT=3001 in .env) and run again.`);
        process.exit(1);
      }
      throw err;
    });
  })();
}

module.exports = app;
