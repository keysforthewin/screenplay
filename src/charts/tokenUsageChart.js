import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const COLORS = {
  anthropic_text: '#5b8def',
  anthropic_image_input: '#f5a623',
  gemini_image: '#7ed321',
  axis: '#444',
  grid: '#e6e6e6',
  text: '#222',
  bg: '#ffffff',
};

const SEGMENT_ORDER = ['anthropic_text', 'anthropic_image_input', 'gemini_image'];
const SEGMENT_LABELS = {
  anthropic_text: 'Anthropic text',
  anthropic_image_input: 'Anthropic image input',
  gemini_image: 'Gemini image gen',
};

const WINDOW_LABELS = {
  day: 'last 24 hours',
  week: 'last 7 days',
  month: 'last 30 days',
  total: 'all time',
};

function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function niceCeil(value) {
  if (value <= 0) return 10;
  const exp = Math.floor(Math.log10(value));
  const base = Math.pow(10, exp);
  const mantissa = value / base;
  let nice;
  if (mantissa <= 1) nice = 1;
  else if (mantissa <= 2) nice = 2;
  else if (mantissa <= 5) nice = 5;
  else nice = 10;
  return nice * base;
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function truncateLabel(s, max = 14) {
  const str = String(s || '');
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1)}…`;
}

function buildSvg({ window, rows }) {
  const width = Math.max(720, 120 + rows.length * 110);
  const height = 460;
  const margin = { top: 80, right: 30, bottom: 90, left: 80 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const maxTotal = Math.max(0, ...rows.map((r) => r.total));
  const yMax = niceCeil(maxTotal || 10);

  const numTicks = 5;
  const ticks = Array.from({ length: numTicks + 1 }, (_, i) => (yMax * i) / numTicks);

  const barWidth = rows.length ? Math.min(70, (plotW / rows.length) * 0.6) : 0;
  const slotWidth = rows.length ? plotW / rows.length : 0;

  const yToPx = (v) => margin.top + plotH - (v / yMax) * plotH;

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  );
  parts.push(`<rect width="${width}" height="${height}" fill="${COLORS.bg}"/>`);

  parts.push(
    `<text x="${width / 2}" y="30" font-family="Inter, Helvetica, Arial, sans-serif" ` +
      `font-size="20" font-weight="600" fill="${COLORS.text}" text-anchor="middle">` +
      `Token usage by user — ${escapeXml(WINDOW_LABELS[window] || window)}` +
      `</text>`,
  );

  let legendX = margin.left;
  const legendY = 52;
  for (const k of SEGMENT_ORDER) {
    parts.push(
      `<rect x="${legendX}" y="${legendY - 10}" width="14" height="14" fill="${COLORS[k]}"/>`,
    );
    parts.push(
      `<text x="${legendX + 20}" y="${legendY + 1}" font-family="Inter, Helvetica, Arial, sans-serif" ` +
        `font-size="12" fill="${COLORS.text}">${escapeXml(SEGMENT_LABELS[k])}</text>`,
    );
    legendX += 22 + SEGMENT_LABELS[k].length * 7 + 16;
  }

  for (const t of ticks) {
    const y = yToPx(t);
    parts.push(
      `<line x1="${margin.left}" y1="${y}" x2="${margin.left + plotW}" y2="${y}" ` +
        `stroke="${COLORS.grid}" stroke-width="1"/>`,
    );
    parts.push(
      `<text x="${margin.left - 8}" y="${y + 4}" font-family="Inter, Helvetica, Arial, sans-serif" ` +
        `font-size="11" fill="${COLORS.text}" text-anchor="end">${escapeXml(formatTokens(t))}</text>`,
    );
  }

  parts.push(
    `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" ` +
      `stroke="${COLORS.axis}" stroke-width="1"/>`,
  );
  parts.push(
    `<line x1="${margin.left}" y1="${margin.top + plotH}" x2="${margin.left + plotW}" ` +
      `y2="${margin.top + plotH}" stroke="${COLORS.axis}" stroke-width="1"/>`,
  );

  if (!rows.length) {
    parts.push(
      `<text x="${margin.left + plotW / 2}" y="${margin.top + plotH / 2}" ` +
        `font-family="Inter, Helvetica, Arial, sans-serif" font-size="14" fill="${COLORS.text}" ` +
        `text-anchor="middle">No usage recorded in this window.</text>`,
    );
  }

  rows.forEach((row, i) => {
    const slotX = margin.left + i * slotWidth;
    const barX = slotX + (slotWidth - barWidth) / 2;
    let yCursor = margin.top + plotH;
    for (const k of SEGMENT_ORDER) {
      const v = Number(row[k]) || 0;
      if (v <= 0) continue;
      const segH = (v / yMax) * plotH;
      yCursor -= segH;
      parts.push(
        `<rect x="${barX}" y="${yCursor}" width="${barWidth}" height="${segH}" fill="${COLORS[k]}"/>`,
      );
    }

    const totalY = yToPx(row.total);
    parts.push(
      `<text x="${barX + barWidth / 2}" y="${totalY - 6}" font-family="Inter, Helvetica, Arial, sans-serif" ` +
        `font-size="11" font-weight="600" fill="${COLORS.text}" text-anchor="middle">${escapeXml(formatTokens(row.total))}</text>`,
    );

    const labelY = margin.top + plotH + 18;
    const label = truncateLabel(row.discord_user_display_name || row.discord_user_id);
    parts.push(
      `<text x="${barX + barWidth / 2}" y="${labelY}" font-family="Inter, Helvetica, Arial, sans-serif" ` +
        `font-size="12" fill="${COLORS.text}" text-anchor="middle" transform="rotate(-25 ${barX + barWidth / 2} ${labelY})">${escapeXml(label)}</text>`,
    );
  });

  parts.push(
    `<text x="${margin.left}" y="${height - 12}" font-family="Inter, Helvetica, Arial, sans-serif" ` +
      `font-size="11" fill="${COLORS.text}">Y axis: tokens · stacked: ` +
      SEGMENT_ORDER.map((k) => SEGMENT_LABELS[k]).join(' + ') +
      `</text>`,
  );

  parts.push(`</svg>`);
  return parts.join('');
}

export async function renderTokenUsageChart({ window, rows }) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const svg = buildSvg({ window, rows: safeRows });
  const png = new Resvg(svg).render().asPng();
  const filename = `token-usage-${window}-${Date.now()}.png`;
  const filepath = path.join(os.tmpdir(), filename);
  await fs.writeFile(filepath, png);
  return filepath;
}
