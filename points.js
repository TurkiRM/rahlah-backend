// Route points. Add more here as the service grows — every valid route
// between them is generated automatically below, so nothing else in the
// codebase needs to know how many points exist or what they're called.
//
// `full` is for headers/labels with room to breathe; `short` is for compact
// spots (buttons, table cells). `lat`/`lng` are real coordinates.
const POINTS = {
  A: { full: "Masjed Quba'a", short: "Quba'a", lat: 24.465132784426007, lng: 39.607854517856794 },
  B: { full: 'Masjed Al-Ghamama', short: 'Al-Ghamama', lat: 24.44022821877946, lng: 39.61848679439748 },
  C: { full: 'Northern Central Region', short: 'Northern Central', lat: 24.474044564082376, lng: 39.61013880510328 },
};

// Every ordered pair of distinct points becomes a valid "direction" — with
// the 3 points above that's 6 routes (A_TO_B, B_TO_A, A_TO_C, C_TO_A, B_TO_C,
// C_TO_B). Direction codes stay as internal identifiers built from the point
// keys above; nothing downstream needs to know the real-world names, they
// just look them up here for display.
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

// Convenience for building display labels from a direction code without
// every caller re-deriving from/to and doing its own POINTS lookups.
function directionLabel(direction, useShort) {
  const d = DIRECTIONS[direction];
  if (!d) return direction;
  const from = useShort ? POINTS[d.from].short : POINTS[d.from].full;
  const to = useShort ? POINTS[d.to].short : POINTS[d.to].full;
  return `${from} → ${to}`;
}

module.exports = { POINTS, DIRECTIONS, isValidDirection, directionLabel };
