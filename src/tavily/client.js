import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { fetchImageFromUrl, extensionForType } from '../mongo/imageBytes.js';

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
  const res = await fetch(`${API_BASE}/search`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Tavily ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  return res.json();
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
