'use strict';
const router = require('express').Router();
const ticketCtrl = require('../controllers/ticketController');
const { authenticate, authenticateQuery, authorize } = require('../middleware/auth');
const { asyncHandler } = require('../utils/helpers');
const coordinatorRoles = ['ADMIN', 'FACULTY', 'ORGANIZER', 'CLUB_COORDINATOR'];

// Student endpoints
router.get('/my-tickets', authenticate, asyncHandler(ticketCtrl.getMyTickets));
router.get('/ticket/:id', authenticate, asyncHandler(ticketCtrl.getTicketById));
router.patch('/ticket/:id/cancel', authenticate, asyncHandler(ticketCtrl.cancelTicket));

// Coordinator endpoints (access restricted per event in service layer)
router.get('/coordinator/events', authenticate, authorize(...coordinatorRoles), asyncHandler(ticketCtrl.getCoordinatorEvents));
router.post('/verify', authenticate, authorize(...coordinatorRoles), asyncHandler(ticketCtrl.verifyTicket));
router.post('/scan', authenticate, authorize(...coordinatorRoles), asyncHandler(ticketCtrl.scanTicket));
router.post('/confirm-entry', authenticate, authorize(...coordinatorRoles), asyncHandler(ticketCtrl.confirmEntry));
router.get('/events/:eventId/attendees', authenticate, authorize(...coordinatorRoles), asyncHandler(ticketCtrl.getEventAttendees));
router.get('/events/:eventId/export', authenticateQuery, authorize(...coordinatorRoles), asyncHandler(ticketCtrl.exportEventAttendees));

// Coordinator assignment & admin management
router.get('/events/:eventId/coordinators', authenticate, authorize(...coordinatorRoles), asyncHandler(ticketCtrl.getEventCoordinators));
router.post('/events/:eventId/coordinators', authenticate, authorize('ADMIN', 'ORGANIZER'), asyncHandler(ticketCtrl.assignCoordinator));
router.delete('/events/:eventId/coordinators/:userId', authenticate, authorize('ADMIN', 'ORGANIZER'), asyncHandler(ticketCtrl.removeCoordinator));
router.get('/admin/overview', authenticate, authorize('ADMIN'), asyncHandler(ticketCtrl.getAdminOverview));

module.exports = router;
