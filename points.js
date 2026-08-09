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

// Fare by hop count. 1 hop = adjacent points, 2 hops = skip one point,
// 3 hops = the full line end-to-end ("Direct", Uhud <-> Quba'a only).
const FARE_TIERS = {
  1: { sedan: { seat: 2, full: 8 },  family: { seat: 2, full: 14 }, minibus: { seat: 1, full: 14 } },
  2: { sedan: { seat: 2, full: 15 }, family: { seat: 2, full: 21 }, minibus: { seat: 1, full: 25 } },
  3: { sedan: { seat: 4, full: 15 }, family: { seat: 4, full: 24 }, minibus: { seat: 2, full: 25 } },
};

// Returns { seat, full } for a vehicle type on a given direction, or null if
// the direction/vehicle combination doesn't have a defined fare.
function fareFor(vehicleType, direction) {
  const d = DIRECTIONS[direction];
  if (!d) return null;
  const hops = hopCount(d.from, d.to);
  const tier = FARE_TIERS[hops];
  if (!tier || !tier[vehicleType]) return null;
  return tier[vehicleType];
}

module.exports = { POINTS, LINE_ORDER, DIRECTIONS, isValidDirection, directionLabel, hopCount, FARE_TIERS, fareFor };
