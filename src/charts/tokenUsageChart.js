import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fonts');
const RESVG_OPTIONS = {
  font: {
    fontFiles: [
      path.join(FONT_DIR, 'Inter-Regular.ttf'),
      path.join(FONT_DIR, 'Inter-SemiBold.ttf'),
      path.join(FONT_DIR, 'NotoSans-Regular.ttf'),
      path.join(FONT_DIR, 'NotoSans-SemiBold.ttf'),
      path.join(FONT_DIR, 'NotoSansMath-Regular.ttf'),
    ],
    loadSystemFonts: false,
    defaultFontFamily: 'Inter',
  },
};

const CHART_FONT_FAMILY =
  "Inter, 'Noto Sans', 'Noto Sans Math', Helvetica, Arial, sans-serif";

const COLORS = {
  anthropic_text: '#5b8def',
  anthropic_image_input: '#f5a623',
  gemini_image: '#7ed321',
  tool_tokens: '#5b8def',
  tool_invocations: '#9b51e0',
  section_system: '#5b8def',
  section_director_notes: '#e91e63',
  section_tools: '#f5a623',
  section_message_history: '#7ed321',
  section_user_input: '#bd10e0',
  axis: '#444',
  grid: '#e6e6e6',
  text: '#222',
  bg: '#ffffff',
};

const SECTION_ORDER = [
  'system',
  'director_notes',
  'tools',
  'message_history',
  'user_input',
];
const SECTION_LABELS = {
  system: 'System prompt',
  director_notes: "Director's notes",
  tools: 'Tool definitions',
  message_history: 'Message history',
  user_input: 'User input',
};
const SECTION_COLORS = {
  system: '#5b8def',
  director_notes: '#e91e63',
  tools: '#f5a623',
  message_history: '#7ed321',
  user_input: '#bd10e0',
};

const SEGMENT_ORDER = ['anthropic_text', 'anthropic_image_input', 'gemini_image'];
const SEGMENT_LABELS = {
  anthropic_text: 'Anthropic text (tokens)',
  anthropic_image_input: 'Anthropic image input (tokens)',
  gemini_image: 'Gemini image gen (tokens)',
};

const WINDOW_LABELS = {
  day: 'last 24 hours',
  week: 'last 7 days',
  month: 'last 30 days',
  total: 'all time',
};

const LABEL_FONT_SIZE = 12;
const LABEL_CHAR_PX = 6.6;
const LABEL_ASCENT = 10;
const LABEL_TOP_GAP = 8;
const LABEL_HORIZ_GAP = 6;
const LABEL_FOOTER_RESERVE = 24;
const LABEL_MIN_BOTTOM_MARGIN = 90;
const LABEL_MAX_BOTTOM_MARGIN = 200;
const LABEL_ANGLE_LADDER = [0, 25, 45, 60, 90];

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

function estimateTextWidth(text) {
  return String(text ?? '').length * LABEL_CHAR_PX;
}

function truncateLabelToWidth(text, maxPx) {
  const str = String(text ?? '');
  if (!str) return str;
  const maxChars = Math.max(2, Math.floor(maxPx / LABEL_CHAR_PX));
  if (str.length <= maxChars) return str;
  return `${str.slice(0, Math.max(1, maxChars - 1))}…`;
}

function pickLabelLayout({ names, slotWidth, heightBudget }) {
  if (!names.length || slotWidth <= 0) {
    return { angle: 0, truncated: names.slice(), verticalDrop: LABEL_FONT_SIZE };
  }
  const longestRawWidth = Math.max(0, ...names.map(estimateTextWidth));
  let angle = LABEL_ANGLE_LADDER[LABEL_ANGLE_LADDER.length - 1];
  for (const a of LABEL_ANGLE_LADDER) {
    const rad = (a * Math.PI) / 180;
    const footprint = longestRawWidth * Math.cos(rad) + LABEL_FONT_SIZE * Math.sin(rad);
    if (footprint <= slotWidth - LABEL_HORIZ_GAP) {
      angle = a;
      break;
    }
  }
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const widthCapFromSlot = cos > 0.01
    ? (slotWidth - LABEL_HORIZ_GAP - LABEL_FONT_SIZE * sin) / cos
    : Infinity;
  const widthCapFromHeight = sin > 0.01
    ? (heightBudget - LABEL_FONT_SIZE * cos) / sin
    : Infinity;
  const maxTextPx = Math.max(LABEL_CHAR_PX * 2, Math.min(widthCapFromSlot, widthCapFromHeight));
  const truncated = names.map((n) => truncateLabelToWidth(n, maxTextPx));
  const renderedMaxWidth = Math.max(0, ...truncated.map(estimateTextWidth));
  const verticalDrop = renderedMaxWidth * sin + LABEL_FONT_SIZE * cos;
  return { angle, truncated, verticalDrop };
}

function buildSvg({ window, rows }) {
  const width = Math.max(720, 120 + rows.length * 110);
  const height = 460;
  const margin = { top: 80, right: 30, bottom: LABEL_MIN_BOTTOM_MARGIN, left: 80 };
  const plotW = width - margin.left - margin.right;

  const maxTotal = Math.max(0, ...rows.map((r) => r.total));
  const yMax = niceCeil(maxTotal || 10);

  const numTicks = 5;
  const ticks = Array.from({ length: numTicks + 1 }, (_, i) => (yMax * i) / numTicks);

  const barWidth = rows.length ? Math.min(70, (plotW / rows.length) * 0.6) : 0;
  const slotWidth = rows.length ? plotW / rows.length : 0;

  const labelHeightBudget = LABEL_MAX_BOTTOM_MARGIN - LABEL_TOP_GAP - LABEL_FOOTER_RESERVE;
  const labelNames = rows.map((r) => String(r.discord_user_display_name || r.discord_user_id || ''));
  const layout = pickLabelLayout({
    names: labelNames,
    slotWidth,
    heightBudget: labelHeightBudget,
  });
  const desiredBottom = Math.ceil(LABEL_TOP_GAP + layout.verticalDrop + LABEL_FOOTER_RESERVE);
  margin.bottom = Math.min(
    LABEL_MAX_BOTTOM_MARGIN,
    Math.max(LABEL_MIN_BOTTOM_MARGIN, desiredBottom),
  );
  const plotH = height - margin.top - margin.bottom;

  const yToPx = (v) => margin.top + plotH - (v / yMax) * plotH;

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  );
  parts.push(`<rect width="${width}" height="${height}" fill="${COLORS.bg}"/>`);

  parts.push(
    `<text x="${width / 2}" y="30" font-family="${CHART_FONT_FAMILY}" ` +
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
      `<text x="${legendX + 20}" y="${legendY + 1}" font-family="${CHART_FONT_FAMILY}" ` +
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
      `<text x="${margin.left - 8}" y="${y + 4}" font-family="${CHART_FONT_FAMILY}" ` +
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
        `font-family="${CHART_FONT_FAMILY}" font-size="14" fill="${COLORS.text}" ` +
        `text-anchor="middle">No usage recorded in this window.</text>`,
    );
  }

  const axisY = margin.top + plotH;
  rows.forEach((row, i) => {
    const slotX = margin.left + i * slotWidth;
    const barX = slotX + (slotWidth - barWidth) / 2;
    const slotCenter = barX + barWidth / 2;
    let yCursor = axisY;
    for (const k of SEGMENT_ORDER) {
      const v = Number(row[k]) || 0;
      if (v <= 0) continue;
      const segH = (v / yMax) * plotH;
      yCursor -= segH;
      parts.push(
        `<rect x="${barX}" y="${yCursor}" width="${barWidth}" height="${segH}" fill="${COLORS[k]}"/>`,
      );
      if (segH >= 16) {
        const labelY = yCursor + segH / 2 + 4;
        parts.push(
          `<text x="${slotCenter}" y="${labelY}" font-family="${CHART_FONT_FAMILY}" ` +
            `font-size="10" font-weight="600" fill="#ffffff" text-anchor="middle">` +
            `${escapeXml(formatTokens(v))}</text>`,
        );
      }
    }

    const totalY = yToPx(row.total);
    parts.push(
      `<text x="${slotCenter}" y="${totalY - 6}" font-family="${CHART_FONT_FAMILY}" ` +
        `font-size="11" font-weight="600" fill="${COLORS.text}" text-anchor="middle">${escapeXml(formatTokens(row.total))}</text>`,
    );

    parts.push(
      `<line x1="${slotCenter}" y1="${axisY}" x2="${slotCenter}" y2="${axisY + 4}" ` +
        `stroke="${COLORS.axis}" stroke-width="1"/>`,
    );

    const label = layout.truncated[i] ?? '';
    if (label) {
      const anchorY = axisY + LABEL_TOP_GAP;
      const baselineY = anchorY + LABEL_ASCENT;
      const fontFamily = CHART_FONT_FAMILY;
      if (layout.angle === 0) {
        parts.push(
          `<text x="${slotCenter}" y="${baselineY}" font-family="${fontFamily}" ` +
            `font-size="${LABEL_FONT_SIZE}" fill="${COLORS.text}" text-anchor="middle">${escapeXml(label)}</text>`,
        );
      } else {
        parts.push(
          `<text x="${slotCenter}" y="${baselineY}" font-family="${fontFamily}" ` +
            `font-size="${LABEL_FONT_SIZE}" fill="${COLORS.text}" text-anchor="end" ` +
            `transform="rotate(${-layout.angle} ${slotCenter} ${anchorY})">${escapeXml(label)}</text>`,
        );
      }
    }
  });

  parts.push(
    `<text x="${margin.left}" y="${height - 12}" font-family="${CHART_FONT_FAMILY}" ` +
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
  const png = new Resvg(svg, RESVG_OPTIONS).render().asPng();
  const filename = `token-usage-${window}-${Date.now()}.png`;
  const filepath = path.join(os.tmpdir(), filename);
  await fs.writeFile(filepath, png);
  return filepath;
}

const TOP_N_TOOLS = 20;

function formatCount(n) {
  const v = Math.round(Number(n) || 0);
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

function buildSingleSeriesSvg({
  title,
  legendLabel,
  legendColor,
  rows,
  labelKey,
  valueKey,
  valueFormatter,
  totalToolCount,
  emptyMessage,
}) {
  const width = Math.max(720, 120 + rows.length * 110);
  const height = 460;
  const margin = { top: 80, right: 30, bottom: LABEL_MIN_BOTTOM_MARGIN, left: 80 };
  const plotW = width - margin.left - margin.right;

  const maxValue = Math.max(0, ...rows.map((r) => Number(r[valueKey]) || 0));
  const yMax = niceCeil(maxValue || 10);

  const numTicks = 5;
  const ticks = Array.from({ length: numTicks + 1 }, (_, i) => (yMax * i) / numTicks);

  const barWidth = rows.length ? Math.min(70, (plotW / rows.length) * 0.6) : 0;
  const slotWidth = rows.length ? plotW / rows.length : 0;

  const labelHeightBudget = LABEL_MAX_BOTTOM_MARGIN - LABEL_TOP_GAP - LABEL_FOOTER_RESERVE;
  const labelNames = rows.map((r) => String(r[labelKey] || ''));
  const layout = pickLabelLayout({
    names: labelNames,
    slotWidth,
    heightBudget: labelHeightBudget,
  });
  const desiredBottom = Math.ceil(LABEL_TOP_GAP + layout.verticalDrop + LABEL_FOOTER_RESERVE);
  margin.bottom = Math.min(
    LABEL_MAX_BOTTOM_MARGIN,
    Math.max(LABEL_MIN_BOTTOM_MARGIN, desiredBottom),
  );
  const plotH = height - margin.top - margin.bottom;

  const yToPx = (v) => margin.top + plotH - (v / yMax) * plotH;

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  );
  parts.push(`<rect width="${width}" height="${height}" fill="${COLORS.bg}"/>`);

  parts.push(
    `<text x="${width / 2}" y="30" font-family="${CHART_FONT_FAMILY}" ` +
      `font-size="20" font-weight="600" fill="${COLORS.text}" text-anchor="middle">` +
      `${escapeXml(title)}` +
      `</text>`,
  );

  const legendX = margin.left;
  const legendY = 52;
  parts.push(
    `<rect x="${legendX}" y="${legendY - 10}" width="14" height="14" fill="${legendColor}"/>`,
  );
  parts.push(
    `<text x="${legendX + 20}" y="${legendY + 1}" font-family="${CHART_FONT_FAMILY}" ` +
      `font-size="12" fill="${COLORS.text}">${escapeXml(legendLabel)}</text>`,
  );

  for (const t of ticks) {
    const y = yToPx(t);
    parts.push(
      `<line x1="${margin.left}" y1="${y}" x2="${margin.left + plotW}" y2="${y}" ` +
        `stroke="${COLORS.grid}" stroke-width="1"/>`,
    );
    parts.push(
      `<text x="${margin.left - 8}" y="${y + 4}" font-family="${CHART_FONT_FAMILY}" ` +
        `font-size="11" fill="${COLORS.text}" text-anchor="end">${escapeXml(valueFormatter(t))}</text>`,
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

  const axisY = margin.top + plotH;

  if (!rows.length) {
    parts.push(
      `<text x="${margin.left + plotW / 2}" y="${margin.top + plotH / 2}" ` +
        `font-family="${CHART_FONT_FAMILY}" font-size="14" fill="${COLORS.text}" ` +
        `text-anchor="middle">${escapeXml(emptyMessage)}</text>`,
    );
  }

  rows.forEach((row, i) => {
    const slotX = margin.left + i * slotWidth;
    const barX = slotX + (slotWidth - barWidth) / 2;
    const slotCenter = barX + barWidth / 2;
    const v = Number(row[valueKey]) || 0;
    if (v > 0) {
      const segH = (v / yMax) * plotH;
      const yTop = axisY - segH;
      parts.push(
        `<rect x="${barX}" y="${yTop}" width="${barWidth}" height="${segH}" fill="${legendColor}"/>`,
      );
      parts.push(
        `<text x="${slotCenter}" y="${yTop - 6}" font-family="${CHART_FONT_FAMILY}" ` +
          `font-size="11" font-weight="600" fill="${COLORS.text}" text-anchor="middle">` +
          `${escapeXml(valueFormatter(v))}</text>`,
      );
    }

    parts.push(
      `<line x1="${slotCenter}" y1="${axisY}" x2="${slotCenter}" y2="${axisY + 4}" ` +
        `stroke="${COLORS.axis}" stroke-width="1"/>`,
    );

    const label = layout.truncated[i] ?? '';
    if (label) {
      const anchorY = axisY + LABEL_TOP_GAP;
      const baselineY = anchorY + LABEL_ASCENT;
      const fontFamily = CHART_FONT_FAMILY;
      if (layout.angle === 0) {
        parts.push(
          `<text x="${slotCenter}" y="${baselineY}" font-family="${fontFamily}" ` +
            `font-size="${LABEL_FONT_SIZE}" fill="${COLORS.text}" text-anchor="middle">${escapeXml(label)}</text>`,
        );
      } else {
        parts.push(
          `<text x="${slotCenter}" y="${baselineY}" font-family="${fontFamily}" ` +
            `font-size="${LABEL_FONT_SIZE}" fill="${COLORS.text}" text-anchor="end" ` +
            `transform="rotate(${-layout.angle} ${slotCenter} ${anchorY})">${escapeXml(label)}</text>`,
        );
      }
    }
  });

  const showingCount = rows.length;
  const footer =
    totalToolCount > showingCount
      ? `Top ${showingCount} of ${totalToolCount} tools — X axis: tool names`
      : `X axis: tool names`;
  parts.push(
    `<text x="${margin.left}" y="${height - 12}" font-family="${CHART_FONT_FAMILY}" ` +
      `font-size="11" fill="${COLORS.text}">${escapeXml(footer)}</text>`,
  );

  parts.push(`</svg>`);
  return parts.join('');
}

export async function renderToolTokensChart({ window, rows }) {
  const all = Array.isArray(rows) ? rows : [];
  const sorted = all.slice().sort((a, b) => (b.result_tokens || 0) - (a.result_tokens || 0));
  const top = sorted.slice(0, TOP_N_TOOLS);
  const svg = buildSingleSeriesSvg({
    title: `Tool token consumption — ${WINDOW_LABELS[window] || window}`,
    legendLabel: 'Estimated tokens consumed by tool result payloads',
    legendColor: COLORS.tool_tokens,
    rows: top,
    labelKey: 'tool_name',
    valueKey: 'result_tokens',
    valueFormatter: formatTokens,
    totalToolCount: all.length,
    emptyMessage: 'No tool calls recorded in this window.',
  });
  const png = new Resvg(svg, RESVG_OPTIONS).render().asPng();
  const filename = `tool-tokens-${window}-${Date.now()}.png`;
  const filepath = path.join(os.tmpdir(), filename);
  await fs.writeFile(filepath, png);
  return filepath;
}

function buildSectionAllocationSvg({ window, sectionAverages, sampleCount }) {
  const width = 720;
  const height = 320;
  const margin = { top: 80, right: 40, bottom: 30, left: 40 };
  const plotW = width - margin.left - margin.right;
  const barTop = 90;
  const barHeight = 60;
  const legendTop = barTop + barHeight + 30;
  const legendRowHeight = 22;

  const total =
    Number(sectionAverages?.total) ||
    SECTION_ORDER.reduce((a, k) => a + (Number(sectionAverages?.[k]) || 0), 0);

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  );
  parts.push(`<rect width="${width}" height="${height}" fill="${COLORS.bg}"/>`);

  parts.push(
    `<text x="${width / 2}" y="32" font-family="${CHART_FONT_FAMILY}" ` +
      `font-size="20" font-weight="600" fill="${COLORS.text}" text-anchor="middle">` +
      `Prompt budget allocation — ${escapeXml(WINDOW_LABELS[window] || window)}` +
      `</text>`,
  );
  const subtitle =
    sampleCount > 0
      ? `Average per turn over ${sampleCount} turn${sampleCount === 1 ? '' : 's'}`
      : 'No section measurements recorded in this window.';
  parts.push(
    `<text x="${width / 2}" y="56" font-family="${CHART_FONT_FAMILY}" ` +
      `font-size="13" fill="${COLORS.text}" text-anchor="middle">${escapeXml(subtitle)}</text>`,
  );

  if (sampleCount === 0 || total <= 0) {
    parts.push(`</svg>`);
    return parts.join('');
  }

  let xCursor = margin.left;
  for (const k of SECTION_ORDER) {
    const v = Number(sectionAverages[k]) || 0;
    if (v <= 0) continue;
    const segW = (v / total) * plotW;
    parts.push(
      `<rect x="${xCursor}" y="${barTop}" width="${segW}" height="${barHeight}" fill="${SECTION_COLORS[k]}"/>`,
    );
    if (segW >= 50) {
      const pct = ((v / total) * 100).toFixed(0);
      parts.push(
        `<text x="${xCursor + segW / 2}" y="${barTop + barHeight / 2 - 2}" ` +
          `font-family="${CHART_FONT_FAMILY}" font-size="12" font-weight="600" ` +
          `fill="#ffffff" text-anchor="middle">${escapeXml(formatTokens(v))}</text>`,
      );
      parts.push(
        `<text x="${xCursor + segW / 2}" y="${barTop + barHeight / 2 + 14}" ` +
          `font-family="${CHART_FONT_FAMILY}" font-size="11" ` +
          `fill="#ffffff" text-anchor="middle">${pct}%</text>`,
      );
    }
    xCursor += segW;
  }

  parts.push(
    `<rect x="${margin.left}" y="${barTop}" width="${plotW}" height="${barHeight}" ` +
      `fill="none" stroke="${COLORS.axis}" stroke-width="1"/>`,
  );

  SECTION_ORDER.forEach((k, i) => {
    const v = Number(sectionAverages[k]) || 0;
    const pct = total > 0 ? ((v / total) * 100).toFixed(1) : '0.0';
    const rowY = legendTop + i * legendRowHeight;
    parts.push(
      `<rect x="${margin.left}" y="${rowY - 10}" width="14" height="14" fill="${SECTION_COLORS[k]}"/>`,
    );
    parts.push(
      `<text x="${margin.left + 22}" y="${rowY + 1}" font-family="${CHART_FONT_FAMILY}" ` +
        `font-size="12" fill="${COLORS.text}">${escapeXml(SECTION_LABELS[k])}</text>`,
    );
    parts.push(
      `<text x="${margin.left + plotW - 80}" y="${rowY + 1}" ` +
        `font-family="${CHART_FONT_FAMILY}" font-size="12" fill="${COLORS.text}" ` +
        `text-anchor="end">${escapeXml(formatTokens(v))} avg</text>`,
    );
    parts.push(
      `<text x="${margin.left + plotW}" y="${rowY + 1}" ` +
        `font-family="${CHART_FONT_FAMILY}" font-size="12" fill="${COLORS.text}" ` +
        `text-anchor="end">${pct}%</text>`,
    );
  });

  parts.push(`</svg>`);
  return parts.join('');
}

export async function renderSectionAllocationChart({ window, sectionStats }) {
  const sampleCount = Number(sectionStats?.sample_count) || 0;
  const averages = sectionStats?.averages || {};
  const svg = buildSectionAllocationSvg({
    window,
    sectionAverages: averages,
    sampleCount,
  });
  const png = new Resvg(svg, RESVG_OPTIONS).render().asPng();
  const filename = `section-allocation-${window}-${Date.now()}.png`;
  const filepath = path.join(os.tmpdir(), filename);
  await fs.writeFile(filepath, png);
  return filepath;
}

export async function renderToolInvocationsChart({ window, rows }) {
  const all = Array.isArray(rows) ? rows : [];
  const sorted = all.slice().sort((a, b) => (b.invocations || 0) - (a.invocations || 0));
  const top = sorted.slice(0, TOP_N_TOOLS);
  const svg = buildSingleSeriesSvg({
    title: `Tool invocation count — ${WINDOW_LABELS[window] || window}`,
    legendLabel: 'Tool invocation count',
    legendColor: COLORS.tool_invocations,
    rows: top,
    labelKey: 'tool_name',
    valueKey: 'invocations',
    valueFormatter: formatCount,
    totalToolCount: all.length,
    emptyMessage: 'No tool calls recorded in this window.',
  });
  const png = new Resvg(svg, RESVG_OPTIONS).render().asPng();
  const filename = `tool-invocations-${window}-${Date.now()}.png`;
  const filepath = path.join(os.tmpdir(), filename);
  await fs.writeFile(filepath, png);
  return filepath;
}
