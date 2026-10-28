'use strict';
const ticketService = require('../services/ticketService');
const { ok, created } = require('../utils/helpers');

async function getMyTickets(req, res) {
  const tickets = await ticketService.getMyTickets(req.user.id);
  ok(res, 'Student event tickets retrieved', tickets);
}

async function getTicketById(req, res) {
  const ticket = await ticketService.getTicketById(req.params.id, req.user);
  ok(res, 'Ticket details retrieved', ticket);
}

async function getCoordinatorEvents(req, res) {
  const events = await ticketService.getCoordinatorEvents(req.user);
  ok(res, 'Assigned coordinator events retrieved', events);
}

async function verifyTicket(req, res) {
  const { event_id, ticket_code } = req.body;
  const result = await ticketService.verifyTicket(event_id, ticket_code, req.user);
  ok(res, result.message, result);
}

async function scanTicket(req, res) {
  const { event_id, ticket_code, ticket_id, scan_method } = req.body;
  const lookup = ticket_id || ticket_code;
  const result = await ticketService.scanTicket(event_id, lookup, req.user, scan_method || 'QR_SCAN');
  ok(res, result.message, result);
}

async function confirmEntry(req, res) {
  const { event_id, ticket_code, ticket_id, scan_method } = req.body;
  const lookup = ticket_id || ticket_code;
  const result = await ticketService.confirmEntry(event_id, lookup, req.user, scan_method || 'QR_SCAN');
  ok(res, result.message, result);
}

async function getEventAttendees(req, res) {
  const { eventId } = req.params;
  const { search, status } = req.query;
  const result = await ticketService.getEventAttendees(eventId, req.user, { search, status });
  ok(res, 'Event attendees and attendance statistics retrieved', result);
}

async function exportEventAttendees(req, res) {
  const { eventId } = req.params;
  const csv = await ticketService.exportEventAttendeesCSV(eventId, req.user);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="event-${eventId}-attendees.csv"`);
  res.send(csv);
}

async function assignCoordinator(req, res) {
  const { eventId } = req.params;
  const { user_id } = req.body;
  const result = await ticketService.assignCoordinator(eventId, user_id, req.user);
  created(res, result.message, result);
}

async function removeCoordinator(req, res) {
  const { eventId, userId } = req.params;
  const result = await ticketService.removeCoordinator(eventId, userId, req.user);
  ok(res, result.message, result);
}

async function getEventCoordinators(req, res) {
  const { eventId } = req.params;
  const list = await ticketService.getEventCoordinators(eventId, req.user);
  ok(res, 'Event coordinators retrieved', list);
}

async function cancelTicket(req, res) {
  const { id } = req.params;
  const { reason } = req.body;
  const result = await ticketService.cancelTicket(id, req.user, reason);
  ok(res, result.message, result);
}

async function getAdminOverview(req, res) {
  const overview = await ticketService.getAdminOverview();
  ok(res, 'Admin ticketing overview retrieved', overview);
}

module.exports = {
  getMyTickets,
  getTicketById,
  getCoordinatorEvents,
  verifyTicket,
  scanTicket,
  confirmEntry,
  getEventAttendees,
  exportEventAttendees,
  assignCoordinator,
  removeCoordinator,
  getEventCoordinators,
  cancelTicket,
  getAdminOverview,
};
