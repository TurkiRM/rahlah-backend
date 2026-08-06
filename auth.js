// Real accounts for all three roles: phone/username + password, bcrypt-hashed,
// with opaque session tokens (not JWTs — simpler, and revocable by just deleting
// the server-side record, which matters more than statelessness at this scale).

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./db');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — these are "stay logged in" apps

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}
function checkPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

// Builds a full register/login/session/middleware kit for one role.
// `state.<accountsKey>` holds accounts by id; `state.<sessionsKey>` holds
// token -> { accountId, createdAt }.
function makeAccountKit({ accountsKey, sessionsKey, loginField, publicFields }) {
  const state = db.state;
  state[accountsKey] = state[accountsKey] || {};
  state[sessionsKey] = state[sessionsKey] || {};

  function findByLogin(loginValue) {
    return Object.values(state[accountsKey]).find((a) => a[loginField] === loginValue);
  }

  function toPublic(account) {
    const out = {};
    publicFields.forEach((f) => (out[f] = account[f]));
    return out;
  }

  function createSession(accountId) {
    const token = crypto.randomUUID();
    state[sessionsKey][token] = { accountId, createdAt: Date.now() };
    db.save();
    return token;
  }

  function validateSession(token) {
    const sess = state[sessionsKey][token];
    if (!sess) return null;
    if (Date.now() - sess.createdAt > SESSION_TTL_MS) {
      delete state[sessionsKey][token];
      db.save();
      return null;
    }
    return state[accountsKey][sess.accountId] || null;
  }

  function requireAuth(req, res, next) {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const account = token ? validateSession(token) : null;
    if (!account) return res.status(401).json({ error: 'Not logged in.' });
    req.account = account;
    next();
  }

  return { state, findByLogin, toPublic, createSession, validateSession, requireAuth };
}

module.exports = { hashPassword, checkPassword, makeAccountKit };
