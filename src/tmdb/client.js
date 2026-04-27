import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { fetchImageFromUrl, extensionForType } from '../mongo/imageBytes.js';

const API_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';
const IMAGE_HOST = 'image.tmdb.org';

function authHeaders() {
  if (!config.tmdb.readAccessToken) {
    throw new Error('TMDB_READ_ACCESS_TOKEN is not configured.');
  }
  return {
    Authorization: `Bearer ${config.tmdb.readAccessToken}`,
    Accept: 'application/json',
  };
}

async function tmdbFetch(pathname, params = {}) {
  const url = new URL(`${API_BASE}${pathname}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`TMDB ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

export async function searchMovie({ query, year } = {}) {
  if (!query || !query.trim()) throw new Error('searchMovie requires a query string.');
  return tmdbFetch('/search/movie', { query, year, include_adult: 'false' });
}

export async function getMovieDetails(movieId) {
  if (!movieId) throw new Error('getMovieDetails requires a movie_id.');
  return tmdbFetch(`/movie/${encodeURIComponent(movieId)}`, {
    append_to_response: 'credits',
  });
}

export async function getMovieCredits(movieId) {
  if (!movieId) throw new Error('getMovieCredits requires a movie_id.');
  return tmdbFetch(`/movie/${encodeURIComponent(movieId)}/credits`);
}

export async function searchPerson(query) {
  if (!query || !query.trim()) throw new Error('searchPerson requires a query string.');
  return tmdbFetch('/search/person', { query, include_adult: 'false' });
}

export async function getPerson(personId) {
  if (!personId) throw new Error('getPerson requires a person_id.');
  return tmdbFetch(`/person/${encodeURIComponent(personId)}`);
}

export function posterUrl(p, size = 'w500') {
  if (!p) return null;
  const prefix = p.startsWith('/') ? '' : '/';
  return `${IMAGE_BASE}/${size}${prefix}${p}`;
}

export function profileUrl(p, size = 'w500') {
  return posterUrl(p, size);
}

export async function findActorPortraitUrl(actorName) {
  if (!config.tmdb.readAccessToken) return { ok: false, reason: 'tmdb_not_configured' };
  if (!actorName || !actorName.trim()) return { ok: false, reason: 'empty_name' };
  let result;
  try {
    result = await searchPerson(actorName);
  } catch (e) {
    return { ok: false, reason: 'tmdb_error', message: e.message };
  }
  const hit = (result?.results || []).find((p) => p && p.profile_path);
  if (!hit) return { ok: false, reason: 'no_match' };
  return {
    ok: true,
    url: profileUrl(hit.profile_path),
    tmdb_person_id: hit.id,
    person_name: hit.name,
  };
}

export function isTmdbImageUrl(url) {
  try {
    return new URL(url).host === IMAGE_HOST;
  } catch {
    return false;
  }
}

export async function fetchTmdbImageToTmp(url) {
  if (!isTmdbImageUrl(url)) {
    throw new Error(`Refusing to fetch non-TMDB image URL: ${url}`);
  }
  const { buffer, contentType } = await fetchImageFromUrl(url);
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  const ext = extensionForType(contentType);
  const dir = path.join(os.tmpdir(), 'screenplay-tmdb');
  await fsp.mkdir(dir, { recursive: true });
  const filepath = path.join(dir, `${hash}.${ext}`);
  await fsp.writeFile(filepath, buffer);
  return { path: filepath, contentType };
}

export const TMDB_IMAGE_BASE = IMAGE_BASE;
