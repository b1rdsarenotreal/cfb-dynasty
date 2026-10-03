// Era rules. Every value here is only a default — the commissioner can override
// the postseason format and each conference's title game in Settings.

export const FORMATS = {
  BCS: 'BCS (1 vs 2 title game)',
  CFP4: 'College Football Playoff (4 teams)',
  CFP12: 'College Football Playoff (12 teams)',
  NONE: 'Bowls only, no title game',
};

export function defaultFormat(year) {
  if (year <= 2013) return 'BCS';
  if (year <= 2023) return 'CFP4';
  return 'CFP12';
}

// 12-team seeding: 2024 gave the top-4 seeds (byes) to the four highest-ranked
// conference champions; from 2025 on, seeds follow the rankings straight up.
export function defaultSeedByChampions(year) {
  return year === 2024;
}

// Number of conference champions guaranteed a 12-team spot.
export const CFP12_AUTO_BIDS = 5;

// Conferences that held a title game, by year range (inclusive; null = still active).
const CCG_YEARS = {
  'SEC': [[1992, null]],
  'Big 12': [[1996, 2010], [2017, null]],
  'Mid-American': [[1997, null]],
  'Western Athletic': [[1996, 1998]],
  'Conference USA': [[2005, null]],
  'ACC': [[2005, null]],
  'Big Ten': [[2011, null]],
  'Pac-12': [[2011, 2023]],
  'Mountain West': [[2013, null]],
  'American Athletic': [[2015, null]],
  'Sun Belt': [[2018, null]],
};

export function defaultHasCCG(conf, year) {
  const ranges = CCG_YEARS[conf];
  if (!ranges) return false;
  return ranges.some(([a, b]) => year >= a && (b === null || year <= b));
}

// Divisions decide title-game participants until 2024, when every
// conference switched to its top two teams.
export function defaultUseDivisions(year) {
  return year < 2024;
}

// BCS automatic-qualifier conferences (their champions earned BCS bowl bids).
export function bcsAQConferences(year) {
  const c = ['ACC', 'Big Ten', 'Big 12', 'Pac-10', 'Pac-12', 'SEC'];
  if (year <= 2012) c.push('Big East');
  if (year === 2013) c.push('American Athletic');
  return c;
}

// Rough prestige order used when auto-filling bowls; unknown bowls go after these.
export const BOWL_PRESTIGE = [
  'national championship', 'rose', 'sugar', 'orange', 'fiesta', 'cotton', 'peach',
  'citrus', 'outback', 'alamo', 'gator', 'holiday', 'las vegas', 'texas', 'music city',
  'sun', 'liberty', 'pinstripe', 'duke\'s mayo', 'belk', 'independence', 'cheez-it',
];

export function bowlRank(name = '') {
  const n = name.toLowerCase();
  const i = BOWL_PRESTIGE.findIndex(k => n.includes(k));
  return i === -1 ? BOWL_PRESTIGE.length : i;
}

// Default list of bowls for seasons with no API data (future years).
export const DEFAULT_BOWLS = [
  'Rose Bowl', 'Sugar Bowl', 'Orange Bowl', 'Fiesta Bowl', 'Cotton Bowl', 'Peach Bowl',
  'Citrus Bowl', 'Alamo Bowl', 'Gator Bowl', 'Holiday Bowl', 'Las Vegas Bowl', 'Texas Bowl',
  'Music City Bowl', 'Sun Bowl', 'Liberty Bowl', 'Pinstripe Bowl', 'Independence Bowl',
  'Armed Forces Bowl', 'Birmingham Bowl', 'Gasparilla Bowl', 'Military Bowl', 'Fenway Bowl',
  'Hawai\'i Bowl', 'Boca Raton Bowl', 'New Mexico Bowl', 'LA Bowl', 'Camellia Bowl',
  'Cure Bowl', 'Frisco Bowl', 'Myrtle Beach Bowl', 'Famous Idaho Potato Bowl',
  'New Orleans Bowl', 'First Responder Bowl', 'Guaranteed Rate Bowl', 'Arizona Bowl',
  'Bahamas Bowl',
];
