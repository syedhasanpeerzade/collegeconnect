'use strict';
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { ApiError } = require('../utils/ApiError');

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');
const MAX_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '5', 10);

// Allowed types by use-case. We check BOTH the client MIME type and the
// file extension, and never trust either alone.
const RULES = {
  images: {
    mimes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    exts: ['.jpg', '.jpeg', '.png', '.webp', '.gif'],
  },
  docs: {
    mimes: ['application/pdf'],
    exts: ['.pdf'],
  },
  videos: {
    mimes: ['video/mp4', 'video/webm', 'video/quicktime'],
    exts: ['.mp4', '.webm', '.mov'],
  },
};
RULES.any = {
  mimes: [...RULES.images.mimes, ...RULES.videos.mimes, ...RULES.docs.mimes],
  exts: [...RULES.images.exts, ...RULES.videos.exts, ...RULES.docs.exts],
};

const ALLOWED_SET = new Set(RULES.any.mimes);

// Ensure upload directories exist
['', 'posters', 'proposals', 'complaints', 'announcements', 'clubs', 'achievements', 'posts', 'avatars', 'marketplace'].forEach((d) => {
  const dir = d ? path.join(UPLOAD_ROOT, d) : UPLOAD_ROOT;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function sanitizeName(original) {
  const ext = path.extname(original || '').toLowerCase();
  const base = path
    .basename(original || 'file', ext)
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'file';
  return `${base}-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`;
}

function makeUploader(kind) {
  const rules = kind === 'docs' ? RULES.docs : kind === 'images' ? RULES.images : RULES.any;
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      let sub = '';
      if (file.fieldname === 'poster') sub = 'posters';
      else if (file.fieldname === 'proposal') sub = 'proposals';
      else if (file.fieldname === 'attachment') sub = 'complaints';
      else if (file.fieldname === 'announcement_file') sub = 'announcements';
      else if (file.fieldname === 'logo' || file.fieldname === 'banner') sub = 'clubs';
      else if (file.fieldname === 'media') sub = 'achievements';
      else if (file.fieldname === 'image' || file.fieldname === 'video') sub = 'posts';
      else if (file.fieldname === 'avatar' || file.fieldname === 'cover') sub = 'avatars';
      else if (file.fieldname === 'listing_image' || file.fieldname === 'item_photo') sub = 'marketplace';
      cb(null, path.join(UPLOAD_ROOT, sub));
    },
    filename: (req, file, cb) => cb(null, sanitizeName(file.originalname)),
  });

  return multer({
    storage,
    limits: { fileSize: MAX_MB * 1024 * 1024, files: 2 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (!ALLOWED_SET.has(file.mimetype) || !rules.exts.includes(ext)) {
        return cb(new ApiError(400,
          `File type not allowed. Allowed: ${rules.exts.join(', ')} (max ${MAX_MB} MB each)`));
      }
      cb(null, true);
    },
  });
}

// Bulk-import CSVs are parsed in memory and never written to disk: the file is
// transient input, and /uploads is served publicly.
const CSV_EXTS = ['.csv', '.txt'];
const csvImport = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!CSV_EXTS.includes(ext)) {
      return cb(new ApiError(400, `Bulk import needs a CSV file (.csv). Received "${file.originalname || 'unknown'}".`));
    }
    cb(null, true);
  },
}).single('file');

// Field-accepting uploaders (poster + proposal in one request)
const uploads = {
  csvImport,
  eventFiles: makeUploader('any').fields([
    { name: 'poster', maxCount: 1 },
    { name: 'proposal', maxCount: 1 },
  ]),
  complaintAttachment: makeUploader('any').single('attachment'),
  announcementFile: makeUploader('any').single('announcement_file'),
  clubImages: makeUploader('images').fields([
    { name: 'logo', maxCount: 1 },
    { name: 'banner', maxCount: 1 },
  ]),
  achievementMedia: makeUploader('any').array('media', 4),
  postMedia: makeUploader('any').fields([
    { name: 'image', maxCount: 1 },
    { name: 'video', maxCount: 1 },
  ]),
  profileImages: makeUploader('images').fields([
    { name: 'avatar', maxCount: 1 },
    { name: 'cover', maxCount: 1 },
  ]),
};

// Multer-specific error translation
function uploadErrorHandler(err, req, res, next) {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    const msg =
      err.code === 'LIMIT_FILE_SIZE'
        ? `File too large. Maximum size is ${MAX_MB} MB.`
        : `Upload error: ${err.message}`;
    return res.status(400).json({ success: false, message: msg });
  }
  if (err instanceof ApiError) {
    return res.status(err.status).json({ success: false, message: err.message });
  }
  return next(err);
}

module.exports = { uploads, uploadErrorHandler, UPLOAD_ROOT };
