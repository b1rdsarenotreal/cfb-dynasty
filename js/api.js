// CollegeFootballData.com (CFBD) API client — the same data source cfbfastR wraps.
// Get a free key at https://collegefootballdata.com/key

const BASE = 'https://api.collegefootballdata.com';

export class ApiError extends Error {}

export async function cfbd(path, params = {}, apiKey) {
  if (!apiKey) throw new ApiError('No CFBD API key set. Add one in Settings.');
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  ).toString();
  const url = `${BASE}${path}${qs ? '?' + qs : ''}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } });
  if (res.status === 401) throw new ApiError('CFBD rejected the API key (401). Check it in Settings.');
  if (res.status === 429) throw new ApiError('CFBD rate limit reached (429). Try again later.');
  if (!res.ok) throw new ApiError(`CFBD request failed: ${res.status} ${path}`);
  return res.json();
}

export const getFbsTeams = (year, key) => cfbd('/teams/fbs', { year }, key);
export const getGames = (year, seasonType, key) =>
  cfbd('/games', { year, seasonType, classification: 'fbs' }, key);
export const getRankings = (year, key) => cfbd('/rankings', { year, seasonType: 'regular' }, key);
