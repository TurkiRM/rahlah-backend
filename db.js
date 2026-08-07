// Persistence layer with two modes:
//  - DATABASE_URL set  → Postgres. The whole app state is stored as a single
//    JSONB blob (not a full relational schema — see README for why that's a
//    deliberate, safe tradeoff at this scale). This is what makes captain and
//    customer accounts survive restarts/redeploys on a host with an ephemeral
//    filesystem (Render free tier, etc.).
//  - DATABASE_URL unset → falls back to a local JSON file, same as before.
//    Good for local development; not durable enough for real accounts.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db.json');
const DATABASE_URL = process.env.DATABASE_URL;

function loadFromFile() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

// `state` is populated synchronously (from file, or empty) so every module
// that does `const state = db.state` at require-time gets a real object
// immediately. If Postgres is in use, its data overwrites this in place
// (same object reference) once `ready` resolves — see below.
const state = loadFromFile();

let pool = null;
let saveTimer = null;
let ready = Promise.resolve();

if (DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  });

  ready = (async () => {
    await pool.query('CREATE TABLE IF NOT EXISTS app_state (id INT PRIMARY KEY, data JSONB NOT NULL)');
    const res = await pool.query('SELECT data FROM app_state WHERE id = 1');
    if (res.rows.length) {
      Object.keys(state).forEach((k) => delete state[k]);
      Object.assign(state, res.rows[0].data);
      console.log('Loaded app state from Postgres.');
    } else {
      console.log('No existing Postgres state found — starting fresh (this is expected on first boot).');
    }
  })().catch((err) => {
    console.error('Could not connect to Postgres — falling back to local file storage:', err.message);
    console.error('Accounts created from now on will NOT survive a restart until DATABASE_URL is fixed.');
    pool = null;
  });
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (pool) {
      try {
        await pool.query(
          'INSERT INTO app_state (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = $1',
          [JSON.stringify(state)]
        );
      } catch (err) {
        console.error('Postgres save failed:', err.message);
      }
    } else {
      fs.writeFile(DB_PATH, JSON.stringify(state, null, 2), () => {});
    }
  }, 200);
}

module.exports = { state, save, ready, isUsingPostgres: () => !!pool };
