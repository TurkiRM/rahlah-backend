// Push notifications for captains who aren't actively in the app when a car
// needs one. Uses standard Web Push (VAPID) — no third-party service.
//
// Subscriptions are keyed by the captain's persistent account id (not a
// browser-generated device id) now that accounts are real — one subscription
// per captain, latest device wins if they log in from more than one.

const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const db = require('./db');

const VAPID_PATH = path.join(__dirname, 'data', 'vapid.json');

function loadOrCreateVapidKeys() {
  // Prefer env vars — required on hosts with an ephemeral filesystem (e.g. Render's
  // free tier), where a file written to disk disappears on every restart/redeploy
  // and would silently invalidate every captain's push subscription each time.
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  try {
    return JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
  } catch (e) {
    const keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_PATH, JSON.stringify(keys, null, 2));
    console.log('Generated new VAPID keys and saved them to data/vapid.json.');
    console.log('On a host with an ephemeral filesystem (Render free tier, etc.), set these as');
    console.log('env vars instead so they survive restarts:');
    console.log(`  VAPID_PUBLIC_KEY=${keys.publicKey}`);
    console.log(`  VAPID_PRIVATE_KEY=${keys.privateKey}`);
    return keys;
  }
}

const vapidKeys = loadOrCreateVapidKeys();
webpush.setVapidDetails('mailto:ops@example.com', vapidKeys.publicKey, vapidKeys.privateKey);

const state = db.state;
state.pushSubs = state.pushSubs || {}; // captainId -> raw PushSubscription

function subscribe(captainId, subscription) {
  state.pushSubs[captainId] = subscription;
  db.save();
}

function unsubscribe(captainId) {
  delete state.pushSubs[captainId];
  db.save();
}

// Notifies a specific list of captains (by account id). Silently drops dead
// subscriptions instead of throwing.
async function notifyCaptainIds(captainIds, { title, body }) {
  let touched = false;
  await Promise.all(
    captainIds.map(async (captainId) => {
      const subscription = state.pushSubs[captainId];
      if (!subscription) return;
      try {
        await webpush.sendNotification(subscription, JSON.stringify({ title, body }));
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          delete state.pushSubs[captainId];
          touched = true;
        }
      }
    })
  );
  if (touched) db.save();
}

module.exports = { vapidPublicKey: vapidKeys.publicKey, subscribe, unsubscribe, notifyCaptainIds };
