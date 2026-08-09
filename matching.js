// Server-authoritative matching engine.
// This is the ONE place seat/gender rules live. Both the customer and captain
// apps only ever see the result of these functions over the API/WebSocket —
// neither app decides seating on its own anymore.
//
// Note: fares are NOT defined here anymore — with the route being a line of
// several points, price depends on the specific route (how many hops apart
// the two points are), not just the vehicle type. See points.js's fareFor().
// VEHICLES below only describes each vehicle's physical seat layout.

const VEHICLES = {
  sedan:   { name: 'Sedan',      icon: '🚗', frontSeats: 1, rows: 1, rowLabel: 'Back row' },
  family:  { name: 'Family car', icon: '🚙', frontSeats: 1, rows: 2, rowLabel: 'Row' },
  minibus: { name: 'Mini bus',   icon: '🚐', frontSeats: 2, rows: 4, rowLabel: 'Row' },
};

function totalSeats(vehicleType) {
  const cfg = VEHICLES[vehicleType];
  return cfg.frontSeats + cfg.rows * 3;
}

function newCar({ id, vehicleType, direction, mode }) {
  const cfg = VEHICLES[vehicleType];
  const car = {
    id,
    vehicleType,
    direction,
    mode, // 'shared' | 'private'
    status: 'forming', // forming -> ready -> in_trip -> completed
    captainId: null,
    front: Array.from({ length: cfg.frontSeats }, () => null),
    rows: Array.from({ length: cfg.rows }, () => ({ gender: null, seats: [null, null, null] })),
    createdAt: Date.now(),
  };
  if (mode === 'private') {
    car.front = car.front.map(() => 'private');
    car.rows.forEach((r) => {
      r.gender = 'private';
      r.seats = ['private', 'private', 'private'];
    });
    car.status = 'ready';
  }
  return car;
}

function seatsLeft(car) {
  let left = car.front.filter((s) => s === null).length;
  car.rows.forEach((r) => (left += r.seats.filter((s) => s === null).length));
  return left;
}

function seatsFilled(car) {
  const total = totalSeats(car.vehicleType);
  return total - seatsLeft(car);
}

// Attempts to seat one passenger. Mutates `car`. Returns the seat ref or null if no room.
function assignSeat(car, gender, wantFront) {
  if (wantFront && gender === 'men') {
    const idx = car.front.indexOf(null);
    if (idx !== -1) {
      car.front[idx] = 'men';
      return { type: 'front', idx };
    }
  }
  for (let i = 0; i < car.rows.length; i++) {
    const r = car.rows[i];
    if (r.gender === gender) {
      const idx = r.seats.indexOf(null);
      if (idx !== -1) {
        r.seats[idx] = gender;
        return { type: 'row', row: i, idx };
      }
    }
  }
  for (let i = 0; i < car.rows.length; i++) {
    const r = car.rows[i];
    if (r.gender === null) {
      r.gender = gender;
      r.seats[0] = gender;
      return { type: 'row', row: i, idx: 0 };
    }
  }
  return null;
}

// Dry-run: can this whole party (list of genders) fit in this car right now?
// Returns the seat refs it *would* get, without mutating the real car.
function tryFitParty(car, genders) {
  const clone = JSON.parse(JSON.stringify(car));
  const refs = [];
  for (const gender of genders) {
    const wantFront = gender === 'men';
    const ref = assignSeat(clone, gender, wantFront);
    if (!ref) return null; // doesn't fit
    refs.push(ref);
  }
  return refs;
}

// Actually commits a party into the real car (call only after tryFitParty succeeded,
// or accept the risk — used internally after a successful dry run).
function seatParty(car, genders) {
  const refs = [];
  for (const gender of genders) {
    const wantFront = gender === 'men';
    const ref = assignSeat(car, gender, wantFront);
    refs.push(Object.assign({ gender }, ref));
  }
  return refs;
}

// Frees seats a customer previously held (e.g. they're switching to a different
// vehicle type while still waiting). Mutates `car`. Reopens a row's gender lock
// if that row ends up completely empty again.
function releaseSeats(car, seatRefs) {
  seatRefs.forEach((ref) => {
    if (ref.type === 'front') {
      car.front[ref.idx] = null;
    } else if (ref.type === 'row') {
      const row = car.rows[ref.row];
      row.seats[ref.idx] = null;
      if (row.seats.every((s) => s === null)) row.gender = null;
    }
  });
}

module.exports = {
  VEHICLES,
  totalSeats,
  newCar,
  seatsLeft,
  seatsFilled,
  assignSeat,
  tryFitParty,
  seatParty,
  releaseSeats,
};
