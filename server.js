const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024 } });

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
const files = require('./files');
const { hashPassword, checkPassword, makeAccountKit } = require('./auth');
const { POINTS, DIRECTIONS, isValidDirection, directionLabel, fareFor, LINE_ORDER, FARE_TIERS } = require('./points');

const state = db.state;
state.cars = state.cars || {};
state.trips = state.trips || [];
state.pendingPrivate = state.pendingPrivate || {};

/* ---------- accounts ---------- */

const captainAuth = makeAccountKit({
  accountsKey: 'captains',
  sessionsKey: 'captainSessions',
  loginField: 'phone',
  publicFields: [
    'id', 'phone', 'name',
    'vehicles', 'personalDocuments', 'personalDocumentsApproved', 'suspended',
    'vehicleType', 'currentPoint', 'status', 'currentCarId',
    'earnings', 'tripHistory', 'location', 'createdAt',
  ],
});
const customerAuth = makeAccountKit({
  accountsKey: 'customers',
  sessionsKey: 'customerSessions',
  loginField: 'phone',
  publicFields: ['id', 'phone', 'name', 'gender', 'activeCarId', 'tripHistory', 'accountStatus', 'createdAt'],
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

// Pending-private queue key. Keyed by (vehicle type, departure point) rather
// than a specific direction — a captain sitting at a point is available for
// ANY route departing from there, so all directions leaving that point share
// one queue.
function pointKey(vehicleType, pointId) {
  return `${vehicleType}_at_${pointId}`;
}

function notifyCaptainsFor(vehicleType, direction, message) {
  const d = DIRECTIONS[direction];
  if (!d) return;
  const targetIds = Object.values(state.captains)
    .filter((c) => c.vehicleType === vehicleType && c.currentPoint === d.from)
    .map((c) => c.id);
  push.notifyCaptainIds(targetIds, message);
}

/* ---------- dispatch model ----------
 * Captains stay IDLE (no car) until something is actually ready for them:
 *   1. a private (whole-car) booking waiting in the queue, or
 *   2. a shared car that has already filled every seat, or
 *   3. a partial shared car whose captain-offer they accept.
 *
 * A captain's availability is tracked by CURRENT POINT, not a fixed
 * direction — once free, they're eligible for any route departing from
 * wherever they physically are, not just the one route they originally
 * picked. See complete-trip below for how currentPoint updates.
 */

const PARTIAL_OFFER_WAIT_MS = 30 * 1000;
const OFFER_RESPONSE_TIMEOUT_MS = 25 * 1000;

function claimForCaptain(captain) {
  const k = pointKey(captain.vehicleType, captain.currentPoint);
  const queue = state.pendingPrivate[k] || [];
  while (queue.length) {
    const carId = queue.shift();
    const car = state.cars[carId];
    if (car && car.status === 'ready' && !car.captainId) return car;
  }
  const fullCar = Object.values(state.cars).find((c) => {
    const d = DIRECTIONS[c.direction];
    return (
      c.vehicleType === captain.vehicleType &&
      c.mode === 'shared' &&
      c.status === 'forming' &&
      !c.captainId &&
      seatsFilled(c) === totalSeats(c.vehicleType) &&
      d && d.from === captain.currentPoint
    );
  });
  return fullCar || null;
}

function assignCarToCaptain(car, captain) {
  const vehicle = captain.vehicles[car.vehicleType];
  car.captainId = captain.id;
  car.captainName = captain.name;
  car.captainPlate = vehicle ? vehicle.plate : '—';
  car.captainPhone = captain.phone;
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

// Finds an idle captain (online, no current car) sitting at the departure
// point of `direction`, driving `vehicleType`.
function findIdleCaptainFor(vehicleType, direction) {
  const d = DIRECTIONS[direction];
  if (!d) return null;
  return Object.values(state.captains).find(
    (cap) => cap.status === 'online' && !cap.currentCarId && cap.vehicleType === vehicleType && cap.currentPoint === d.from
  );
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
      startedAt: car.startedAt || null,
      completedAt: car.completedAt,
      // Captain identity on the customer's own record — who they actually rode with,
      // the core safety-relevant piece of a trip history.
      captainId: car.captainId || null,
      captainName: car.captainName || null,
      captainPlate: car.captainPlate || null,
      captainPhone: car.captainPhone || null,
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

    const d = DIRECTIONS[car.direction];
    const declined = car.declinedBy || [];
    const idleCaptain = d && Object.values(state.captains).find(
      (cap) => cap.status === 'online' && !cap.currentCarId && cap.vehicleType === car.vehicleType && cap.currentPoint === d.from && !declined.includes(cap.id)
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
app.get('/api/directions', (req, res) => res.json(DIRECTIONS));
app.get('/api/fare', (req, res) => {
  const { direction } = req.query;
  if (!isValidDirection(direction)) return res.status(400).json({ error: 'Unknown direction.' });
  const out = {};
  Object.keys(VEHICLES).forEach((vt) => (out[vt] = fareFor(vt, direction)));
  res.json(out);
});
app.get('/api/fare-tiers', (req, res) => {
  res.json({ lineOrder: LINE_ORDER, tiers: FARE_TIERS });
});
app.get('/api/vacancies', (req, res) => {
  const { direction } = req.query;
  if (!isValidDirection(direction)) return res.status(400).json({ error: 'Unknown direction.' });
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
  const account = { id, phone, passwordHash: hashPassword(password), name, gender, activeCarId: null, tripHistory: [], accountStatus: 'active', createdAt: Date.now() };
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
  if (req.account.accountStatus === 'suspended') return res.status(403).json({ error: 'Your account has been suspended. Contact support.' });
  const { vehicleType, direction, party } = req.body || {};
  if (!VEHICLES[vehicleType]) return res.status(400).json({ error: 'Unknown vehicle type.' });
  if (!isValidDirection(direction)) return res.status(400).json({ error: 'Unknown direction.' });
  const fare = fareFor(vehicleType, direction);
  if (!fare) return res.status(400).json({ error: 'No fare is defined for this route yet.' });
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
  const myFare = genders.length * fare.seat;
  car.bookings.push({ customerId: req.account.id, seats: mySeats, fare: myFare });
  req.account.activeCarId = car.id;

  if (seatsFilled(car) === totalSeats(vehicleType) && !car.captainId) {
    const idleCaptain = findIdleCaptainFor(vehicleType, direction);
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
  res.json({ carId: car.id, mySeats, fare: myFare, car });
});

app.post('/api/book/:carId/cancel', customerAuth.requireAuth, (req, res) => {
  const car = state.cars[req.params.carId];
  if (!car) return res.status(404).json({ error: 'Car not found.' });
  if (car.captainId) return res.status(409).json({ error: "A captain has already been matched to this car — it can't be cancelled from here." });
  if (car.status === 'in_trip' || car.status === 'completed') return res.status(409).json({ error: "This trip can't be cancelled anymore." });

  if (car.mode === 'private') {
    const d = DIRECTIONS[car.direction];
    const k = d ? pointKey(car.vehicleType, d.from) : null;
    if (k && state.pendingPrivate[k]) {
      state.pendingPrivate[k] = state.pendingPrivate[k].filter((id) => id !== car.id);
    }
    delete state.cars[car.id];
    if (req.account.activeCarId === car.id) req.account.activeCarId = null;
    db.save();
    return res.json({ cancelled: true });
  }

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
  if (req.account.accountStatus === 'suspended') return res.status(403).json({ error: 'Your account has been suspended. Contact support.' });
  const { vehicleType, direction } = req.body || {};
  if (!VEHICLES[vehicleType]) return res.status(400).json({ error: 'Unknown vehicle type.' });
  if (!isValidDirection(direction)) return res.status(400).json({ error: 'Unknown direction.' });
  const fare = fareFor(vehicleType, direction);
  if (!fare) return res.status(400).json({ error: 'No fare is defined for this route yet.' });

  const car = newCar({ id: randomUUID(), vehicleType, direction, mode: 'private' });
  car.bookings = [{ customerId: req.account.id, seats: 'ALL', fare: fare.full }];
  state.cars[car.id] = car;
  req.account.activeCarId = car.id;

  const idleCaptain = findIdleCaptainFor(vehicleType, direction);
  if (idleCaptain) {
    assignCarToCaptain(car, idleCaptain);
  } else {
    const d = DIRECTIONS[direction];
    const k = pointKey(vehicleType, d.from);
    state.pendingPrivate[k] = state.pendingPrivate[k] || [];
    state.pendingPrivate[k].push(car.id);
    notifyCaptainsFor(vehicleType, direction, {
      title: `A private ${VEHICLES[vehicleType].name} booking is waiting`,
      body: `Someone booked the whole car for ${fare.full} SAR — open Rahlah to accept.`,
    });
  }

  db.save();
  broadcastCar(car);
  res.json({ carId: car.id, fare: fare.full, car, captainAssigned: !!car.captainId });
});

app.get('/api/car/:id', (req, res) => {
  const car = state.cars[req.params.id];
  if (!car) return res.status(404).json({ error: 'Car not found.' });
  res.json(car);
});

/* ---------- captain accounts ---------- */

app.post('/api/captain/register', (req, res) => {
  const { phone, password, name, vehicleType, plate } = req.body || {};
  if (!phone || !password || !name || !vehicleType || !plate) {
    return res.status(400).json({ error: 'Phone, password, name, vehicle type, and plate are required.' });
  }
  if (!VEHICLES[vehicleType]) return res.status(400).json({ error: 'Unknown vehicle type.' });
  if (captainAuth.findByLogin(phone)) return res.status(409).json({ error: 'An account with this phone number already exists.' });
  const id = randomUUID();
  const account = {
    id, phone, passwordHash: hashPassword(password), name,
    vehicles: {
      [vehicleType]: {
        plate,
        documents: { vehicleRegistration: null, insurance: null, inspection: null },
        accountStatus: 'documents_needed',
        rejectionReason: null,
      },
    },
    personalDocuments: { license: null, photo: null },
    personalDocumentsApproved: false,
    suspended: false,
    vehicleType: null, currentPoint: null, status: 'offline', currentCarId: null,
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

// Add a second (or third) vehicle type to an existing captain account. Their
// license/photo are already on file — only this vehicle's own documents are
// needed before it can be driven.
app.post('/api/captain/vehicles', captainAuth.requireAuth, (req, res) => {
  const { vehicleType, plate } = req.body || {};
  if (!VEHICLES[vehicleType]) return res.status(400).json({ error: 'Unknown vehicle type.' });
  if (!plate) return res.status(400).json({ error: 'Plate is required.' });
  const captain = req.account;
  if (captain.vehicles[vehicleType]) return res.status(409).json({ error: 'You already have this vehicle type on your account.' });
  captain.vehicles[vehicleType] = {
    plate,
    documents: { vehicleRegistration: null, insurance: null, inspection: null },
    accountStatus: 'documents_needed',
    rejectionReason: null,
  };
  db.save();
  res.json({ captain: captainAuth.toPublic(captain) });
});

app.post('/api/captain/online', captainAuth.requireAuth, (req, res) => {
  const { vehicleType, currentPoint } = req.body || {};
  if (!VEHICLES[vehicleType]) return res.status(400).json({ error: 'Unknown vehicle type.' });
  if (!POINTS[currentPoint]) return res.status(400).json({ error: 'Unknown point.' });
  const captain = req.account;
  if (captain.suspended) return res.status(403).json({ error: 'Your account has been suspended. Contact support.' });
  const vehicle = captain.vehicles[vehicleType];
  if (!vehicle) return res.status(403).json({ error: `You haven't added a ${VEHICLES[vehicleType].name} to your account yet.` });
  if (vehicle.accountStatus !== 'active') {
    const messages = {
      documents_needed: `Upload your ${VEHICLES[vehicleType].name} documents before driving it.`,
      pending_review: `Your ${VEHICLES[vehicleType].name} documents are still being reviewed — you can't drive it yet.`,
      rejected: `Your ${VEHICLES[vehicleType].name} wasn't approved${vehicle.rejectionReason ? ': ' + vehicle.rejectionReason : '.'}`,
    };
    return res.status(403).json({ error: messages[vehicle.accountStatus] || 'This vehicle cannot go online right now.' });
  }

  captain.vehicleType = vehicleType;
  captain.currentPoint = currentPoint;
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
  car.startedAt = Date.now();
  db.save();
  broadcastCar(car);
  res.json({ car });
});

app.post('/api/captain/complete-trip', captainAuth.requireAuth, (req, res) => {
  const captain = req.account;
  const car = state.cars[captain.currentCarId];
  if (!car) return res.status(404).json({ error: 'No active car for this captain.' });

  const fareInfo = fareFor(car.vehicleType, car.direction);
  const fare = car.mode === 'private' ? fareInfo.full : seatsFilled(car) * fareInfo.seat;
  car.status = 'completed';
  car.completedAt = Date.now();
  captain.earnings += fare;

  const vehicle = captain.vehicles[car.vehicleType];
  // Passenger list on the CAPTAIN's own record — who was actually in the car, the
  // core safety-relevant piece if something needs to be looked into afterward.
  const passengers = (car.bookings || []).map((b) => {
    const cust = state.customers[b.customerId];
    return {
      customerId: b.customerId,
      name: cust ? cust.name : 'Unknown',
      phone: cust ? cust.phone : null,
      gender: cust ? cust.gender : null,
      seats: Array.isArray(b.seats) ? b.seats.length : totalSeats(car.vehicleType),
    };
  });

  const tripRecord = {
    id: car.id, vehicleType: car.vehicleType, direction: car.direction, mode: car.mode,
    seats: car.mode === 'private' ? totalSeats(car.vehicleType) : seatsFilled(car),
    fare, startedAt: car.startedAt || null, completedAt: car.completedAt,
    captainId: captain.id, captainName: captain.name, captainPlate: vehicle ? vehicle.plate : '—',
    passengers,
  };
  captain.tripHistory.unshift(tripRecord);
  state.trips.unshift(tripRecord);
  creditCustomersOnCompletion(car);
  captain.currentCarId = null;
  broadcastCar(car);

  // The captain is now physically at the trip's destination — move them there
  // so they're offered any route departing from where they actually are, not
  // just the reverse of the trip they just finished.
  const completedDir = DIRECTIONS[car.direction];
  if (completedDir) captain.currentPoint = completedDir.to;

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
      const d = DIRECTIONS[car.direction];
      const k = pointKey(car.vehicleType, d.from);
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

const VEHICLE_DOC_TYPES = ['vehicleRegistration', 'insurance', 'inspection'];
const PERSONAL_DOC_TYPES = ['license', 'photo'];
const DOC_UPLOAD_FIELDS = [...VEHICLE_DOC_TYPES, ...PERSONAL_DOC_TYPES].map((name) => ({ name, maxCount: 1 }));

app.post('/api/captain/documents', captainAuth.requireAuth, upload.fields(DOC_UPLOAD_FIELDS), async (req, res) => {
  const captain = req.account;
  const vehicleType = req.body.vehicleType;
  if (!vehicleType || !captain.vehicles[vehicleType]) return res.status(400).json({ error: 'Unknown vehicle for this account.' });
  const vehicle = captain.vehicles[vehicleType];
  try {
    for (const docType of VEHICLE_DOC_TYPES) {
      const fileArr = req.files && req.files[docType];
      if (!fileArr || !fileArr.length) continue;
      const file = fileArr[0];
      const oldId = vehicle.documents[docType];
      const newId = await files.saveDocument(captain.id, docType, file.mimetype, file.buffer);
      vehicle.documents[docType] = newId;
      if (oldId) files.deleteDocument(oldId).catch(() => {});
    }
    for (const docType of PERSONAL_DOC_TYPES) {
      const fileArr = req.files && req.files[docType];
      if (!fileArr || !fileArr.length) continue;
      const file = fileArr[0];
      const oldId = captain.personalDocuments[docType];
      const newId = await files.saveDocument(captain.id, docType, file.mimetype, file.buffer);
      captain.personalDocuments[docType] = newId;
      if (oldId) files.deleteDocument(oldId).catch(() => {});
    }
  } catch (err) {
    if (err.code === 'FILE_TOO_LARGE') return res.status(413).json({ error: err.message });
    console.error('Document upload failed:', err.message);
    return res.status(500).json({ error: 'Could not save one or more documents. Try again.' });
  }

  const vehicleDocsComplete = VEHICLE_DOC_TYPES.every((t) => vehicle.documents[t]);
  const personalDocsComplete = captain.personalDocumentsApproved || PERSONAL_DOC_TYPES.every((t) => captain.personalDocuments[t]);
  if (vehicleDocsComplete && personalDocsComplete && (vehicle.accountStatus === 'documents_needed' || vehicle.accountStatus === 'rejected')) {
    vehicle.accountStatus = 'pending_review';
    vehicle.rejectionReason = null;
  }
  db.save();
  res.json({ captain: captainAuth.toPublic(captain) });
});

app.get('/api/captain/document/:scope/:docType', captainAuth.requireAuth, async (req, res) => {
  const { scope, docType } = req.params;
  const captain = req.account;
  const fileId = scope === 'personal' ? captain.personalDocuments[docType] : (captain.vehicles[scope] && captain.vehicles[scope].documents[docType]);
  if (!fileId) return res.status(404).json({ error: 'Not uploaded yet.' });
  const doc = await files.getDocument(fileId);
  if (!doc) return res.status(404).json({ error: 'File not found.' });
  res.set('Content-Type', doc.mimeType);
  res.send(doc.data);
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

/* ---------- supervisor: monitoring + account moderation ---------- */

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
    customers: Object.values(state.customers).map(customerAuth.toPublic),
    trips: state.trips.slice(0, 100),
    pendingPrivate: state.pendingPrivate,
    pushSubscriberCount: Object.keys(state.pushSubs || {}).length,
  });
});

// Document images/PDFs are viewed via <img>/<a> tags in the dashboard, which
// can't send an Authorization header — so this one endpoint accepts the
// session token as a query param instead. Everything else stays header-only.
app.get('/api/supervisor/document/:captainId/:scope/:docType', async (req, res) => {
  const account = supervisorAuth.validateSession(req.query.token || '');
  if (!account) return res.status(401).json({ error: 'Not authenticated.' });
  const captain = state.captains[req.params.captainId];
  if (!captain) return res.status(404).json({ error: 'Captain not found.' });
  const { scope, docType } = req.params;
  const fileId = scope === 'personal' ? captain.personalDocuments[docType] : (captain.vehicles[scope] && captain.vehicles[scope].documents[docType]);
  if (!fileId) return res.status(404).json({ error: 'Not uploaded.' });
  const doc = await files.getDocument(fileId);
  if (!doc) return res.status(404).json({ error: 'File not found.' });
  res.set('Content-Type', doc.mimeType);
  res.send(doc.data);
});

app.post('/api/supervisor/captain/:id/vehicle/:vehicleType/approve', supervisorAuth.requireAuth, (req, res) => {
  const captain = state.captains[req.params.id];
  if (!captain) return res.status(404).json({ error: 'Captain not found.' });
  const vehicle = captain.vehicles[req.params.vehicleType];
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found on this account.' });
  if (vehicle.accountStatus !== 'pending_review') return res.status(409).json({ error: 'This vehicle is not awaiting review.' });
  vehicle.accountStatus = 'active';
  vehicle.rejectionReason = null;
  captain.personalDocumentsApproved = true; // license/photo verified as part of this approval
  db.save();
  res.json({ captain: captainAuth.toPublic(captain) });
});

app.post('/api/supervisor/captain/:id/vehicle/:vehicleType/reject', supervisorAuth.requireAuth, (req, res) => {
  const captain = state.captains[req.params.id];
  if (!captain) return res.status(404).json({ error: 'Captain not found.' });
  const vehicle = captain.vehicles[req.params.vehicleType];
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found on this account.' });
  if (vehicle.accountStatus !== 'pending_review') return res.status(409).json({ error: 'This vehicle is not awaiting review.' });
  vehicle.accountStatus = 'rejected';
  vehicle.rejectionReason = (req.body && req.body.reason) || 'Documents did not meet requirements.';
  db.save();
  res.json({ captain: captainAuth.toPublic(captain) });
});

app.post('/api/supervisor/captain/:id/suspend', supervisorAuth.requireAuth, (req, res) => {
  const captain = state.captains[req.params.id];
  if (!captain) return res.status(404).json({ error: 'Captain not found.' });
  captain.suspended = true;
  const car = captain.currentCarId ? state.cars[captain.currentCarId] : null;
  if (car && car.status !== 'in_trip') {
    car.captainId = null; car.captainName = undefined; car.captainPlate = undefined;
    if (car.mode === 'shared') car.status = 'forming';
    broadcastCar(car);
  }
  captain.status = 'offline';
  captain.currentCarId = null;
  db.save();
  res.json({ captain: captainAuth.toPublic(captain) });
});

app.post('/api/supervisor/captain/:id/reactivate', supervisorAuth.requireAuth, (req, res) => {
  const captain = state.captains[req.params.id];
  if (!captain) return res.status(404).json({ error: 'Captain not found.' });
  if (!captain.suspended) return res.status(409).json({ error: 'This captain is not suspended.' });
  captain.suspended = false;
  db.save();
  res.json({ captain: captainAuth.toPublic(captain) });
});

app.post('/api/supervisor/customer/:id/suspend', supervisorAuth.requireAuth, (req, res) => {
  const customer = state.customers[req.params.id];
  if (!customer) return res.status(404).json({ error: 'Customer not found.' });
  customer.accountStatus = 'suspended';
  db.save();
  res.json({ customer: customerAuth.toPublic(customer) });
});

app.post('/api/supervisor/customer/:id/reactivate', supervisorAuth.requireAuth, (req, res) => {
  const customer = state.customers[req.params.id];
  if (!customer) return res.status(404).json({ error: 'Customer not found.' });
  customer.accountStatus = 'active';
  db.save();
  res.json({ customer: customerAuth.toPublic(customer) });
});

wss.on('connection', () => {});

const PORT = process.env.PORT || 3000;

// Converts an account created before multi-vehicle support existed (a flat
// plate/documents/accountStatus on the captain itself) into the new
// vehicles-map shape. Existing approved captains keep driving what they were
// already approved for — this is a data-shape migration, not a re-review.
function migrateLegacyCaptainToVehicles(cap) {
  if (cap.vehicles) return;
  const vehicleType = cap.vehicleType || 'sedan';
  const wasActive = cap.accountStatus === 'active' || cap.accountStatus === 'suspended';
  cap.vehicles = {
    [vehicleType]: {
      plate: cap.plate || '—',
      documents: {
        vehicleRegistration: (cap.documents && cap.documents.vehicleRegistration) || null,
        insurance: (cap.documents && cap.documents.insurance) || null,
        inspection: (cap.documents && cap.documents.inspection) || null,
      },
      accountStatus: wasActive ? 'active' : (cap.accountStatus || 'active'),
      rejectionReason: cap.rejectionReason || null,
    },
  };
  cap.personalDocuments = {
    license: (cap.documents && cap.documents.license) || null,
    photo: (cap.documents && cap.documents.photo) || null,
  };
  cap.personalDocumentsApproved = wasActive;
  cap.suspended = cap.accountStatus === 'suspended';
  cap.currentPoint = (cap.direction && DIRECTIONS[cap.direction]) ? DIRECTIONS[cap.direction].from : null;
  delete cap.plate;
  delete cap.documents;
  delete cap.accountStatus;
  delete cap.rejectionReason;
  delete cap.direction;
}

// Backfills fields onto accounts created before a given feature existed.
// Existing accounts are treated as already trustworthy, not re-gated behind
// a review they were never asked for.
function backfillLegacyAccounts() {
  let touched = false;
  Object.values(state.captains).forEach((cap) => {
    if (!cap.vehicles) { migrateLegacyCaptainToVehicles(cap); touched = true; }
    if (cap.location === undefined) { cap.location = null; touched = true; }
  });
  Object.values(state.customers).forEach((cust) => {
    if (cust.accountStatus === undefined) { cust.accountStatus = 'active'; touched = true; }
    if (cust.activeCarId === undefined) { cust.activeCarId = null; touched = true; }
  });
  if (touched) {
    console.log('Backfilled missing fields on one or more legacy accounts.');
    db.save();
  }
}

async function main() {
  await db.ready; // don't accept any traffic until real persisted state (if any) has loaded
  backfillLegacyAccounts();
  bootstrapSupervisorIfNeeded();
  server.listen(PORT, () => {
    console.log(`Rahlah backend API running → http://localhost:${PORT}`);
    console.log(`  This repo is API-only — customer.html/captain.html/supervisor.html`);
    console.log(`  live in their own repos and point RAHLAH_API_BASE at this server.`);
    console.log(`  Storage: ${db.isUsingPostgres() ? 'Postgres' : 'local JSON file (data/db.json) — set DATABASE_URL for real persistence'}`);
  });
}
main();
