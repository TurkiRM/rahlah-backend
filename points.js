// The two ends of the route. `full` is for headers/labels with room to
// breathe; `short` is for compact spots (buttons, table cells).
//
// Direction codes ('A_TO_B' / 'B_TO_A') stay as internal identifiers even
// when these names change — nothing else in the app needs to know what the
// points are actually called, they just display whatever's here.
const POINTS = {
  A: { full: "Masjed Quba'a", short: "Quba'a" },
  B: { full: 'Masjed Al-Ghamama', short: 'Al-Ghamama' },
};

module.exports = { POINTS };
