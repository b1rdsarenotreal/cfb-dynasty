// Team logos. Primary source: the college football logo list at
// https://gist.github.com/saiemgilani/c6596f0e1c8b148daabc2b7f1e6f6add
// (ESPN logo URLs keyed by school and alternate names). It's fetched once and
// cached in this browser. Fallbacks: the logo CFBD returned for the team,
// then ESPN's URL pattern built from the team id.

const GIST_RAW = 'https://gist.githubusercontent.com/saiemgilani/c6596f0e1c8b148daabc2b7f1e6f6add/raw/logos';
const CACHE_KEY = 'cfb-logo-table-v1';
const MAX_AGE = 30 * 24 * 3600 * 1000;

let table = null; // lowercased name -> { light, dark, color, altColor }

const https = u => (u ? String(u).replace(/^http:\/\//i, 'https://') : null);
const norm = s => String(s || '').trim().toLowerCase();

export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(x => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some(x => x !== '')) rows.push(row); }
  return rows;
}

export function buildTable(csvText) {
  const [header, ...rows] = parseCSV(csvText);
  const col = name => header.findIndex(h => h.trim().toLowerCase() === name);
  const iSchool = col('school'), iLogo = col('logo'), iDark = col('logos[1]'), iColor = col('color'), iAlt = col('alt_color');
  const altCols = ['alt_name1', 'alt_name2', 'alt_name3', 'abbreviation'].map(col).filter(i => i >= 0);
  const out = {};
  for (const r of rows) {
    const entry = { light: https(r[iLogo]), dark: https(r[iDark]) || https(r[iLogo]), color: r[iColor] || null, altColor: r[iAlt] || null };
    if (!entry.light) continue;
    const school = norm(r[iSchool]);
    if (school) out[school] = entry;
    for (const i of altCols) { const k = norm(r[i]); if (k && !(k in out)) out[k] = entry; }
  }
  return out;
}

export async function loadLogoTable({ force = false } = {}) {
  if (table && !force) return table;
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (cached && !force && Date.now() - cached.at < MAX_AGE) return (table = cached.table);
  } catch { /* ignore */ }
  try {
    const res = await fetch(GIST_RAW);
    if (!res.ok) throw new Error(String(res.status));
    table = buildTable(await res.text());
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), table })); } catch { /* quota */ }
  } catch {
    table = table || {};
  }
  return table;
}

// Returns { light, dark } or null.
export function logoFor(name, team) {
  if (team?.logoOverride) return { light: https(team.logoOverride), dark: https(team.logoOverride) };
  const hit = table?.[norm(name)] || (team?.school && table?.[norm(team.school)]);
  if (hit) return hit;
  if (team?.logo) return { light: https(team.logo), dark: https(team.logoDark) || https(team.logo) };
  if (team?.id != null && team.id !== '') {
    return { light: `https://a.espncdn.com/i/teamlogos/ncaa/500/${team.id}.png`, dark: `https://a.espncdn.com/i/teamlogos/ncaa/500-dark/${team.id}.png` };
  }
  return null;
}
