'use strict';
const router = require('express').Router();
const QRCode = require('qrcode');
const { optionalAuth, authorize, authenticate } = require('../middleware/auth');
const { ok, asyncHandler } = require('../utils/helpers');

// Destination is always APP_URL + /events (one permanent QR for the whole college)
function qrDestination() {
  return `${(process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '')}/events`;
}

// JSON metadata + inline data URL
router.get('/', optionalAuth, asyncHandler(async (req, res) => {
  const url = qrDestination();
  const dataUrl = await QRCode.toDataURL(url, {
    width: 512, margin: 2,
    color: { dark: '#1a1a2e', light: '#ffffff' },
    errorCorrectionLevel: 'H',
  });
  ok(res, 'College QR code', { destination: url, data_url: dataUrl });
}));

// Spec aliases: /api/qr/event-page-meta and /api/qr/event-page
router.get('/event-page-meta', asyncHandler(async (req, res) => {
  ok(res, 'College QR code destination', { url: qrDestination() });
}));
router.get('/event-page', asyncHandler(async (req, res) => {
  const png = await QRCode.toBuffer(qrDestination(), {
    width: 1024, margin: 2,
    color: { dark: '#1a1a2e', light: '#ffffff' },
    errorCorrectionLevel: 'H',
  });
  res.setHeader('Content-Type', 'image/png');
  res.send(png);
}));

// Raw PNG (for download / print)
router.get('/download', asyncHandler(async (req, res) => {
  const png = await QRCode.toBuffer(qrDestination(), {
    width: 1024, margin: 2,
    color: { dark: '#1a1a2e', light: '#ffffff' },
    errorCorrectionLevel: 'H',
  });
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', 'attachment; filename="collegeconnect-qr.png"');
  res.send(png);
}));

module.exports = router;
