#!/usr/bin/env node
/**
 * Cluster fal.ai video models by input-capability bitmap and emit the
 * SPA-facing catalog manifest.
 *
 * Reads:  scripts/output/fal-video-models.csv  (output of list-fal-video-models.js)
 * Writes: scripts/output/fal-video-clusters.csv  (per-model flags + max length)
 *         scripts/output/fal-video-clusters.md   (grouped report)
 *         data/fal-models.json                    (runtime catalog for the model selector)
 *
 * Capabilities (5-bit bitmap): start_frame, end_frame, reference_images,
 * character_sheet, lip_sync (avatar style only).
 *
 * Filters to image-to-video category and drops rows with no detected
 * capability before emitting (those models can't be plumbed without a
 * known input shape).
 *
 * Usage: node scripts/cluster-fal-video-models.js
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const IN_PATH = 'scripts/output/fal-video-models.csv';
const OUT_CSV = 'scripts/output/fal-video-clusters.csv';
const OUT_MD = 'scripts/output/fal-video-clusters.md';
const OUT_JSON = 'data/fal-models.json';

const CAP_KEYS = ['start_frame', 'end_frame', 'reference_images', 'character_sheet', 'lip_sync'];
const CAP_LABELS = { start_frame: 'start', end_frame: 'end', reference_images: 'ref', character_sheet: 'char', lip_sync: 'lip' };

// ---------- CSV parsing ----------

function parseCsv(text) {
  // Tolerant RFC4180 parser: quoted fields, doubled "" escapes, commas inside quotes, embedded newlines (we don't emit them but be safe).
  const rows = [];
  let row = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c === '\r') { /* skip */ }
      else cur += c;
    }
  }
  if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row); }
  // Drop trailing empty row from a final newline.
  while (rows.length && rows.at(-1).length === 1 && rows.at(-1)[0] === '') rows.pop();
  const header = rows.shift();
  return rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function tryJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function csvCell(v) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : String(v);
  return `"${s.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

// ---------- capability detection ----------

const START_NAMES = new Set([
  'image_url', 'first_frame_url', 'start_image_url', 'first_image_url',
  'first_frame_image_url', 'start_frame', 'source_image_url', 'input_image_url',
]);
const END_NAMES = new Set([
  'end_image_url', 'last_frame_url', 'tail_image_url', 'end_frame', 'last_image_url',
]);
const REFERENCE_NAMES = new Set([
  'image_urls', 'ref_image_urls', 'reference_image_urls', 'input_image_urls',
  'reference_image_url', 'image_references', 'reference_video_urls',
]);
const CHARACTER_NAMES = new Set([
  'character', 'character_ids', 'character_orientation', 'multi_character',
  'subject_reference_image_url', 'character_image', 'character_sheet',
]);
const AUDIO_NAMES = new Set([
  'audio_url', 'audio_urls', 'driven_audio_url', 'audio_input',
  'voice_url', 'speech_url', 'first_audio_url', 'reference_audio_url',
  'second_audio_url', 'audio_file',
]);
const VIDEO_INPUT_NAMES = new Set([
  'video_url', 'source_video_url', 'mask_video_url', 'videos', 'video',
  'driving_video_url', 'reference_pose_video_url',
]);

function allParams(row) {
  const merged = {};
  for (const col of ['required_params', 'optional_params']) {
    const obj = tryJson(row[col]);
    if (obj && typeof obj === 'object') Object.assign(merged, obj);
  }
  return merged;
}

function detectCapabilities(row, params) {
  const names = new Set(Object.keys(params));
  const hasAny = (set) => [...names].some(n => set.has(n));
  const hasStart = hasAny(START_NAMES);
  const hasEnd = hasAny(END_NAMES);
  const hasRef = hasAny(REFERENCE_NAMES);
  const hasChar = hasAny(CHARACTER_NAMES);
  const hasAudio = hasAny(AUDIO_NAMES);
  const hasVideoInput = hasAny(VIDEO_INPUT_NAMES);
  return {
    start_frame: hasStart,
    end_frame: hasEnd,
    reference_images: hasRef,
    character_sheet: hasChar,
    lip_sync: hasAudio && !hasVideoInput, // avatar-only
  };
}

// ---------- max clip length ----------

function numericEnumMax(values) {
  const nums = [];
  for (const v of values) {
    if (v === 'auto' || v === null) continue;
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (Number.isFinite(n)) nums.push(n);
  }
  return nums.length ? Math.max(...nums) : null;
}

function round1(n) { return Math.round(n * 10) / 10; }

function computeMaxSeconds(params) {
  const duration = params.duration;
  if (duration) {
    if (Array.isArray(duration.enum)) {
      const m = numericEnumMax(duration.enum);
      if (m != null) return { max: round1(m), source: 'duration_enum' };
    }
    if (typeof duration.maximum === 'number') {
      return { max: round1(duration.maximum), source: 'duration_max' };
    }
    if (typeof duration.default === 'number') {
      return { max: round1(duration.default), source: 'duration_default' };
    }
  }
  const numFrames = params.num_frames;
  const fpsParam = params.fps || params.frames_per_second;
  const fpsDefault =
    (fpsParam && typeof fpsParam.default === 'number') ? fpsParam.default :
    (fpsParam && Array.isArray(fpsParam.enum) ? numericEnumMax(fpsParam.enum) : null) || 24;
  if (numFrames) {
    if (typeof numFrames.maximum === 'number') {
      return { max: round1(numFrames.maximum / fpsDefault), source: 'frames/fps' };
    }
    if (typeof numFrames.default === 'number') {
      return { max: round1(numFrames.default / fpsDefault), source: 'frames_default/fps' };
    }
  }
  return { max: 'unknown', source: 'unknown' };
}

// ---------- resolution / aspect ratio / price / durations ----------

function extractResolutions(params) {
  const r = params.resolution;
  if (r && Array.isArray(r.enum)) return r.enum.map(String);
  const vs = params.video_size;
  if (vs && Array.isArray(vs.enum)) return vs.enum.map(String);
  return [];
}

function extractAspectRatios(params) {
  const ar = params.aspect_ratio;
  if (ar && Array.isArray(ar.enum)) return ar.enum.map(String);
  return [];
}

function extractDurationsEnum(params) {
  const d = params.duration;
  if (d && Array.isArray(d.enum)) return d.enum.map(String);
  return [];
}

// "$0.35 per second … $1.40 for a 5s clip" → 0.35 (the cheapest unit price
// the markdown mentions). Best-effort regex; falls back to null when nothing
// parseable shows up. The full markdown is kept verbatim in price_text.
function extractPriceMinUsd(text) {
  if (typeof text !== 'string' || !text) return null;
  const matches = [...text.matchAll(/\$(\d+(?:\.\d+)?)/g)].map(m => parseFloat(m[1]));
  const valid = matches.filter(n => Number.isFinite(n) && n > 0);
  if (!valid.length) return null;
  return Math.min(...valid);
}

function supportsGenerateAudio(params) {
  // The presence of a `generate_audio` param means the model can synthesize
  // audio from the prompt itself (Kling 3 Pro, Veo 3.1, Wan 2.7…).
  return Object.prototype.hasOwnProperty.call(params, 'generate_audio');
}

// Compute the registry-shape `inputs` object for a catalog model so the SPA
// dialog can use the same validation plumbing it already uses for the
// hand-registered models in src/fal/videoModels.js.
//
// Returns 'required' if any param name from the corresponding name-set is in
// the model's OpenAPI `required` list; 'optional' if it's declared at all;
// 'unused' otherwise.
function computeInputs(required_obj, optional_obj) {
  const reqNames = new Set(Object.keys(required_obj || {}));
  const optNames = new Set(Object.keys(optional_obj || {}));
  function classify(nameSet) {
    for (const n of nameSet) {
      if (reqNames.has(n)) return 'required';
    }
    for (const n of nameSet) {
      if (optNames.has(n)) return 'optional';
    }
    return 'unused';
  }
  return {
    startFrame: classify(START_NAMES),
    endFrame: classify(END_NAMES),
    referenceImages: classify(REFERENCE_NAMES),
    characterSheet: classify(CHARACTER_NAMES),
    // We only call something "audio" capable when the model has an audio
    // param AND no video input (== lip_sync flag). Mirror that here.
    audio: AUDIO_NAMES_IF_LIPSYNC(required_obj, optional_obj),
    // characterElements is a Kling-specific concept — never present in the
    // generic OpenAPI param set. Registered models override this.
    characterElements: 'unused',
  };
}

function AUDIO_NAMES_IF_LIPSYNC(required_obj, optional_obj) {
  const reqNames = new Set(Object.keys(required_obj || {}));
  const optNames = new Set(Object.keys(optional_obj || {}));
  const hasVideo = [...VIDEO_INPUT_NAMES].some(n => reqNames.has(n) || optNames.has(n));
  if (hasVideo) return 'unused'; // pure video-lipsync, not avatar
  for (const n of AUDIO_NAMES) if (reqNames.has(n)) return 'required';
  for (const n of AUDIO_NAMES) if (optNames.has(n)) return 'optional';
  return 'unused';
}

// ---------- clustering / output ----------

function bitmap(caps) {
  let b = 0;
  CAP_KEYS.forEach((k, i) => { if (caps[k]) b |= (1 << i); });
  return b;
}

function bitmapToCapList(b) {
  return CAP_KEYS.filter((_, i) => b & (1 << i));
}

function popcount(b) {
  let c = 0; while (b) { c += b & 1; b >>= 1; } return c;
}

function compareMaxSeconds(a, b) {
  const aN = typeof a === 'number';
  const bN = typeof b === 'number';
  if (aN && bN) return b - a;
  if (aN) return -1;
  if (bN) return 1;
  return 0;
}

function writeClustersCsv(enriched) {
  const headers = [
    'endpoint_id', 'display_name', 'category', 'model_lab',
    'has_start_frame', 'has_end_frame', 'has_reference_images', 'has_character_sheet', 'has_lip_sync',
    'capability_score', 'max_seconds', 'max_seconds_source', 'price',
  ];
  const lines = [headers.join(',')];
  for (const r of enriched) {
    lines.push([
      csvCell(r.endpoint_id),
      csvCell(r.display_name),
      csvCell(r.category),
      csvCell(r.model_lab),
      csvCell(r.caps.start_frame),
      csvCell(r.caps.end_frame),
      csvCell(r.caps.reference_images),
      csvCell(r.caps.character_sheet),
      csvCell(r.caps.lip_sync),
      csvCell(r.score),
      csvCell(r.max_seconds),
      csvCell(r.max_seconds_source),
      csvCell(r.price),
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

function writeClustersMarkdown(enriched) {
  // Group by bitmap.
  const groups = new Map();
  for (const r of enriched) {
    const arr = groups.get(r.bitmap) || [];
    arr.push(r);
    groups.set(r.bitmap, arr);
  }
  // Sort group keys: score desc, then bitmap asc.
  const sortedBitmaps = [...groups.keys()].sort((a, b) => {
    const pa = popcount(a), pb = popcount(b);
    if (pa !== pb) return pb - pa;
    return a - b;
  });

  // Tier summary table.
  const tierCounts = new Map();
  for (const r of enriched) {
    tierCounts.set(r.score, (tierCounts.get(r.score) || 0) + 1);
  }

  const lines = [];
  lines.push('# fal.ai Image-to-Video Model Capability Clusters');
  lines.push('');
  lines.push(`Generated from ${enriched.length} image-to-video models in \`scripts/output/fal-video-models.csv\`.`);
  lines.push('');
  lines.push(`Capabilities: \`${CAP_KEYS.join('\`, \`')}\`. Lip-sync = avatar (image+audio → video) only.`);
  lines.push('');
  lines.push('## Tier summary');
  lines.push('');
  lines.push('| score | models |');
  lines.push('|------:|-------:|');
  for (let s = 5; s >= 0; s--) {
    lines.push(`|     ${s} | ${String(tierCounts.get(s) || 0).padStart(6)} |`);
  }
  lines.push('');

  for (const b of sortedBitmaps) {
    const present = bitmapToCapList(b);
    const missing = CAP_KEYS.filter(k => !present.includes(k));
    const score = popcount(b);
    const presentShort = present.length
      ? present.map(k => CAP_LABELS[k]).join(', ')
      : '(none)';
    const groupRows = groups.get(b);
    // Sort within group: max_seconds desc (numeric first), then endpoint_id asc.
    groupRows.sort((x, y) => {
      const c = compareMaxSeconds(x.max_seconds, y.max_seconds);
      if (c !== 0) return c;
      return x.endpoint_id.localeCompare(y.endpoint_id);
    });
    lines.push(`## Tier ${score}/5 — ${presentShort}  (${groupRows.length} models)`);
    lines.push(`missing: ${missing.length ? missing.join(', ') : '(none)'}`);
    lines.push('');
    for (const r of groupRows) {
      const maxStr = typeof r.max_seconds === 'number' ? `max ${r.max_seconds}s` : 'max unknown';
      lines.push(`- \`${r.endpoint_id}\` — ${r.display_name} — ${maxStr}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---------- main ----------

async function main() {
  const text = await readFile(IN_PATH, 'utf8');
  const allRows = parseCsv(text);
  const rows = allRows.filter(r => r.category === 'image-to-video');
  console.error(`Loaded ${allRows.length} rows from ${IN_PATH}; kept ${rows.length} image-to-video.`);

  const enrichedAll = rows.map(row => {
    const params = allParams(row);
    const caps = detectCapabilities(row, params);
    const { max, source } = computeMaxSeconds(params);
    const bm = bitmap(caps);
    const required_params_obj = tryJson(row.required_params) || {};
    const optional_params_obj = tryJson(row.optional_params) || {};
    return {
      endpoint_id: row.endpoint_id,
      display_name: row.display_name,
      category: row.category,
      model_lab: row.model_lab,
      model_family: row.model_family,
      caps,
      bitmap: bm,
      score: popcount(bm),
      max_seconds: max,
      max_seconds_source: source,
      price: row.price,
      // Fields used only by the JSON manifest.
      resolutions: extractResolutions(params),
      aspect_ratios: extractAspectRatios(params),
      durations_enum: extractDurationsEnum(params),
      supports_generate_audio: supportsGenerateAudio(params),
      inputs_required: Object.keys(required_params_obj),
      inputs_optional: Object.keys(optional_params_obj),
      inputs: computeInputs(required_params_obj, optional_params_obj),
      price_min_usd: extractPriceMinUsd(row.price),
    };
  });

  // Drop 0-capability rows from BOTH the cluster outputs and the manifest:
  // these are models whose param names we don't recognize, so we can't tell
  // the SPA what inputs they accept and can't help users pick them.
  const enriched = enrichedAll.filter(r => r.score > 0);
  const droppedZero = enrichedAll.length - enriched.length;

  await mkdir(path.dirname(OUT_CSV), { recursive: true });
  await mkdir(path.dirname(OUT_JSON), { recursive: true });
  await writeFile(OUT_CSV, writeClustersCsv(enriched));
  await writeFile(OUT_MD, writeClustersMarkdown(enriched));
  await writeFile(OUT_JSON, writeCatalogJson(enriched));

  // Stderr summary.
  const tierCounts = new Map();
  for (const r of enriched) tierCounts.set(r.score, (tierCounts.get(r.score) || 0) + 1);
  console.error('Tier counts (score → models):');
  for (let s = 5; s >= 1; s--) console.error(`  ${s}/5: ${tierCounts.get(s) || 0}`);
  console.error(`Dropped ${droppedZero} models with no recognized capability params.`);
  console.error(`Wrote ${OUT_CSV}`);
  console.error(`Wrote ${OUT_MD}`);
  console.error(`Wrote ${OUT_JSON} (${enriched.length} models)`);
}

function writeCatalogJson(enriched) {
  // Sort the JSON manifest: cheapest first (with nulls last), then alpha by id.
  // The SPA can re-sort on its own, but a stable order makes git diffs sane.
  const models = enriched
    .map(r => ({
      endpoint_id: r.endpoint_id,
      display_name: r.display_name,
      model_lab: r.model_lab || null,
      model_family: r.model_family || null,
      capabilities: r.caps,
      capability_score: r.score,
      resolutions: r.resolutions,
      aspect_ratios: r.aspect_ratios,
      max_seconds: r.max_seconds,
      max_seconds_source: r.max_seconds_source,
      durations_enum: r.durations_enum,
      supports_generate_audio: r.supports_generate_audio,
      price_text: r.price || null,
      price_min_usd: r.price_min_usd,
      inputs: r.inputs,
      inputs_required: r.inputs_required,
      inputs_optional: r.inputs_optional,
    }))
    .sort((a, b) => {
      const ap = a.price_min_usd;
      const bp = b.price_min_usd;
      if (ap == null && bp == null) return a.endpoint_id.localeCompare(b.endpoint_id);
      if (ap == null) return 1;
      if (bp == null) return -1;
      if (ap !== bp) return ap - bp;
      return a.endpoint_id.localeCompare(b.endpoint_id);
    });
  const payload = {
    generated_at: new Date().toISOString(),
    source: 'scripts/cluster-fal-video-models.js',
    category: 'image-to-video',
    model_count: models.length,
    models,
  };
  return JSON.stringify(payload, null, 2) + '\n';
}

main().catch(err => { console.error(err); process.exit(1); });
