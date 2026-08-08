const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');

const {
  VEHICLES,
  totalSeats,
  newCar,
  seatsFilled,
  tryFitParty,
  seatParty,
  releaseSeats,
} = require('./matching');
const db = require('./db');
const push = require('./push');
const { hashPassword, checkPassword, makeAccountKit } = require('./auth');
const { POINTS } = require('./points');

const state = db.state;
state.cars = state.cars || {};
state.trips = state.trips || [];
state.pendingPrivate = state.pendingPrivate || {};

/* ---------- accounts ---------- */

const captainAuth = makeAccountKit({
  accountsKey: 'captains',
  sessionsKey: 'captainSessions',
  loginField: 'phone',
  publicFields: ['id', 'phone', 'name', 'plate', 'vehicleType', 'direction', 'status', 'currentCarId', 'earnings', 'tripHistory', 'location', 'createdAt'],
});
const customerAuth = makeAccountKit({
  accountsKey: 'customers',
  sessionsKey: 'customerSessions',
  loginField: 'phone',
  publicFields: ['id', 'phone', 'name', 'gender', 'activeCarId', 'tripHistory', 'createdAt'],
});
const supervisorAuth = makeAccountKit({
  accountsKey: 'supervisors',
  sessionsKey: 'supervisorSessions',
  loginField: 'username',
  publicFields: ['id', 'username', 'name', 'createdAt'],
});

// Bootstrap exactly one supervisor account on first run — there's no sign-up
// flow for this role on purpose, so ops can't self-provision a dashboard login.
// This runs inside main() below, AFTER db.ready resolves — bootstrapping it
// here at require-time would race a Postgres load and could get wiped out
// (or, worse, briefly serve requests against an incomplete snapshot) if a
// request came in before the real persisted state finished loading.
function bootstrapSupervisorIfNeeded() {
  if (Object.keys(state.supervisors).length === 0) {
    const username = process.env.SUPERVISOR_USERNAME || 'admin';
    const password = process.env.SUPERVISOR_PASSWORD || require('crypto').randomBytes(6).toString('hex');
    const id = randomUUID();
    state.supervisors[id] = { id, username, name: 'Supervisor', passwordHash: hashPassword(password), createdAt: Date.now() };
    db.save();
    console.log(`Bootstrapped a supervisor account — username: ${username}  password: ${password}`);
    console.log('(set SUPERVISOR_USERNAME / SUPERVISOR_PASSWORD env vars to control these instead)');
  }
}

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()) : true }));
app.use(express.json());

app.get('/', (req, res) => res.json({ name: 'Rahlah API', status: 'ok' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcastCar(car) {
  const payload = JSON.stringify({ type: 'car_update', car });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(payload);
  });
}

function key(vehicleType, direction) {
  return `${vehicleType}_${direction}`;
}

function notifyCaptainsFor(vehicleType, direction, message) {
  const targetIds = Object.values(state.captains)
    .filter((c) => c.vehicleType === vehicleType && c.direction === direction)
    .map((c) => c.id);
  push.notifyCaptainIds(targetIds, message);
}

/* ---------- dispatch model ----------
 * Captains stay IDLE (no car) until something is actually ready for them:
 *   1. a private (whole-car) booking waiting in the queue, or
 *   2. a shared car that has already filled every seat, or
 *   3. a partial shared car whose captain-offer they accept.
 */

const PARTIAL_OFFER_WAIT_MS = 30 * 1000;
const OFFER_RESPONSE_TIMEOUT_MS = 25 * 1000;

function claimForCaptain(captain) {
  const k = key(captain.vehicleType, captain.direction);
  const queue = state.pendingPrivate[k] || [];
  while (queue.length) {
    const carId = queue.shift();
    const car = state.cars[carId];
    if (car && car.status === 'ready' && !car.captainId) return car;
  }
  const fullCar = Object.values(state.cars).find(
    (c) =>
      c.vehicleType === captain.vehicleType &&
      c.direction === captain.direction &&
      c.mode === 'shared' &&
      c.status === 'forming' &&
      !c.captainId &&
      seatsFilled(c) === totalSeats(c.vehicleType)
  );
  return fullCar || null;
}

function assignCarToCaptain(car, captain) {
  car.captainId = captain.id;
  car.captainName = captain.name;
  car.captainPlate = captain.plate;
  car.status = 'ready';
  captain.currentCarId = car.id;
}

function findOpenCarForBooking(vehicleType, direction, genders) {
  const candidates = Object.values(state.cars)
    .filter((c) => c.vehicleType === vehicleType && c.direction === direction && c.mode === 'shared' && c.status === 'forming')
    .sort((a, b) => seatsFilled(b) - seatsFilled(a));
  for (const car of candidates) {
    if (tryFitParty(car, genders)) return car;
  }
  return null;
}

function vehicleVacancy(vehicleType, direction) {
  const candidates = Object.values(state.cars)
    .filter((c) => c.vehicleType === vehicleType && c.direction === direction && c.mode === 'shared' && c.status === 'forming')
    .sort((a, b) => seatsFilled(b) - seatsFilled(a));
  if (!candidates.length) return null;
  const car = candidates[0];
  const openMen = car.front.filter((s) => s === null).length +
    car.rows.reduce((n, r) => n + (r.gender === null || r.gender === 'men' ? r.seats.filter((s) => s === null).length : 0), 0);
  const openWomen = car.rows.reduce((n, r) => n + (r.gender === null || r.gender === 'women' ? r.seats.filter((s) => s === null).length : 0), 0);
  const openTotal = totalSeats(vehicleType) - seatsFilled(car);
  return { carId: car.id, openMen, openWomen, openTotal };
}

function creditCustomersOnCompletion(car) {
  (car.bookings || []).forEach((b) => {
    const cust = state.customers[b.customerId];
    if (!cust) return;
    cust.tripHistory = cust.tripHistory || [];
    cust.tripHistory.unshift({
      carId: car.id,
      vehicleType: car.vehicleType,
      direction: car.direction,
      mode: car.mode,
      seats: Array.isArray(b.seats) ? b.seats.length : totalSeats(car.vehicleType),
      fare: b.fare,
      completedAt: car.completedAt,
    });
    if (cust.activeCarId === car.id) cust.activeCarId = null;
  });
}

/* ---------- background: offer partial cars to an idle captain ---------- */
setInterval(() => {
  const now = Date.now();
  let touched = false;
  Object.values(state.cars).forEach((car) => {
    if (car.mode !== 'shared' || car.status !== 'forming' || car.captainId) return;
    const filled = seatsFilled(car);
    if (filled === 0 || filled === totalSeats(car.vehicleType)) return;

    if (car.pendingOffer && now > car.pendingOffer.expiresAt) {
      car.declinedBy = car.declinedBy || [];
      car.declinedBy.push(car.pendingOffer.captainId);
      car.pendingOffer = null;
      touched = true;
    }
    if (car.pendingOffer) return;
    if (now - car.createdAt < PARTIAL_OFFER_WAIT_MS) return;

    const declined = car.declinedBy || [];
    const idleCaptain = Object.values(state.captains).find(
      (cap) => cap.status === 'online' && !cap.currentCarId && cap.vehicleType === car.vehicleType && cap.direction === car.direction && !declined.includes(cap.id)
    );
    if (idleCaptain) {
      car.pendingOffer = { captainId: idleCaptain.id, expiresAt: now + OFFER_RESPONSE_TIMEOUT_MS };
      touched = true;
      broadcastCar(car);
    } else if (!car.lastNoCaptainNotifyAt || now - car.lastNoCaptainNotifyAt > 60000) {
      car.lastNoCaptainNotifyAt = now;
      touched = true;
      notifyCaptainsFor(car.vehicleType, car.direction, {
        title: `${filled} passengers waiting for a ${VEHICLES[car.vehicleType].name}`,
        body: `No captain is online for this route right now — open Rahlah if you can take a partial car.`,
      });
    }
  });
  if (touched) db.save();
}, 5000);

/* ---------- public routes ---------- */

app.get('/api/vehicles', (req, res) => res.json(VEHICLES));
app.get('/api/points', (req, res) => res.json(POINTS));
app.get('/api/vacancies', (req, res) => {
  const { direction } = req.query;
  if (!['A_TO_B', 'B_TO_A'].includes(direction)) return res.status(400).json({ error: 'Unknown direction.' });
  const out = {};
  Object.keys(VEHICLES).forEach((vt) => (out[vt] = vehicleVacancy(vt, direction)));
  res.json(out);
});
app.get('/api/push/vapid-public-key', (req, res) => res.json({ publicKey: push.vapidPublicKey }));

/* ---------- customer accounts ---------- */

app.post('/api/customer/register', (req, res) => {
  const { phone, password, name, gender } = req.body || {};
  if (!phone || !password || !name) return res.status(400).json({ error: 'Phone, password, and name are required.' });
  if (!['men', 'women'].includes(gender)) return res.status(400).json({ error: 'Gender must be specified.' });
  if (customerAuth.findByLogin(phone)) return res.status(409).json({ error: 'An account with this phone number already exists.' });
  const id = randomUUID();
  const account = { id, phone, passwordHash: hashPassword(password), name, gender, activeCarId: null, tripHistory: [], createdAt: Date.now() };
  state.customers[id] = account;
  db.save();
  const token = customerAuth.createSession(id);
  res.json({ token, customer: customerAuth.toPublic(account) });
});

app.post('/api/customer/login', (req, res) => {
  const { phone, password } = req.body || {};
  const account = customerAuth.findByLogin(phone);
  if (!account || !checkPassword(password || '', account.passwordHash)) return res.status(401).json({ error: 'Incorrect phone or password.' });
  const token = customerAuth.createSession(account.id);
  const car = account.activeCarId ? state.cars[account.activeCarId] : null;
  res.json({ token, customer: customerAuth.toPublic(account), car });
});

app.get('/api/customer/me', customerAuth.requireAuth, (req, res) => {
  const car = req.account.activeCarId ? state.cars[req.account.activeCarId] : null;
  res.json({ customer: customerAuth.toPublic(req.account), car });
});

app.post('/api/book', customerAuth.requireAuth, (req, res) => {
  const { vehicleType, direction, party } = req.body || {};
  if (!VEHICLES[vehicleType]) return res.status(400).json({ error: 'Unknown vehicle type.' });
  if (!['A_TO_B', 'B_TO_A'].includes(direction)) return res.status(400).json({ error: 'Unknown direction.' });
  const men = Math.max(0, parseInt(party?.men ?? 0, 10));
  const women = Math.max(0, parseInt(party?.women ?? 0, 10));
  const genders = [...Array(men).fill('men'), ...Array(women).fill('women')];
  if (genders.length === 0) return res.status(400).json({ error: 'Add at least one passenger.' });
  if (genders.length > totalSeats(vehicleType)) {
    return res.status(409).json({ error: 'Your group is bigger than this vehicle. Try booking the whole car, or a bigger vehicle.' });
  }

  let car = findOpenCarForBooking(vehicleType, direction, genders);
  if (!car) {
    car = newCar({ id: randomUUID(), vehicleType, direction, mode: 'shared' });
    car.bookings = [];
    if (!tryFitParty(car, genders)) {
      return res.status(409).json({ error: "Your group doesn't fit together in one car right now — try booking the whole car instead." });
    }
    state.cars[car.id] = car;
  }
  car.bookings = car.bookings || [];

  const mySeats = seatParty(car, genders);
  car.bookings.push({ customerId: req.account.id, seats: mySeats, fare: genders.length * VEHICLES[vehicleType].price });
  req.account.activeCarId = car.id;

  if (seatsFilled(car) === totalSeats(vehicleType) && !car.captainId) {
    const idleCaptain = Object.values(state.captains).find(
      (cap) => cap.status === 'online' && !cap.currentCarId && cap.vehicleType === vehicleType && cap.direction === direction
    );
    if (idleCaptain) {
      assignCarToCaptain(car, idleCaptain);
    } else if (!car.notifiedFull) {
      car.notifiedFull = true;
      notifyCaptainsFor(vehicleType, direction, {
        title: `A full ${VEHICLES[vehicleType].name} is ready`,
        body: `${totalSeats(vehicleType)} passengers are waiting at the pickup zone — open Rahlah to accept.`,
      });
    }
  }

  db.save();
  broadcastCar(car);
  res.json({ carId: car.id, mySeats, fare: genders.length * VEHICLES[vehicleType].price, car });
});

app.post('/api/book/:carId/cancel', customerAuth.requireAuth, (req, res) => {
  const car = state.cars[req.params.carId];
  if (!car) return res.status(404).json({ error: 'Car not found.' });
  if (car.status !== 'forming') return res.status(409).json({ error: "This car already has a captain and can't be changed." });
  const seats = req.body?.seats;
  if (!Array.isArray(seats)) return res.status(400).json({ error: 'Missing seats to release.' });
  releaseSeats(car, seats);
  car.bookings = (car.bookings || []).filter((b) => b.customerId !== req.account.id);
  if (req.account.activeCarId === car.id) req.account.activeCarId = null;
  db.save();
  broadcastCar(car);
  res.json({ car });
});

app.post('/api/book-private', customerAuth.requireAuth, (req, res) => {
  const { vehicleType, direction } = req.body || {};
  if (!VEHICLES[vehicleType]) return res.status(400).json({ error: 'Unknown vehicle type.' });
  if (!['A_TO_B', 'B_TO_A'].includes(direction)) return res.status(400).json({ error: 'Unknown direction.' });

  const car = newCar({ id: randomUUID(), vehicleType, direction, mode: 'private' });
  car.bookings = [{ customerId: req.account.id, seats: 'ALL', fare: VEHICLES[vehicleType].fullPrice }];
  state.cars[car.id] = car;
  req.account.activeCarId = car.id;

  const idleCaptain = Object.values(state.captains).find(
    (cap) => cap.status === 'online' && !cap.currentCarId && cap.vehicleType === vehicleType && cap.direction === direction
  );
  if (idleCaptain) {
    assignCarToCaptain(car, idleCaptain);
  } else {
    const k = key(vehicleType, direction);
    state.pendingPrivate[k] = state.pendingPrivate[k] || [];
    state.pendingPrivate[k].push(car.id);
    notifyCaptainsFor(vehicleType, direction, {
      title: `A private ${VEHICLES[vehicleType].name} booking is waiting`,
      body: `Someone booked the whole car for ${VEHICLES[vehicleType].fullPrice} SAR — open Rahlah to accept.`,
    });
  }

  db.save();
  broadcastCar(car);
  res.json({ carId: car.id, fare: VEHICLES[vehicleType].fullPrice, car, captainAssigned: !!car.captainId });
});

app.get('/api/car/:id', (req, res) => {
  const car = state.cars[req.params.id];
  if (!car) return res.status(404).json({ error: 'Car not found.' });
  res.json(car);
});

/* ---------- captain accounts ---------- */

app.post('/api/captain/register', (req, res) => {
  const { phone, password, name, plate } = req.body || {};
  if (!phone || !password || !name || !plate) return res.status(400).json({ error: 'Phone, password, name, and plate are required.' });
  if (captainAuth.findByLogin(phone)) return res.status(409).json({ error: 'An account with this phone number already exists.' });
  const id = randomUUID();
  const account = {
    id, phone, passwordHash: hashPassword(password), name, plate,
    vehicleType: null, direction: null, status: 'offline', currentCarId: null,
    earnings: 0, tripHistory: [], location: null, createdAt: Date.now(),
  };
  state.captains[id] = account;
  db.save();
  const token = captainAuth.createSession(id);
  res.json({ token, captain: captainAuth.toPublic(account) });
});

app.post('/api/captain/login', (req, res) => {
  const { phone, password } = req.body || {};
  const account = captainAuth.findByLogin(phone);
  if (!account || !checkPassword(password || '', account.passwordHash)) return res.status(401).json({ error: 'Incorrect phone or password.' });
  const token = captainAuth.createSession(account.id);
  const car = account.currentCarId ? state.cars[account.currentCarId] : null;
  res.json({ token, captain: captainAuth.toPublic(account), car });
});

app.get('/api/captain/me', captainAuth.requireAuth, (req, res) => {
  const captain = req.account;
  const car = captain.currentCarId ? state.cars[captain.currentCarId] : null;
  const offerCar = !car ? Object.values(state.cars).find((c) => c.pendingOffer && c.pendingOffer.captainId === captain.id) : null;
  res.json({ captain: captainAuth.toPublic(captain), car, offer: offerCar });
});

app.post('/api/captain/online', captainAuth.requireAuth, (req, res) => {
  const { vehicleType, direction } = req.body || {};
  if (!VEHICLES[vehicleType]) return res.status(400).json({ error: 'Unknown vehicle type.' });
  if (!['A_TO_B', 'B_TO_A'].includes(direction)) return res.status(400).json({ error: 'Unknown direction.' });

  const captain = req.account;
  captain.vehicleType = vehicleType;
  captain.direction = direction;
  captain.status = 'online';
  captain.currentCarId = null;

  const car = claimForCaptain(captain);
  if (car) assignCarToCaptain(car, captain);

  db.save();
  if (car) broadcastCar(car);
  res.json({ captain: captainAuth.toPublic(captain), car: car || null });
});

app.post('/api/captain/offer/:carId/accept', captainAuth.requireAuth, (req, res) => {
  const car = state.cars[req.params.carId];
  if (!car) return res.status(404).json({ error: 'Car not found.' });
  if (!car.pendingOffer || car.pendingOffer.captainId !== req.account.id) return res.status(409).json({ error: 'This offer is no longer available.' });
  car.pendingOffer = null;
  assignCarToCaptain(car, req.account);
  db.save();
  broadcastCar(car);
  res.json({ car });
});

app.post('/api/captain/offer/:carId/decline', captainAuth.requireAuth, (req, res) => {
  const car = state.cars[req.params.carId];
  if (!car) return res.status(404).json({ error: 'Car not found.' });
  if (!car.pendingOffer || car.pendingOffer.captainId !== req.account.id) return res.status(409).json({ error: 'This offer is no longer available.' });
  car.declinedBy = car.declinedBy || [];
  car.declinedBy.push(req.account.id);
  car.pendingOffer = null;
  db.save();
  broadcastCar(car);
  res.json({ ok: true });
});

app.post('/api/captain/start-trip', captainAuth.requireAuth, (req, res) => {
  const car = state.cars[req.account.currentCarId];
  if (!car) return res.status(404).json({ error: 'No active car for this captain.' });
  car.status = 'in_trip';
  db.save();
  broadcastCar(car);
  res.json({ car });
});

app.post('/api/captain/complete-trip', captainAuth.requireAuth, (req, res) => {
  const captain = req.account;
  const car = state.cars[captain.currentCarId];
  if (!car) return res.status(404).json({ error: 'No active car for this captain.' });

  const fare = car.mode === 'private' ? VEHICLES[car.vehicleType].fullPrice : seatsFilled(car) * VEHICLES[car.vehicleType].price;
  car.status = 'completed';
  car.completedAt = Date.now();
  captain.earnings += fare;
  const tripRecord = {
    id: car.id, vehicleType: car.vehicleType, direction: car.direction, mode: car.mode,
    seats: car.mode === 'private' ? totalSeats(car.vehicleType) : seatsFilled(car),
    fare, completedAt: car.completedAt,
  };
  captain.tripHistory.unshift(tripRecord);
  state.trips.unshift(tripRecord);
  creditCustomersOnCompletion(car);
  captain.currentCarId = null;
  broadcastCar(car);

  const nextCar = claimForCaptain(captain);
  if (nextCar) assignCarToCaptain(nextCar, captain);

  db.save();
  if (nextCar) broadcastCar(nextCar);
  res.json({ trip: tripRecord, captain: captainAuth.toPublic(captain), car: nextCar || null });
});

app.post('/api/captain/offline', captainAuth.requireAuth, (req, res) => {
  const captain = req.account;
  const car = captain.currentCarId ? state.cars[captain.currentCarId] : null;
  if (car && car.status !== 'in_trip') {
    car.captainId = null;
    car.captainName = undefined;
    car.captainPlate = undefined;
    if (car.mode === 'shared') {
      car.status = 'forming';
    } else {
      const k = key(car.vehicleType, car.direction);
      state.pendingPrivate[k] = state.pendingPrivate[k] || [];
      state.pendingPrivate[k].push(car.id);
    }
    broadcastCar(car);
  }
  captain.status = 'offline';
  captain.currentCarId = null;
  db.save();
  res.json({ ok: true });
});

app.post('/api/captain/location', captainAuth.requireAuth, (req, res) => {
  const { lat, lng } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'lat and lng (numbers) are required.' });
  const captain = req.account;
  captain.location = { lat, lng, updatedAt: Date.now() };
  // Deliberately NOT calling db.save() here — GPS pings arrive every few
  // seconds per active captain, and this data is fine to lose on a restart
  // (the next ping repopulates it within seconds). Persisting every single
  // ping to Postgres would be pure write amplification for no real benefit.
  const car = captain.currentCarId ? state.cars[captain.currentCarId] : null;
  if (car) {
    car.captainLocation = captain.location;
    broadcastCar(car);
  }
  res.json({ ok: true });
});

app.post('/api/push/subscribe', captainAuth.requireAuth, (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription) return res.status(400).json({ error: 'Missing subscription.' });
  push.subscribe(req.account.id, subscription);
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', captainAuth.requireAuth, (req, res) => {
  push.unsubscribe(req.account.id);
  res.json({ ok: true });
});

/* ---------- supervisor (read-only) ---------- */

app.post('/api/supervisor/login', (req, res) => {
  const { username, password } = req.body || {};
  const account = supervisorAuth.findByLogin(username);
  if (!account || !checkPassword(password || '', account.passwordHash)) return res.status(401).json({ error: 'Incorrect username or password.' });
  const token = supervisorAuth.createSession(account.id);
  res.json({ token, supervisor: supervisorAuth.toPublic(account) });
});

app.get('/api/supervisor/overview', supervisorAuth.requireAuth, (req, res) => {
  res.json({
    now: Date.now(),
    vehicles: VEHICLES,
    cars: Object.values(state.cars),
    captains: Object.values(state.captains).map(captainAuth.toPublic),
    customersCount: Object.keys(state.customers).length,
    trips: state.trips.slice(0, 100),
    pendingPrivate: state.pendingPrivate,
    pushSubscriberCount: Object.keys(state.pushSubs || {}).length,
  });
});

wss.on('connection', () => {});

const PORT = process.env.PORT || 3000;

async function main() {
  await db.ready; // don't accept any traffic until real persisted state (if any) has loaded
  bootstrapSupervisorIfNeeded();
  server.listen(PORT, () => {
    console.log(`Rahlah backend API running → http://localhost:${PORT}`);
    console.log(`  This repo is API-only — customer.html/captain.html/supervisor.html`);
    console.log(`  live in their own repos and point RAHLAH_API_BASE at this server.`);
    console.log(`  Storage: ${db.isUsingPostgres() ? 'Postgres' : 'local JSON file (data/db.json) — set DATABASE_URL for real persistence'}`);
  });
}
main();
