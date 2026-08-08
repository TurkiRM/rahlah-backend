// The two ends of the route. `full` is for headers/labels with room to
// breathe; `short` is for compact spots (buttons, table cells). `lat`/`lng`
// are the coordinates originally provided when this route was set up —
// double check these against the real Masjed Quba'a / Masjed Al-Ghamama
// locations if you're not sure they still line up correctly.
//
// Direction codes ('A_TO_B' / 'B_TO_A') stay as internal identifiers even
// when these names change — nothing else in the app needs to know what the
// points are actually called, they just display whatever's here.
const POINTS = {
  A: { full: "Masjed Quba'a", short: "Quba'a", lat: 24.465132784426007, lng: 39.607854517856794 },
  B: { full: 'Masjed Al-Ghamama', short: 'Al-Ghamama', lat: 24.44022821877946, lng: 39.61848679439748 },
};

module.exports = { POINTS };
