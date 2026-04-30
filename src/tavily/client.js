import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { fetchImageFromUrl, extensionForType } from '../mongo/imageBytes.js';
import { logger } from '../log.js';

const API_BASE = 'https://api.tavily.com';

function authHeaders() {
  if (!config.tavily.apiKey) {
    throw new Error('TAVILY_API_KEY is not configured.');
  }
  return {
    Authorization: `Bearer ${config.tavily.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

export async function search(body) {
  const q = typeof body?.query === 'string' ? body.query : '';
  const qPreview = q.length > 60 ? `${q.slice(0, 59)}…` : q;
  logger.info(`tavily → q="${qPreview}"`);
  const t0 = Date.now();
  const res = await fetch(`${API_BASE}/search`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error(`tavily ← status=${res.status} ${ms}ms`);
    throw new Error(`Tavily ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const count = Array.isArray(data?.results) ? data.results.length : 0;
  logger.info(`tavily ← ${count} results ${ms}ms`);
  return data;
}

export async function fetchTavilyImageToTmp(url) {
  const { buffer, contentType } = await fetchImageFromUrl(url);
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  const ext = extensionForType(contentType);
  const dir = path.join(os.tmpdir(), 'screenplay-tavily');
  await fsp.mkdir(dir, { recursive: true });
  const filepath = path.join(dir, `${hash}.${ext}`);
  await fsp.writeFile(filepath, buffer);
  return { path: filepath, contentType };
}
