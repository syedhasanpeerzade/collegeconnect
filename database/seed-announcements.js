'use strict';
/**
 * Applies database/seed-announcements.sql (idempotent demo announcements)
 * and generates the banner image used as a demo attachment, if missing.
 * Usage: node database/seed-announcements.js   (also: npm run db:seed:announcements)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');

// ---------- tiny PNG writer (no dependencies) ----------
function crc32(buf) {
  if (!crc32.table) {
    crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crc32.table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makeBannerPng(w = 960, h = 300) {
  const rows = [];
  const bandTop = Math.floor(h * 0.62);
  const bandBottom = Math.floor(h * 0.78);
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      let r;
      let g;
      let b;
      if (y >= bandTop && y < bandBottom) {
        r = 241; g = 245; b = 249; // light band
      } else if ((y > 8 && y < 20) || (y > h - 21 && y < h - 9)) {
        r = 13; g = 115; b = 119; // darker teal edges
      } else {
        const t = x / w;
        r = Math.round(13 + (17 - 13) * t);
        g = Math.round(115 + (94 - 115) * t);
        b = Math.round(119 + (170 - 119) * t);
        if (Math.abs(y - bandTop) <= 1 || Math.abs(y - bandBottom) <= 1) {
          r = 255; g = 255; b = 255; // band borders
        }
      }
      const o = 1 + x * 3;
      row[o] = r;
      row[o + 1] = g;
      row[o + 2] = b;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  // 1) Banner image used as a demo attachment (generated only if missing).
  const imgDir = path.join(__dirname, '..', 'server', 'uploads', 'announcements');
  fs.mkdirSync(imgDir, { recursive: true });
  const imgPath = path.join(imgDir, 'demo-announcement-banner.png');
  if (!fs.existsSync(imgPath)) {
    fs.writeFileSync(imgPath, makeBannerPng());
    console.log('Generated banner image: uploads/announcements/demo-announcement-banner.png');
  }

  // 2) Seed rows (idempotent).
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const ssl = /supabase|neon|render|amazonaws|azure|heroku/i.test(connectionString)
    ? { rejectUnauthorized: false }
    : false;
  const client = new Client({ connectionString, ssl });
  await client.connect();
  try {
    await client.query(fs.readFileSync(path.join(__dirname, 'seed-announcements.sql'), 'utf8'));
    const { rows } = await client.query(
      `SELECT category, title FROM announcements
       WHERE title IN (
         'Mid-semester examination timetable published',
         'CodeSprint 2026: Final results are out',
         'TechClub: robotics workshop registrations close Friday',
         'Library extends opening hours during exam season',
         'URGENT: Campus will remain closed tomorrow',
         'Sports division: inter-department football fixtures')
       ORDER BY published_at DESC`
    );
    console.log(`Demo announcements seeded: ${rows.length}`);
    rows.forEach((r) => console.log(`  ${r.category.padEnd(8)} - ${r.title}`));
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error('Seed failed:', e.message); process.exit(1); });
