// Storage for captain-uploaded documents (license, vehicle registration,
// insurance, inspection certificate, photo). Deliberately NOT part of the
// main app_state JSONB blob in db.js — that blob gets rewritten wholesale on
// every save(), and binary files would make that increasingly slow and
// wasteful as more captains register. Files get their own table instead.
//
// Same dual-mode pattern as db.js: Postgres if DATABASE_URL is set, else a
// local disk folder for development. The disk fallback is NOT durable on a
// host with an ephemeral filesystem — fine for local testing, not for real
// captain documents.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
const DATABASE_URL = process.env.DATABASE_URL;

// Keep individual files reasonably small — this is Postgres bytea storage,
// not a CDN, and free-tier Postgres storage quotas are modest (see README).
const MAX_FILE_BYTES = 6 * 1024 * 1024; // 6MB

let pool = null;
let ready = Promise.resolve();

if (DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  ready = pool
    .query(
      `CREATE TABLE IF NOT EXISTS captain_documents (
         id TEXT PRIMARY KEY,
         captain_id TEXT NOT NULL,
         doc_type TEXT NOT NULL,
         mime_type TEXT NOT NULL,
         data BYTEA NOT NULL,
         uploaded_at BIGINT NOT NULL
       )`
    )
    .catch((err) => {
      console.error('Could not set up captain_documents table — falling back to local disk for files:', err.message);
      pool = null;
    });
} else {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

async function saveDocument(captainId, docType, mimeType, buffer) {
  if (buffer.length > MAX_FILE_BYTES) {
    const err = new Error(`File too large — max ${MAX_FILE_BYTES / 1024 / 1024}MB.`);
    err.code = 'FILE_TOO_LARGE';
    throw err;
  }
  const id = randomUUID();
  if (pool) {
    await pool.query(
      'INSERT INTO captain_documents (id, captain_id, doc_type, mime_type, data, uploaded_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, captainId, docType, mimeType, buffer, Date.now()]
    );
  } else {
    fs.writeFileSync(path.join(UPLOADS_DIR, id), buffer);
    fs.writeFileSync(path.join(UPLOADS_DIR, id + '.meta.json'), JSON.stringify({ captainId, docType, mimeType, uploadedAt: Date.now() }));
  }
  return id;
}

async function getDocument(fileId) {
  if (pool) {
    const res = await pool.query('SELECT mime_type, data FROM captain_documents WHERE id = $1', [fileId]);
    if (!res.rows.length) return null;
    return { mimeType: res.rows[0].mime_type, data: res.rows[0].data };
  }
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(UPLOADS_DIR, fileId + '.meta.json'), 'utf8'));
    const data = fs.readFileSync(path.join(UPLOADS_DIR, fileId));
    return { mimeType: meta.mimeType, data };
  } catch (e) {
    return null;
  }
}

async function deleteDocument(fileId) {
  if (pool) {
    await pool.query('DELETE FROM captain_documents WHERE id = $1', [fileId]);
  } else {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, fileId)); } catch (e) {}
    try { fs.unlinkSync(path.join(UPLOADS_DIR, fileId + '.meta.json')); } catch (e) {}
  }
}

module.exports = { ready, saveDocument, getDocument, deleteDocument, isUsingPostgres: () => !!pool };
