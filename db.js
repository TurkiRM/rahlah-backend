// Minimal JSON-file persistence. Good enough for a small shuttle operation;
// swap for Postgres/Mongo when you outgrow a single process (see README).

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db.json');

function load() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { cars: {}, captains: {}, trips: [] };
  }
}

let state = load();
let saveTimer = null;

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DB_PATH, JSON.stringify(state, null, 2), () => {});
  }, 200); // debounce so rapid updates don't hammer disk
}

module.exports = { state, save };
