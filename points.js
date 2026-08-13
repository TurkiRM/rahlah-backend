// Route points. `full` is for headers/labels with room to breathe; `short`
// is for compact spots (buttons, table cells). `lat`/`lng` are real
// coordinates.
const POINTS = {
  D: { full: 'Uhud', short: 'Uhud', lat: 24.50297555232552, lng: 39.61368069684083 },
  C: { full: 'Northern Central Region', short: 'Northern Central', lat: 24.474044564082376, lng: 39.61013880510328 },
  B: { full: 'Masjed Al-Ghamama', short: 'Al-Ghamama', lat: 24.44022821877946, lng: 39.61848679439748 },
  A: { full: "Masjed Quba'a", short: "Quba'a", lat: 24.465132784426007, lng: 39.607854517856794 },
  E: { full: 'Assalam Road', short: 'Assalam Road', lat: 24.467436017577214, lng: 39.604307696237136 },
  F: { full: 'Islamic University', short: 'Islamic Univ.', lat: 24.475763146496593, lng: 39.56653414670136 },
};

// Hub-and-spoke, not one shared line. A "hub" is a point that represents
// arriving at one of the two mosques — Quba'a is A; Masjid an-Nabawi is
// represented by three different access points around it rather than one
// canonical point: B (Al-Ghamama, Southern Central Region), C (Northern
// Central Region), and E (Assalam Road, Western Central Region). Every
// OTHER point is a "spoke" — a neighborhood or pickup area that only
// connects to whichever hub(s) it actually serves. There is deliberately no
// spoke-to-spoke booking (e.g. one neighborhood directly to another) — this
// app moves people to and from the mosques, not between arbitrary points.
const HUBS = ['A', 'B', 'C', 'E'];

// Fare tier between the hub points themselves — fixed per pair, since
// there are few of them and their real distances from each other don't
// reduce to a simple formula. (1 = near, 2 = medium, 3 = far — same tiers
// spokes use below.)
//
// B, C, and E are all "arrived at Nabawi" points — different access points
// around the same mosque, not separate destinations. A shared-car trip
// between two of them (a short walk around the same complex) doesn't make
// sense the way a Quba'a<->Nabawi-side trip (a genuine trip between two
// separate mosques) does. B-C is kept as an established route; E
// deliberately only connects hub-to-hub with A, not with B or C.
const HUB_HUB_TIER = {
  'A-B': 1,
  'A-C': 2,
  'B-C': 1,
  'A-E': 1,
};

// Each spoke lists which hub(s) it connects to and the fare tier for each —
// a spoke can be genuinely different distances from different hubs, so this
// is per (spoke, hub) pair, not one single "distance" per spoke. Uhud's
// tiers below are carried over unchanged from the old single-line model —
// same fares as before, just no longer expressed as hop-count along a line.
const SPOKES = {
  D: { A: 3, B: 2, C: 1 }, // Uhud: far from Quba'a, medium from Al-Ghamama, near Northern Central
  F: { A: 1, B: 1, C: 1, E: 1 }, // Islamic University: near every hub — a fast road connects it despite the straight-line distance looking longer
};

function isHub(id) {
  return HUBS.includes(id);
}

// Tier (1/2/3) between any two valid, connected points — hub-hub (fixed
// pair) or hub-spoke (looked up from that spoke's own tier list). Returns
// null for anything not actually connected: two different spokes, a point
// spoken of that doesn't exist, or a spoke that doesn't reach that hub.
function tierFor(pointA, pointB) {
  if (pointA === pointB) return null;
  if (isHub(pointA) && isHub(pointB)) {
    const key = [pointA, pointB].sort().join('-');
    return HUB_HUB_TIER[key] ?? null;
  }
  const hub = isHub(pointA) ? pointA : (isHub(pointB) ? pointB : null);
  if (!hub) return null; // neither is a hub — not a valid route
  const spoke = hub === pointA ? pointB : pointA;
  if (isHub(spoke)) return null; // shouldn't happen given the branch above, but stay safe
  const spokeTiers = SPOKES[spoke];
  return spokeTiers ? (spokeTiers[hub] ?? null) : null;
}

// Every ordered pair of points that actually has a defined tier is a valid
// bookable direction — hub-to-hub and hub-to-spoke, never spoke-to-spoke.
const DIRECTIONS = {};
const POINT_IDS = Object.keys(POINTS);
POINT_IDS.forEach((from) => {
  POINT_IDS.forEach((to) => {
    if (from === to) return;
    if (tierFor(from, to) === null) return;
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

// Whole-car (private booking) prices by tier — set per tier, not computed
// from a formula, unchanged from before.
const FULL_CAR_PRICE = {
  1: { sedan: 8,  family: 14, minibus: 14 },
  2: { sedan: 15, family: 21, minibus: 25 },
  3: { sedan: 15, family: 24, minibus: 25 },
};

// Per-seat price is a straight per-tier rate: 2 SAR/tier for sedan and
// family car, 1 SAR/tier for minibus — unchanged from before.
const SEAT_RATE_PER_TIER = { sedan: 2, family: 2, minibus: 1 };

// Returns { seat, full } for a vehicle type on a given direction, or null if
// the direction/vehicle combination doesn't have a defined fare.
function fareFor(vehicleType, direction) {
  const d = DIRECTIONS[direction];
  if (!d) return null;
  const tier = tierFor(d.from, d.to);
  const fullTier = FULL_CAR_PRICE[tier];
  const perTier = SEAT_RATE_PER_TIER[vehicleType];
  if (!tier || !fullTier || fullTier[vehicleType] === undefined || perTier === undefined) return null;
  return { seat: tier * perTier, full: fullTier[vehicleType] };
}

module.exports = {
  POINTS, HUBS, SPOKES, DIRECTIONS, isValidDirection, directionLabel, isHub, tierFor,
  FULL_CAR_PRICE, SEAT_RATE_PER_TIER, fareFor,
};
