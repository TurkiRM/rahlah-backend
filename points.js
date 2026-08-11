// Route points, laid out as a line — Uhud is one end, Quba'a is the other.
// `full` is for headers/labels with room to breathe; `short` is for compact
// spots (buttons, table cells). `lat`/`lng` are real coordinates.
const POINTS = {
  D: { full: 'Uhud', short: 'Uhud', lat: 24.50297555232552, lng: 39.61368069684083 },
  C: { full: 'Northern Central Region', short: 'Northern Central', lat: 24.474044564082376, lng: 39.61013880510328 },
  B: { full: 'Masjed Al-Ghamama', short: 'Al-Ghamama', lat: 24.44022821877946, lng: 39.61848679439748 },
  A: { full: "Masjed Quba'a", short: "Quba'a", lat: 24.465132784426007, lng: 39.607854517856794 },
};

// The physical order of the line, end to end: Uhud -> Northern Central ->
// Al-Ghamama -> Quba'a. Fare depends on how many hops apart two points are
// along this line, not on which specific pair it is — Northern Central to
// Quba'a (2 hops) costs the same as Uhud to Al-Ghamama (also 2 hops).
const LINE_ORDER = ['D', 'C', 'B', 'A'];

function hopCount(fromId, toId) {
  const i = LINE_ORDER.indexOf(fromId);
  const j = LINE_ORDER.indexOf(toId);
  if (i === -1 || j === -1) return null;
  return Math.abs(i - j);
}

// Every ordered pair of distinct points is a valid bookable route — you can
// go directly from any point to any other, you're just charged by distance.
// With 4 points that's 12 directions (D_TO_C, C_TO_D, D_TO_B, B_TO_D, ...).
const DIRECTIONS = {};
const POINT_IDS = Object.keys(POINTS);
POINT_IDS.forEach((from) => {
  POINT_IDS.forEach((to) => {
    if (from === to) return;
    DIRECTIONS[`${from}_TO_${to}`] = { from, to };
  });
});

function isValidDirection(direction) {
  return Object.prototype.hasOwnProperty.call(DIRECTIONS, direction);
}

function directionLabel(direction, useShort) {
  const d = DIRECTIONS[direction];
  if (!d) return direction;
  const from = useShort ? POINTS[d.from].short : POINTS[d.from].full;
  const to = useShort ? POINTS[d.to].short : POINTS[d.to].full;
  return `${from} → ${to}`;
}

// Whole-car (private booking) prices by hop count — unchanged from before,
// these are set per tier, not computed from a formula.
const FULL_CAR_PRICE = {
  1: { sedan: 8,  family: 14, minibus: 14 },
  2: { sedan: 15, family: 21, minibus: 25 },
  3: { sedan: 15, family: 24, minibus: 25 },
};

// Per-seat price is a straight per-hop rate: 2 SAR/hop for sedan and family
// car, 1 SAR/hop for minibus. Quba'a <-> Uhud (the full 3-hop line) is
// 3 x 2 = 6 SAR by car, 3 x 1 = 3 SAR by minibus — unlike the whole-car
// price, this genuinely scales with distance, no flat tiers.
const SEAT_RATE_PER_HOP = { sedan: 2, family: 2, minibus: 1 };

// Returns { seat, full } for a vehicle type on a given direction, or null if
// the direction/vehicle combination doesn't have a defined fare.
function fareFor(vehicleType, direction) {
  const d = DIRECTIONS[direction];
  if (!d) return null;
  const hops = hopCount(d.from, d.to);
  const fullTier = FULL_CAR_PRICE[hops];
  const perHop = SEAT_RATE_PER_HOP[vehicleType];
  if (!hops || !fullTier || fullTier[vehicleType] === undefined || perHop === undefined) return null;
  return { seat: hops * perHop, full: fullTier[vehicleType] };
}

module.exports = { POINTS, LINE_ORDER, DIRECTIONS, isValidDirection, directionLabel, hopCount, FULL_CAR_PRICE, SEAT_RATE_PER_HOP, fareFor };
