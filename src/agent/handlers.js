import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import * as Characters from '../mongo/characters.js';
import * as Plots from '../mongo/plots.js';
import * as Prompts from '../mongo/prompts.js';
import * as DirectorNotes from '../mongo/directorNotes.js';
import * as Files from '../mongo/files.js';
import * as Images from '../mongo/images.js';
import * as Attachments from '../mongo/attachments.js';
import * as Tmdb from '../tmdb/client.js';
import * as Tavily from '../tavily/client.js';
import { generateImage as generateImageBytes, NANO_BANANA_MODEL } from '../gemini/client.js';
import { buildImagePrompt } from '../gemini/promptBuilder.js';
import * as Messages from '../mongo/messages.js';
import { config } from '../config.js';
import { exportToPdf } from '../pdf/export.js';
import { buildOverview } from './overview.js';
import { logger } from '../log.js';
import { countNgrams, topNgrams } from '../analysis/ngrams.js';
import { rankSimilar, bagOfWords } from '../analysis/similarity.js';
import { detectClimax } from '../analysis/sentiment.js';
import { analyzeText } from '../llm/analyze.js';
import { create, all } from 'mathjs';
import { runJsInVm } from './codeRunner.js';
import {
  recordGeminiImageUsage,
  aggregateUsage,
  aggregateToolUsage,
  aggregateSectionTokens,
} from '../mongo/tokenUsage.js';
import {
  renderTokenUsageChart,
  renderToolTokensChart,
  renderToolInvocationsChart,
  renderSectionAllocationChart,
} from '../charts/tokenUsageChart.js';

const mj = create(all, { number: 'BigNumber', precision: 64 });

function compact(obj) {
  return JSON.stringify(obj, null, 2);
}

function preview(text, n = 120) {
  if (!text) return '';
  const t = String(text).trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n - 1)}…`;
}

const DESCRIBE_IMAGE_BASELINE = [
  'Analyze this image with maximum physical-appearance detail so any humans or characters depicted could be recreated faithfully in future image generations. For each character, capture every one of:',
  '- Hair color (specific shade — e.g. "ash blonde", "jet black with copper highlights", not just "dark")',
  '- Hair length (e.g. "shoulder-length", "cropped close to the scalp", "down to mid-back")',
  '- Hairstyle (e.g. "loose waves with a center part", "high ponytail with curtain bangs", "tight braids gathered into a low bun")',
  '- Approximate age, height, and build',
  '- Skin tone and complexion notes',
  '- Eye color and eye shape',
  '- Facial features: jaw shape, nose, lips, eyebrows, freckles / moles / scars / other distinguishing marks',
  '- Clothing: garments, colors, fabrics, fit, era / style, accessories, footwear',
  '- Posture, expression, mood',
  '',
  'Also describe the setting, lighting, framing, and any objects of narrative interest. Be specific and concrete — vague descriptors like "nice hair" or "cool outfit" defeat the purpose. If a trait is not visible, say so explicitly rather than guessing.',
].join('\n');

function buildDescribeImageGuidance(prompt) {
  const trimmed = typeof prompt === 'string' ? prompt.trim() : '';
  if (!trimmed) return DESCRIBE_IMAGE_BASELINE;
  return `${DESCRIBE_IMAGE_BASELINE}\n\nOperator prompt: ${trimmed}`;
}

function serializeBeatSummary(b, currentId) {
  return {
    _id: b._id.toString(),
    order: b.order,
    name: b.name,
    desc_preview: preview(b.desc),
    body_length: (b.body || '').length,
    character_count: (b.characters || []).length,
    image_count: (b.images || []).length,
    is_current: !!(currentId && b._id.equals(currentId)),
  };
}

function serializeBeat(b) {
  return {
    _id: b._id.toString(),
    order: b.order,
    name: b.name,
    desc: b.desc || '',
    body: b.body || '',
    characters: b.characters || [],
    images: (b.images || []).map((i) => ({
      _id: i._id.toString(),
      filename: i.filename,
      content_type: i.content_type,
      size: i.size,
      source: i.source || 'upload',
      prompt: i.prompt || null,
      generated_by: i.generated_by || null,
      caption: i.caption || null,
      uploaded_at: i.uploaded_at,
    })),
    main_image_id: b.main_image_id ? b.main_image_id.toString() : null,
  };
}

async function maybeAutoFetchActorPortrait(characterIdentifier) {
  let c;
  try {
    c = await Characters.getCharacter(characterIdentifier);
  } catch (e) {
    return ` (Note: could not re-read character to auto-fetch portrait: ${e.message})`;
  }
  if (!c) return null;
  if (c.plays_self) return null;
  if (!c.hollywood_actor) return null;
  if (c.main_image_id) return null;

  const lookup = await Tmdb.findActorPortraitUrl(c.hollywood_actor);
  if (!lookup.ok) {
    return ` (Note: TMDB portrait lookup for "${c.hollywood_actor}" failed: ${lookup.reason}.)`;
  }

  try {
    await Files.attachImageToCharacter({
      character: c._id.toString(),
      sourceUrl: lookup.url,
      filename: null,
      caption: `TMDB profile photo for ${lookup.person_name}`,
      setAsMain: true,
    });
    return ` Auto-attached TMDB portrait for "${lookup.person_name}".`;
  } catch (e) {
    logger.warn(`auto-portrait attach failed for ${c.name}: ${e.message}`);
    return ` (Note: TMDB portrait found but attach failed: ${e.message}.)`;
  }
}

async function resolveBeat(identifier, { allowCurrent = true } = {}) {
  if (identifier === undefined || identifier === null || identifier === '') {
    if (!allowCurrent) throw new Error('A beat identifier is required.');
    const cur = await Plots.getCurrentBeat();
    if (!cur) {
      throw new Error('No current beat is set. Pass an explicit `beat` identifier or call set_current_beat first.');
    }
    return cur;
  }
  const b = await Plots.getBeat(String(identifier));
  if (!b) throw new Error(`Beat not found: ${identifier}`);
  return b;
}

async function resolveDirectorNote(noteId) {
  if (!noteId || typeof noteId !== 'string') {
    throw new Error('A note_id is required.');
  }
  const doc = await DirectorNotes.getDirectorNotes();
  const note = DirectorNotes.getDirectorNote(doc.notes || [], noteId);
  if (!note) throw new Error(`Director's note not found: ${noteId}`);
  return note;
}

const CHARACTER_TEXT_FIELDS = ['background_story', 'origin_story', 'arc', 'events', 'memes'];
const BEAT_TEXT_FIELDS = ['name', 'desc', 'body'];

async function appendSimilarityHeadsUp(type, item, baseMessage) {
  try {
    const selfId = item?._id ? item._id.toString() : null;
    let corpus;
    let targetText;

    if (type === 'character') {
      const all = await Characters.findAllCharacters();
      corpus = all.map((c) => {
        const fields = {};
        for (const f of CHARACTER_TEXT_FIELDS) fields[f] = String(c.fields?.[f] || '');
        return { id: c._id.toString(), label: c.name, fields };
      });
      targetText = CHARACTER_TEXT_FIELDS.map((f) => item.fields?.[f] || '')
        .filter(Boolean)
        .join('\n');
    } else if (type === 'beat') {
      const beats = await Plots.listBeats();
      corpus = beats.map((b) => {
        const fields = {};
        for (const f of BEAT_TEXT_FIELDS) fields[f] = String(b[f] || '');
        return { id: b._id.toString(), label: `#${b.order} ${b.name}`, fields };
      });
      targetText = BEAT_TEXT_FIELDS.map((f) => item[f] || '').filter(Boolean).join('\n');
    } else {
      return baseMessage;
    }

    if (!targetText.trim() || corpus.length <= 1) return baseMessage;

    const targetTokens = bagOfWords(targetText);
    if (targetTokens.size === 0) return baseMessage;

    const matches = rankSimilar(
      { tokens: targetTokens },
      corpus,
      { threshold: 0.6, excludeId: selfId },
    );
    if (!matches.length) return baseMessage;

    const top = matches[0];
    const pct = Math.round(top.score * 100);
    const fieldNote =
      top.matched_field && top.matched_field !== '_concat'
        ? ` (matched on ${top.matched_field})`
        : '';
    return `${baseMessage}\n\nHeads up: this ${type} is ${pct}% similar to "${top.label}"${fieldNote}. Use check_similarity for full results.`;
  } catch (e) {
    logger.warn(`similarity hook failed: ${e.message}`);
    return baseMessage;
  }
}

function truncateStr(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  return `${str.slice(0, n - 1)}…`;
}

function buildSimilarityQuery({ kind, profile, focus }) {
  let prefix = '';
  const parts = [];
  if (kind === 'character') {
    prefix = 'fictional character archetype: ';
    if (profile.hollywood_actor) parts.push(`played by ${profile.hollywood_actor}`);
    for (const f of CHARACTER_TEXT_FIELDS) {
      const v = profile.fields?.[f];
      if (v && typeof v === 'string' && v.trim()) parts.push(v.trim());
    }
  } else if (kind === 'plot') {
    prefix = 'story plot similar to: ';
    if (profile.synopsis) parts.push(profile.synopsis.trim());
    const beatSummary = (profile.beats || [])
      .slice(0, 12)
      .map((b) => truncateStr(String(b.desc || b.name || ''), 80))
      .filter(Boolean)
      .join('; ');
    if (beatSummary) parts.push(beatSummary);
  } else if (kind === 'beat') {
    prefix = 'scene similar to: ';
    if (profile.desc) parts.push(profile.desc.trim());
    if (profile.body) parts.push(truncateStr(profile.body, 300));
  }
  let q = prefix + parts.filter(Boolean).join('. ');
  if (focus && typeof focus === 'string' && focus.trim()) {
    q += ` (focus: ${focus.trim()})`;
  }
  return truncateStr(q, 400);
}

function buildProfileSection(kind, profile) {
  const lines = [];
  if (kind === 'character') {
    if (profile.hollywood_actor) lines.push(`Cast as: ${profile.hollywood_actor}`);
    for (const f of CHARACTER_TEXT_FIELDS) {
      const v = profile.fields?.[f];
      if (v && typeof v === 'string' && v.trim()) lines.push(`${f}: ${v.trim()}`);
    }
  } else if (kind === 'plot') {
    if (profile.synopsis) lines.push(`Synopsis: ${profile.synopsis.trim()}`);
    const beats = (profile.beats || []).slice(0, 20);
    if (beats.length) {
      lines.push('Beats:');
      for (const b of beats) {
        const order = b.order ?? '';
        const name = b.name || '';
        const desc = truncateStr(b.desc || '', 200);
        lines.push(`- (${order}) ${name}${desc ? `: ${desc}` : ''}`);
      }
    }
  } else if (kind === 'beat') {
    if (profile.name) lines.push(`Beat name: ${profile.name}`);
    if (profile.desc) lines.push(`desc: ${profile.desc.trim()}`);
    if (profile.body) lines.push(`body: ${truncateStr(profile.body, 1500)}`);
  }
  return lines.join('\n');
}

function formatTavilyResultsForPrompt(results) {
  if (!results.length) return '(no search results)';
  return results
    .map((r, i) => {
      const lines = [`${i + 1}. ${r.title || '(no title)'} — ${r.url || ''}`];
      if (r.snippet) lines.push(`   snippet: ${r.snippet}`);
      if (r.content) lines.push(`   content: ${r.content}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

function buildAnalysisPrompt({ kind, profile, results, maxWorks }) {
  const profileSection = buildProfileSection(kind, profile);
  const resultsSection = formatTavilyResultsForPrompt(results);
  const subjectWord = kind === 'character' ? 'character' : kind === 'beat' ? 'scene' : 'plot';
  const matchTarget = kind === 'character' ? 'characters' : 'plots or scenes';
  const system =
    `You are a literary and film analyst. You will receive a screenplay ${subjectWord} profile and a list of web search results. ` +
    `Your job is to identify up to ${maxWorks} well-known existing works whose ${matchTarget} share the strongest structural or thematic parallels with the profile.\n\n` +
    `Hard rules:\n` +
    `- Reason ONLY from the profile and the search results provided. Do not invent works that are not supported by the snippets.\n` +
    `- If nothing in the snippets resembles the profile, output a single short sentence saying so and stop. Do not pad.\n` +
    `- For each parallel, cite specific traits from the profile and the snippet that support it. Be concrete.\n` +
    `- Rate confidence as high, medium, or low.\n` +
    `- Output Markdown only. No preamble, no closing remarks.\n\n` +
    `Format each parallel as:\n` +
    `1. **Title** (Year) — <character or "plot">\n` +
    `   Confidence: <high|medium|low>\n` +
    `   Evidence: <2-3 sentences>\n` +
    `   Source: <URL>\n`;
  const user =
    `<profile>\n${profileSection}\n</profile>\n\n` +
    `<search_results>\n${resultsSection}\n</search_results>\n\n` +
    `Identify up to ${maxWorks} parallels.`;
  return { system, user };
}

const CHARACTER_COMPUTED_COLUMNS = {
  image_count: (c) => (c.images || []).length,
  field_count: (c) => Object.keys(c.fields || {}).length,
  appears_in_beats: (c, ctx) => {
    const m = ctx?.appearsInBeats;
    if (!m) return 0;
    return m.get(String(c.name || '').toLowerCase()) || 0;
  },
};

const BEAT_COMPUTED_COLUMNS = {
  word_count: (b) => {
    const t = String(b.body || '').trim();
    if (!t) return 0;
    return t.split(/\s+/).filter(Boolean).length;
  },
  char_count: (b) => String(b.body || '').length,
  image_count: (b) => (b.images || []).length,
  attachment_count: (b) => (b.attachments || []).length,
  character_count: (b) => (b.characters || []).length,
};

function getByDotPath(obj, pathStr) {
  if (obj == null) return undefined;
  const parts = String(pathStr).split('.');
  let v = obj;
  for (const p of parts) {
    if (v == null) return undefined;
    v = v[p];
  }
  return v;
}

function makeCsvAccessor(entity, ctx) {
  const computed =
    entity === 'characters' ? CHARACTER_COMPUTED_COLUMNS : BEAT_COMPUTED_COLUMNS;
  return (fieldPath) => {
    if (Object.prototype.hasOwnProperty.call(computed, fieldPath)) {
      return (doc) => computed[fieldPath](doc, ctx);
    }
    return (doc) => getByDotPath(doc, fieldPath);
  };
}

function collectCsvFieldRefs({ columns, filter, group_by, sort }) {
  const out = new Set();
  for (const c of columns || []) if (c?.field) out.add(c.field);
  for (const f of filter || []) if (f?.field) out.add(f.field);
  for (const f of group_by || []) if (f) out.add(f);
  for (const s of sort || []) if (s?.field) out.add(s.field);
  return out;
}

function isObjectIdLike(v) {
  return v && typeof v === 'object' && typeof v.toHexString === 'function';
}

function csvCmpEq(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (a instanceof Date && typeof b === 'string') return a.toISOString() === b;
  if (b instanceof Date && typeof a === 'string') return b.toISOString() === a;
  if (isObjectIdLike(a)) return a.toString() === String(b);
  if (isObjectIdLike(b)) return b.toString() === String(a);
  return false;
}

function csvCmpOrder(a, b) {
  if (a == null || b == null) return null;
  let ax = a;
  let bx = b;
  if (ax instanceof Date) ax = ax.getTime();
  if (bx instanceof Date) bx = bx.getTime();
  if (typeof ax === 'string' && typeof bx === 'string') {
    return ax < bx ? -1 : ax > bx ? 1 : 0;
  }
  const an = Number(ax);
  const bn = Number(bx);
  if (Number.isFinite(an) && Number.isFinite(bn)) {
    return an < bn ? -1 : an > bn ? 1 : 0;
  }
  return null;
}

function csvOpContains(fieldVal, value) {
  if (fieldVal == null) return false;
  const needle = String(value ?? '').toLowerCase();
  if (!needle) return false;
  if (Array.isArray(fieldVal)) {
    return fieldVal.some((el) => String(el ?? '').toLowerCase().includes(needle));
  }
  return String(fieldVal).toLowerCase().includes(needle);
}

function csvOpExists(fieldVal, value) {
  const present = fieldVal !== undefined && fieldVal !== null;
  return value === false ? !present : present;
}

function evalCsvFilter(fieldVal, op, value) {
  switch (op) {
    case 'eq':
      return csvCmpEq(fieldVal, value);
    case 'ne':
      return !csvCmpEq(fieldVal, value);
    case 'gt':
      return csvCmpOrder(fieldVal, value) === 1;
    case 'gte': {
      const c = csvCmpOrder(fieldVal, value);
      return c === 1 || c === 0;
    }
    case 'lt':
      return csvCmpOrder(fieldVal, value) === -1;
    case 'lte': {
      const c = csvCmpOrder(fieldVal, value);
      return c === -1 || c === 0;
    }
    case 'contains':
      return csvOpContains(fieldVal, value);
    case 'exists':
      return csvOpExists(fieldVal, value);
    default:
      return false;
  }
}

function computeCsvAggregate(op, values) {
  if (op === 'count') {
    return values.filter((v) => v !== undefined && v !== null).length;
  }
  const nums = values
    .map((v) => (v === null || v === undefined ? NaN : Number(v)))
    .filter((n) => Number.isFinite(n));
  if (op === 'sum') return nums.reduce((a, b) => a + b, 0);
  if (op === 'min') return nums.length ? Math.min(...nums) : null;
  if (op === 'max') return nums.length ? Math.max(...nums) : null;
  if (op === 'avg') return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  return null;
}

function csvCell(v) {
  if (v === undefined || v === null) return '';
  let s;
  if (v instanceof Date) s = v.toISOString();
  else if (isObjectIdLike(v)) s = v.toString();
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvLine(arr) {
  return arr.map(csvCell).join(',');
}

function sanitizeCsvFilename(name) {
  if (!name || typeof name !== 'string') return null;
  const base = path.basename(String(name).trim());
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._]+/, '');
  if (!cleaned) return null;
  return cleaned.toLowerCase().endsWith('.csv') ? cleaned : `${cleaned}.csv`;
}

function csvGroupKey(values) {
  return JSON.stringify(values, (_k, v) => {
    if (isObjectIdLike(v)) return v.toString();
    if (v instanceof Date) return v.toISOString();
    return v;
  });
}

async function runCsvExport({
  entity,
  docs,
  columns,
  filter,
  group_by,
  sort,
  limit,
  filename,
}) {
  if (!Array.isArray(columns) || columns.length === 0) {
    return 'Tool error (export_csv): at least one column is required.';
  }

  const groupBy = Array.isArray(group_by) ? group_by.filter(Boolean) : [];
  const hasAggregate = columns.some((c) => c.aggregate && c.aggregate !== 'none');

  if (groupBy.length > 0 || hasAggregate) {
    for (const c of columns) {
      const inGroup = groupBy.includes(c.field);
      const aggregated = c.aggregate && c.aggregate !== 'none';
      if (!inGroup && !aggregated) {
        return `Tool error (export_csv): column "${c.field}" must be in group_by or have a non-none aggregate when group_by/aggregates are used.`;
      }
    }
  }

  const ctx = {};
  if (entity === 'characters') {
    const refs = collectCsvFieldRefs({ columns, filter, group_by: groupBy, sort });
    if (refs.has('appears_in_beats')) {
      const beats = await Plots.listBeats();
      const m = new Map();
      for (const b of beats) {
        for (const n of b.characters || []) {
          const key = String(n || '').toLowerCase();
          if (!key) continue;
          m.set(key, (m.get(key) || 0) + 1);
        }
      }
      ctx.appearsInBeats = m;
    }
  }

  const resolveAccessor = makeCsvAccessor(entity, ctx);

  let rows = docs.slice();
  for (const f of filter || []) {
    if (!f || !f.field || !f.op) continue;
    const acc = resolveAccessor(f.field);
    rows = rows.filter((d) => evalCsvFilter(acc(d), f.op, f.value));
  }

  let outputRows;

  if (groupBy.length > 0) {
    const groupAccessors = groupBy.map(resolveAccessor);
    const groups = new Map();
    for (const row of rows) {
      const groupValues = groupAccessors.map((acc) => acc(row));
      const key = csvGroupKey(groupValues);
      let bucket = groups.get(key);
      if (!bucket) {
        bucket = { groupValues, rows: [] };
        groups.set(key, bucket);
      }
      bucket.rows.push(row);
    }
    outputRows = [];
    for (const { groupValues, rows: groupRows } of groups.values()) {
      const out = columns.map((c) => {
        const gIdx = groupBy.indexOf(c.field);
        if (gIdx >= 0) return groupValues[gIdx];
        const acc = resolveAccessor(c.field);
        return computeCsvAggregate(c.aggregate, groupRows.map(acc));
      });
      outputRows.push(out);
    }
  } else if (hasAggregate) {
    const out = columns.map((c) => {
      const acc = resolveAccessor(c.field);
      return computeCsvAggregate(c.aggregate, rows.map(acc));
    });
    outputRows = [out];
  } else {
    const accs = columns.map((c) => resolveAccessor(c.field));
    outputRows = rows.map((r) => accs.map((acc) => acc(r)));
  }

  if (Array.isArray(sort) && sort.length > 0) {
    const sortIndices = sort
      .map((s) => ({
        idx: columns.findIndex((c) => c.field === s.field),
        dir: s.direction === 'desc' ? -1 : 1,
      }))
      .filter((s) => s.idx >= 0);
    if (sortIndices.length > 0) {
      outputRows.sort((a, b) => {
        for (const { idx, dir } of sortIndices) {
          const av = a[idx];
          const bv = b[idx];
          const aNull = av === null || av === undefined;
          const bNull = bv === null || bv === undefined;
          if (aNull && bNull) continue;
          if (aNull) return -1 * dir;
          if (bNull) return 1 * dir;
          if (av < bv) return -1 * dir;
          if (av > bv) return 1 * dir;
        }
        return 0;
      });
    }
  }

  if (Number.isFinite(limit) && limit > 0) {
    outputRows = outputRows.slice(0, Math.floor(limit));
  }

  const headers = columns.map((c) => {
    if (c.header) return String(c.header);
    if (c.aggregate && c.aggregate !== 'none') return `${c.aggregate}(${c.field})`;
    return c.field;
  });

  const csvText = [csvLine(headers), ...outputRows.map(csvLine)].join('\n') + '\n';

  const today = new Date().toISOString().slice(0, 10);
  const finalName = sanitizeCsvFilename(filename) || `${entity}-${today}.csv`;
  const outPath = path.join(os.tmpdir(), finalName);
  await fs.writeFile(outPath, csvText, 'utf8');

  logger.info(
    `csv export: entity=${entity} rows=${outputRows.length} bytes=${Buffer.byteLength(csvText)}`,
  );
  return `__CSV_PATH__:${outPath}|Exported ${outputRows.length} ${entity} row(s).`;
}

async function runSimilaritySearch({ query, maxResults = 8, rawContentTopN = 3 }) {
  const data = await Tavily.search({
    query,
    search_depth: 'advanced',
    topic: 'general',
    max_results: maxResults,
    include_answer: false,
    include_images: false,
    include_raw_content: true,
  });
  return (data.results || []).map((r, i) => ({
    title: r.title || '',
    url: r.url || '',
    snippet: typeof r.content === 'string' ? r.content.slice(0, 600) : '',
    content:
      i < rawContentTopN && typeof r.raw_content === 'string'
        ? r.raw_content.slice(0, 3000)
        : null,
    score: r.score,
  }));
}

export const HANDLERS = {
  async get_overview() {
    return compact(await buildOverview());
  },

  async list_characters() {
    const list = await Characters.listCharacters();
    return compact(list.map((c) => ({ _id: c._id.toString(), name: c.name })));
  },

  async get_character({ identifier }) {
    const c = await Characters.getCharacter(identifier);
    if (!c) return `No character found for "${identifier}".`;
    return compact(c);
  },

  async create_character(input) {
    const playsSelf = input.plays_self === undefined ? true : !!input.plays_self;
    const ownVoice = input.own_voice === undefined ? true : !!input.own_voice;
    if (!playsSelf && !input.hollywood_actor) {
      return 'Error: when plays_self is false, hollywood_actor is required.';
    }
    const c = await Characters.createCharacter({
      ...input,
      plays_self: playsSelf,
      own_voice: ownVoice,
    });
    const note = await maybeAutoFetchActorPortrait(c._id.toString());
    const base = `Created character ${c.name} (_id ${c._id}).${note || ''}`;
    return appendSimilarityHeadsUp('character', c, base);
  },

  async update_character({ identifier, patch }) {
    const c = await Characters.updateCharacter(identifier, patch);
    const note = await maybeAutoFetchActorPortrait(c._id.toString());
    const fresh = note ? await Characters.getCharacter(c._id.toString()) : c;
    const base = `Updated ${c.name}.${note || ''}\nCurrent state:\n${compact(fresh)}`;
    const touchedText =
      patch && (patch.name !== undefined || (patch.fields && typeof patch.fields === 'object'));
    return touchedText ? appendSimilarityHeadsUp('character', fresh, base) : base;
  },

  async bulk_update_character_field({ field_name, updates, batch_size } = {}) {
    if (!field_name || typeof field_name !== 'string') {
      return 'Error: field_name is required.';
    }
    if (!Array.isArray(updates) || updates.length === 0) {
      return 'Error: updates must be a non-empty array of {character, value} pairs.';
    }
    const CORE_FIELDS = new Set(['name', 'plays_self', 'hollywood_actor', 'own_voice']);
    const patchKey = CORE_FIELDS.has(field_name) ? field_name : `fields.${field_name}`;
    const total = updates.length;
    const size = Math.min(25, Math.max(1, Number.isFinite(batch_size) ? batch_size : 10));

    logger.info(
      `[bulk_update_character_field] starting: field=${field_name} count=${total} batch_size=${size}`,
    );

    const successes = [];
    const failures = [];
    let processed = 0;

    for (let start = 0; start < total; start += size) {
      const batch = updates.slice(start, start + size);
      const settled = await Promise.allSettled(
        batch.map(async (row) => {
          if (!row || typeof row.character !== 'string') {
            throw new Error('each update needs a character string');
          }
          if (row.value === undefined) {
            throw new Error('value is required');
          }
          const updated = await Characters.updateCharacter(row.character, {
            [patchKey]: row.value,
          });
          return { input: row.character, name: updated.name, value: row.value };
        }),
      );

      for (let j = 0; j < settled.length; j++) {
        processed += 1;
        const row = batch[j];
        const result = settled[j];
        if (result.status === 'fulfilled') {
          successes.push(result.value);
          logger.info(
            `[bulk_update_character_field] ${processed}/${total} ok: "${result.value.name}" → ${field_name}=${JSON.stringify(result.value.value)}`,
          );
        } else {
          const label = row?.character ?? '(unknown)';
          const msg = result.reason?.message || String(result.reason);
          failures.push({ character: label, error: msg });
          logger.warn(
            `[bulk_update_character_field] ${processed}/${total} failed: "${label}": ${msg}`,
          );
        }
      }
    }

    logger.info(
      `[bulk_update_character_field] done: ${successes.length} ok, ${failures.length} failed`,
    );

    const lines = [
      `Updated field "${field_name}" on ${successes.length}/${total} character(s).`,
    ];
    if (failures.length) {
      lines.push(`Failures (${failures.length}):`);
      for (const f of failures) lines.push(`- "${f.character}": ${f.error}`);
    }
    return lines.join('\n');
  },

  async search_characters({ query }) {
    const results = await Characters.searchCharacters(query);
    return compact(results.map((c) => ({ _id: c._id.toString(), name: c.name })));
  },

  async delete_character({ identifier }) {
    const existing = await Characters.getCharacter(identifier);
    if (!existing) return `No character found for "${identifier}".`;
    const { unlinked_from } = await Plots.unlinkCharacterFromAllBeats(existing.name);
    const res = await Characters.deleteCharacter(existing._id.toString());
    await Images.deleteImages(res.image_ids);
    await Attachments.deleteAttachments(res.attachment_ids);
    return `Deleted character "${res.name}" — unlinked from ${unlinked_from} beat(s), removed ${res.image_ids.length} image(s) and ${res.attachment_ids.length} attachment(s).`;
  },

  async get_character_template() {
    return compact(await Prompts.getCharacterTemplate());
  },

  async update_character_template({ add = [], remove = [] }) {
    const tpl = await Prompts.updateCharacterTemplateFields({ add, remove });
    return `Template updated. New fields:\n${compact(tpl.fields)}`;
  },

  async list_director_notes() {
    const doc = await DirectorNotes.getDirectorNotes();
    return compact(
      (doc.notes || []).map((n) => ({
        _id: n._id?.toString(),
        text: n.text,
        created_at: n.created_at,
      })),
    );
  },

  async add_director_note({ text, position } = {}) {
    const note = await DirectorNotes.addDirectorNote({ text, position });
    return `Added director's note ${note._id}: ${preview(note.text)}`;
  },

  async edit_director_note({ note_id, text } = {}) {
    const note = await DirectorNotes.editDirectorNote({ noteId: note_id, text });
    return `Updated director's note ${note._id}: ${preview(note.text)}`;
  },

  async remove_director_note({ note_id } = {}) {
    await DirectorNotes.removeDirectorNote({ noteId: note_id });
    return `Removed director's note ${note_id}.`;
  },

  async reorder_director_notes({ note_ids } = {}) {
    const reordered = await DirectorNotes.reorderDirectorNotes({ noteIds: note_ids });
    return `Reordered ${reordered.length} director's note(s).`;
  },

  async add_director_note_image({ note_id, source_url, filename, caption, set_as_main } = {}) {
    const target = await resolveDirectorNote(note_id);
    const file = await Images.uploadImageFromUrl({
      sourceUrl: source_url,
      filename,
      ownerType: 'director_note',
      ownerId: target._id,
    });
    const meta = {
      _id: file._id,
      filename: file.filename,
      content_type: file.content_type,
      size: file.size,
      source: 'upload',
      prompt: null,
      generated_by: null,
      caption: caption?.trim() || null,
      uploaded_at: file.uploaded_at,
    };
    const { is_main } = await DirectorNotes.pushDirectorNoteImage(
      target._id.toString(),
      meta,
      set_as_main,
    );
    return `Added image to director's note ${target._id}.\n${compact({
      _id: meta._id.toString(),
      filename: meta.filename,
      content_type: meta.content_type,
      size: meta.size,
      is_main,
    })}`;
  },

  async list_director_note_images({ note_id } = {}) {
    const target = await resolveDirectorNote(note_id);
    return compact({
      note_id: target._id.toString(),
      main_image_id: target.main_image_id ? target.main_image_id.toString() : null,
      images: (target.images || []).map((i) => ({
        _id: i._id.toString(),
        filename: i.filename,
        content_type: i.content_type,
        size: i.size,
        source: i.source || 'upload',
        prompt: i.prompt || null,
        caption: i.caption || null,
        uploaded_at: i.uploaded_at,
      })),
    });
  },

  async set_main_director_note_image({ note_id, image_id } = {}) {
    const updated = await DirectorNotes.setDirectorNoteMainImage(note_id, image_id);
    return `Main image for director's note ${updated._id} set to ${updated.main_image_id.toString()}.`;
  },

  async remove_director_note_image({ note_id, image_id } = {}) {
    const { removed, note: updated } = await DirectorNotes.pullDirectorNoteImage(
      note_id,
      image_id,
    );
    await Images.deleteImage(removed);
    return `Removed image ${removed.toString()} from director's note ${updated._id}. Main image is now ${
      updated.main_image_id ? updated.main_image_id.toString() : 'none'
    }.`;
  },

  async attach_library_image_to_director_note({ image_id, note_id, set_as_main } = {}) {
    const target = await resolveDirectorNote(note_id);
    const file = await Images.findImageFile(image_id);
    if (!file) throw new Error(`Image not found: ${image_id}`);
    if (
      file.metadata?.owner_type === 'director_note' &&
      file.metadata?.owner_id &&
      file.metadata.owner_id.equals(target._id)
    ) {
      return `Image ${image_id} is already attached to this note.`;
    }
    if (file.metadata?.owner_type && file.metadata.owner_type !== null) {
      throw new Error(
        `Image ${image_id} is currently attached to a ${file.metadata.owner_type}. Detach it first.`,
      );
    }
    await Images.setImageOwner(image_id, { ownerType: 'director_note', ownerId: target._id });
    const meta = {
      _id: file._id,
      filename: file.filename,
      content_type: file.contentType,
      size: file.length,
      source: file.metadata?.source || 'upload',
      prompt: file.metadata?.prompt || null,
      generated_by: file.metadata?.generated_by || null,
      caption: null,
      uploaded_at: file.uploadDate,
    };
    const { is_main } = await DirectorNotes.pushDirectorNoteImage(
      target._id.toString(),
      meta,
      set_as_main,
    );
    return `Attached image to director's note ${target._id}${is_main ? ' (now main image)' : ''}.`;
  },

  async add_director_note_attachment({ note_id, source_url, filename, caption } = {}) {
    const target = await resolveDirectorNote(note_id);
    const file = await Attachments.uploadAttachmentFromUrl({
      sourceUrl: source_url,
      filename,
      ownerType: 'director_note',
      ownerId: target._id,
    });
    const meta = {
      _id: file._id,
      filename: file.filename,
      content_type: file.content_type,
      size: file.size,
      caption: caption?.trim() || null,
      uploaded_at: file.uploaded_at,
    };
    await DirectorNotes.pushDirectorNoteAttachment(target._id.toString(), meta);
    return `Added attachment to director's note ${target._id}.\n${compact({
      _id: meta._id.toString(),
      filename: meta.filename,
      content_type: meta.content_type,
      size: meta.size,
      caption: meta.caption,
    })}`;
  },

  async list_director_note_attachments({ note_id } = {}) {
    const target = await resolveDirectorNote(note_id);
    return compact({
      note_id: target._id.toString(),
      attachments: (target.attachments || []).map((a) => ({
        _id: a._id.toString(),
        filename: a.filename,
        content_type: a.content_type,
        size: a.size,
        caption: a.caption || null,
        uploaded_at: a.uploaded_at,
      })),
    });
  },

  async remove_director_note_attachment({ note_id, attachment_id } = {}) {
    const { removed, note: updated } = await DirectorNotes.pullDirectorNoteAttachment(
      note_id,
      attachment_id,
    );
    await Attachments.deleteAttachment(removed);
    return `Removed attachment ${removed.toString()} from director's note ${updated._id}.`;
  },

  async get_plot() {
    const plot = await Plots.getPlot();
    return compact({
      synopsis: plot.synopsis,
      notes: plot.notes,
      current_beat_id: plot.current_beat_id ? plot.current_beat_id.toString() : null,
      beat_count: (plot.beats || []).length,
    });
  },

  async update_plot(patch) {
    const p = await Plots.updatePlot(patch);
    return `Plot updated.\n${compact({ synopsis: p.synopsis, notes: p.notes })}`;
  },

  async list_beats() {
    const plot = await Plots.getPlot();
    const beats = [...(plot.beats || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
    return compact(beats.map((b) => serializeBeatSummary(b, plot.current_beat_id)));
  },

  async get_beat({ identifier } = {}) {
    const b = await Plots.getBeat(identifier);
    if (!b) {
      return identifier
        ? `No beat found for "${identifier}".`
        : 'No current beat is set.';
    }
    return compact(serializeBeat(b));
  },

  async create_beat({ name, desc, body, characters, order }) {
    const b = await Plots.createBeat({ name, desc, body, characters, order });
    const base = `Created beat "${b.name}" (order ${b.order}, _id ${b._id}). It is now the current beat if none was set.`;
    return appendSimilarityHeadsUp('beat', b, base);
  },

  async update_beat({ identifier, patch }) {
    const b = await Plots.updateBeat(identifier, patch);
    const base = `Updated beat "${b.name}".\n${compact(serializeBeat(b))}`;
    const touchedText =
      patch && (patch.name !== undefined || patch.desc !== undefined || patch.body !== undefined);
    return touchedText ? appendSimilarityHeadsUp('beat', b, base) : base;
  },

  async append_to_beat_body({ beat, content }) {
    const target = await resolveBeat(beat);
    const updated = await Plots.appendBeatBody(target._id.toString(), content);
    return `Appended ${String(content || '').length} chars to beat "${updated.name}". Body is now ${updated.body.length} chars.`;
  },

  async search_beats({ query }) {
    const matches = await Plots.searchBeats(query);
    return compact({
      query,
      result_count: matches.length,
      results: matches.map((m) => ({
        _id: m.beat._id.toString(),
        order: m.beat.order,
        name: m.beat.name,
        desc_preview: preview(m.beat.desc),
        matched_field: m.matched_field,
        score: m.score,
      })),
    });
  },

  async delete_beat({ identifier }) {
    const res = await Plots.deleteBeat(identifier);
    await Images.deleteImages(res.image_ids);
    return `Deleted beat "${res.name}" and ${res.image_ids.length} image(s).`;
  },

  async link_character_to_beat({ beat, character }) {
    const target = await resolveBeat(beat);
    const updated = await Plots.linkCharacterToBeat(target._id.toString(), character);
    return `Linked ${character} to beat "${updated.name}". Characters now: ${updated.characters.join(', ') || '(none)'}.`;
  },

  async unlink_character_from_beat({ beat, character }) {
    const target = await resolveBeat(beat);
    const updated = await Plots.unlinkCharacterFromBeat(target._id.toString(), character);
    return `Unlinked ${character} from beat "${updated.name}". Characters now: ${updated.characters.join(', ') || '(none)'}.`;
  },

  async set_current_beat({ identifier }) {
    const b = await Plots.setCurrentBeat(identifier);
    return `Current beat is now "${b.name}" (_id ${b._id}).`;
  },

  async get_current_beat() {
    const b = await Plots.getCurrentBeat();
    if (!b) return 'No current beat is set.';
    return compact(serializeBeat(b));
  },

  async clear_current_beat() {
    await Plots.clearCurrentBeat();
    return 'Current beat cleared.';
  },

  async add_beat_image({ beat, source_url, filename, caption, set_as_main }) {
    const target = await resolveBeat(beat);
    const file = await Images.uploadImageFromUrl({
      sourceUrl: source_url,
      filename,
      ownerType: 'beat',
      ownerId: target._id,
    });
    const meta = {
      _id: file._id,
      filename: file.filename,
      content_type: file.content_type,
      size: file.size,
      source: 'upload',
      prompt: null,
      generated_by: null,
      caption: caption?.trim() || null,
      uploaded_at: file.uploaded_at,
    };
    const { is_main } = await Plots.pushBeatImage(target._id.toString(), meta, set_as_main);
    return `Added image to beat "${target.name}".\n${compact({
      _id: meta._id.toString(),
      filename: meta.filename,
      content_type: meta.content_type,
      size: meta.size,
      is_main,
    })}`;
  },

  async list_beat_images({ beat } = {}) {
    const target = await resolveBeat(beat);
    return compact({
      beat: { _id: target._id.toString(), name: target.name },
      main_image_id: target.main_image_id ? target.main_image_id.toString() : null,
      images: (target.images || []).map((i) => ({
        _id: i._id.toString(),
        filename: i.filename,
        content_type: i.content_type,
        size: i.size,
        source: i.source || 'upload',
        prompt: i.prompt || null,
        caption: i.caption || null,
        uploaded_at: i.uploaded_at,
      })),
    });
  },

  async set_main_beat_image({ beat, image_id }) {
    const target = await resolveBeat(beat);
    const updated = await Plots.setBeatMainImage(target._id.toString(), image_id);
    return `Main image for beat "${updated.name}" set to ${updated.main_image_id.toString()}.`;
  },

  async remove_beat_image({ beat, image_id }) {
    const target = await resolveBeat(beat);
    const { removed, beat: updated } = await Plots.pullBeatImage(target._id.toString(), image_id);
    await Images.deleteImage(removed);
    return `Removed image ${removed.toString()} from beat "${updated.name}". Main image is now ${
      updated.main_image_id ? updated.main_image_id.toString() : 'none'
    }.`;
  },

  async list_library_images() {
    const files = await Images.listLibraryImages();
    return compact(
      files.map((f) => {
        const m = Images.imageFileToMeta(f);
        return { ...m, _id: m._id.toString() };
      }),
    );
  },

  async attach_library_image_to_beat({ image_id, beat, set_as_main }) {
    const target = await resolveBeat(beat);
    const file = await Images.findImageFile(image_id);
    if (!file) throw new Error(`Image not found: ${image_id}`);
    if (
      file.metadata?.owner_type === 'beat' &&
      file.metadata?.owner_id &&
      file.metadata.owner_id.equals(target._id)
    ) {
      return `Image ${image_id} is already attached to beat "${target.name}".`;
    }
    if (file.metadata?.owner_type === 'beat') {
      throw new Error(
        `Image ${image_id} is currently attached to a different beat. Detach it first with remove_beat_image.`,
      );
    }
    await Images.setImageOwner(image_id, { ownerType: 'beat', ownerId: target._id });
    const meta = {
      _id: file._id,
      filename: file.filename,
      content_type: file.contentType,
      size: file.length,
      source: file.metadata?.source || 'upload',
      prompt: file.metadata?.prompt || null,
      generated_by: file.metadata?.generated_by || null,
      caption: null,
      uploaded_at: file.uploadDate,
    };
    const { is_main } = await Plots.pushBeatImage(target._id.toString(), meta, set_as_main);
    return `Attached image to beat "${target.name}"${is_main ? ' (now main image)' : ''}.`;
  },

  async attach_library_image_to_character({ image_id, character, set_as_main, caption } = {}) {
    const res = await Files.attachExistingImageToCharacter({
      character,
      imageId: image_id,
      caption,
      setAsMain: set_as_main,
    });
    if (res.already_attached) {
      return `Image ${image_id} is already attached to character "${res.character}".`;
    }
    return `Attached image to character "${res.character || character}"${
      res.is_main ? ' (now main image)' : ''
    }.`;
  },

  async add_library_attachment({ source_url, filename, caption } = {}) {
    const file = await Attachments.uploadAttachmentFromUrl({
      sourceUrl: source_url,
      filename,
      ownerType: null,
      ownerId: null,
    });
    return `Added attachment to library.\n${compact({
      _id: file._id.toString(),
      filename: file.filename,
      content_type: file.content_type,
      size: file.size,
      caption: caption?.trim() || null,
    })}`;
  },

  async list_library_attachments() {
    const files = await Attachments.listLibraryAttachments();
    return compact(
      files.map((f) => {
        const m = Attachments.attachmentFileToMeta(f);
        return { ...m, _id: m._id.toString() };
      }),
    );
  },

  async attach_library_attachment_to_beat({ attachment_id, beat, caption } = {}) {
    const target = await resolveBeat(beat);
    const res = await Attachments.attachExistingAttachmentToBeat({
      beat: target._id.toString(),
      attachmentId: attachment_id,
      caption,
    });
    if (res.already_attached) {
      return `Attachment ${attachment_id} is already attached to beat "${target.name}".`;
    }
    return `Attached attachment to beat "${target.name}".`;
  },

  async attach_library_attachment_to_character({ attachment_id, character, caption } = {}) {
    const res = await Attachments.attachExistingAttachmentToCharacter({
      character,
      attachmentId: attachment_id,
      caption,
    });
    if (res.already_attached) {
      return `Attachment ${attachment_id} is already attached to character "${res.character}".`;
    }
    return `Attached attachment to character "${res.character}".`;
  },

  async attach_library_attachment_to_director_note({ attachment_id, note_id, caption } = {}) {
    const target = await resolveDirectorNote(note_id);
    const res = await Attachments.attachExistingAttachmentToDirectorNote({
      noteId: target._id.toString(),
      attachmentId: attachment_id,
      caption,
    });
    if (res.already_attached) {
      return `Attachment ${attachment_id} is already attached to director's note ${target._id}.`;
    }
    return `Attached attachment to director's note ${target._id}.`;
  },

  async show_image({ image_id }) {
    const { path: filepath, file } = await Images.streamImageToTmp(image_id);
    return `__IMAGE_PATH__:${filepath}||${file._id.toString()}`;
  },

  async describe_image({ image_id, prompt }) {
    const result = await Images.readImageBuffer(image_id);
    if (!result) return `Image not found: ${image_id}`;
    const { buffer, file } = result;
    const mediaType = file.contentType || file.metadata?.contentType;
    const ANTHROPIC_OK = new Set(['image/png', 'image/jpeg', 'image/webp']);
    if (!ANTHROPIC_OK.has(mediaType)) {
      return `Cannot analyze image ${image_id}: unsupported type ${mediaType || 'unknown'}.`;
    }
    const MAX_RAW = 4 * 1024 * 1024;
    if (buffer.length > MAX_RAW) {
      const mb = (buffer.length / 1024 / 1024).toFixed(1);
      return `Image too large to analyze (${mb} MB). The vision input cap is ~5 MB raw — resize and re-upload, or describe from prior context.`;
    }
    return [
      { type: 'text', text: buildDescribeImageGuidance(prompt) },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: buffer.toString('base64'),
        },
      },
    ];
  },

  async show_attachment({ attachment_id }) {
    const { path: filepath, file } = await Attachments.streamAttachmentToTmp(attachment_id);
    const note = `Showing attachment ${file.filename}.`;
    return `__ATTACHMENT_PATH__:${filepath}|${note}|${file._id.toString()}`;
  },

  async generate_image(
    {
      prompt,
      include_beat,
      beat,
      include_recent_chat,
      aspect_ratio,
      attach_to_current_beat,
      attach_to_character,
      attach_to_beat,
      set_as_main,
    },
    context = null,
  ) {
    if (!config.gemini.apiKey && !config.gemini.vertex.project) {
      return 'Error: Gemini is not configured. Set GEMINI_VERTEX_PROJECT (+ GOOGLE_APPLICATION_CREDENTIALS) for Vertex AI, or GEMINI_API_KEY for the Developer API.';
    }
    if (!prompt && !include_beat && !include_recent_chat) {
      return 'Error: provide at least one of `prompt`, `include_beat: true`, or `include_recent_chat: true`.';
    }
    if (attach_to_character && attach_to_beat) {
      return 'Error: specify at most one of attach_to_character or attach_to_beat.';
    }

    const generateT0 = Date.now();

    let beatDoc = null;
    if (include_beat || beat) {
      try {
        beatDoc = await resolveBeat(beat);
      } catch (e) {
        if (include_beat) throw e;
      }
    }

    let targetCharacter = null;
    if (attach_to_character) {
      targetCharacter = await Characters.getCharacter(attach_to_character);
      if (!targetCharacter) {
        throw new Error(`Character not found: ${attach_to_character}`);
      }
    }

    let explicitTargetBeat = null;
    if (attach_to_beat) {
      explicitTargetBeat = await resolveBeat(attach_to_beat);
    }

    let recentMessages = [];
    if (include_recent_chat) {
      const history = await Messages.loadHistoryForLlm(config.discord.movieChannelId);
      recentMessages = history.slice(-10);
    }

    const finalPrompt = buildImagePrompt({
      userPrompt: prompt,
      beat: include_beat ? beatDoc : null,
      recentMessages,
    });

    const { buffer, contentType, usageMetadata } = await generateImageBytes({
      prompt: finalPrompt,
      aspectRatio: aspect_ratio,
    });

    if (usageMetadata) {
      try {
        await recordGeminiImageUsage({
          discordUser: context?.discordUser || null,
          channelId: context?.channelId || null,
          model: NANO_BANANA_MODEL,
          usageMetadata,
        });
      } catch (e) {
        logger.warn(`gemini token usage persist failed: ${e.message}`);
      }
    }

    let ownerType = null;
    let ownerId = null;
    let targetBeatDoc = null;
    let useCharacter = false;

    if (targetCharacter) {
      ownerType = 'character';
      ownerId = targetCharacter._id;
      useCharacter = true;
    } else if (explicitTargetBeat) {
      ownerType = 'beat';
      ownerId = explicitTargetBeat._id;
      targetBeatDoc = explicitTargetBeat;
    } else {
      const current = beatDoc || (await Plots.getCurrentBeat());
      const shouldAttachCurrent =
        attach_to_current_beat === undefined ? !!current : !!attach_to_current_beat;
      if (shouldAttachCurrent && current) {
        ownerType = 'beat';
        ownerId = current._id;
        targetBeatDoc = current;
      }
    }

    const file = await Images.uploadGeneratedImage({
      buffer,
      contentType,
      prompt: finalPrompt,
      generatedBy: 'gemini-2.5-flash-image',
      ownerType,
      ownerId,
    });

    let where = 'saved to library';
    if (useCharacter) {
      const charMeta = {
        _id: file._id,
        filename: file.filename,
        content_type: file.content_type,
        size: file.size,
        uploaded_at: file.uploaded_at,
        caption: null,
      };
      await Characters.pushCharacterImage(
        targetCharacter._id.toString(),
        charMeta,
        set_as_main,
      );
      where = `attached to character "${targetCharacter.name}"`;
    } else if (targetBeatDoc) {
      const beatMeta = {
        _id: file._id,
        filename: file.filename,
        content_type: file.content_type,
        size: file.size,
        source: 'generated',
        prompt: finalPrompt,
        generated_by: 'gemini-2.5-flash-image',
        caption: null,
        uploaded_at: file.uploaded_at,
      };
      await Plots.pushBeatImage(targetBeatDoc._id.toString(), beatMeta, set_as_main);
      where = `attached to beat "${targetBeatDoc.name}"`;
    }

    const { path: filepath } = await Images.streamImageToTmp(file._id);
    logger.info(
      `generate_image: dest=${ownerType || 'library'} bytes=${buffer.length} ${Date.now() - generateT0}ms`,
    );
    return `__IMAGE_PATH__:${filepath}|Generated image (${file._id.toString()}) ${where}.|${file._id.toString()}`;
  },

  async edit_image(
    {
      source_image_id,
      prompt,
      replace_source,
      aspect_ratio,
      attach_to_character,
      attach_to_beat,
      set_as_main,
    },
    context = null,
  ) {
    if (!config.gemini.apiKey && !config.gemini.vertex.project) {
      return 'Error: Gemini is not configured. Set GEMINI_VERTEX_PROJECT (+ GOOGLE_APPLICATION_CREDENTIALS) for Vertex AI, or GEMINI_API_KEY for the Developer API.';
    }
    if (!source_image_id) return 'Error: source_image_id is required.';
    if (!prompt || !String(prompt).trim()) {
      return 'Error: prompt is required (describe the change to make).';
    }
    if (typeof replace_source !== 'boolean') {
      return 'Error: replace_source is required (true = delete source after editing, false = keep both).';
    }
    if (attach_to_character && attach_to_beat) {
      return 'Error: specify at most one of attach_to_character or attach_to_beat.';
    }

    const editT0 = Date.now();

    const fetched = await Images.readImageBuffer(source_image_id);
    if (!fetched) return `Error: source image not found: ${source_image_id}`;
    const { buffer: srcBuffer, file: srcFile } = fetched;
    const srcContentType = srcFile.contentType || srcFile.metadata?.contentType;
    const SUPPORTED = new Set(['image/png', 'image/jpeg', 'image/webp']);
    if (!SUPPORTED.has(srcContentType)) {
      return `Error: cannot edit image ${source_image_id}: unsupported source type ${srcContentType || 'unknown'}.`;
    }
    const MAX_SRC = 7 * 1024 * 1024;
    if (srcBuffer.length > MAX_SRC) {
      const mb = (srcBuffer.length / 1024 / 1024).toFixed(1);
      return `Error: source image too large for editing (${mb} MB). NanoBanana input cap is ~7 MB — choose a smaller image, or describe the edit and use generate_image.`;
    }

    const srcOwnerType = srcFile.metadata?.owner_type || null;
    const srcOwnerId = srcFile.metadata?.owner_id || null;

    let sourceWasMain = false;
    let srcOwnerCharacter = null;
    let srcOwnerBeat = null;
    let srcOwnerNoteId = null;
    if (srcOwnerType === 'character' && srcOwnerId) {
      srcOwnerCharacter = await Characters.getCharacter(srcOwnerId.toString());
      sourceWasMain = !!(
        srcOwnerCharacter?.main_image_id && srcOwnerCharacter.main_image_id.equals(srcFile._id)
      );
    } else if (srcOwnerType === 'beat' && srcOwnerId) {
      const plot = await Plots.getPlot();
      srcOwnerBeat = (plot.beats || []).find((b) => b._id && b._id.equals(srcOwnerId)) || null;
      sourceWasMain = !!(
        srcOwnerBeat?.main_image_id && srcOwnerBeat.main_image_id.equals(srcFile._id)
      );
    } else if (srcOwnerType === 'director_note' && srcOwnerId) {
      const dn = await DirectorNotes.getDirectorNotes();
      const note = (dn.notes || []).find((n) => n._id && n._id.equals(srcOwnerId));
      if (note) {
        srcOwnerNoteId = note._id;
        sourceWasMain = !!(note.main_image_id && note.main_image_id.equals(srcFile._id));
      }
    }

    let targetCharacter = null;
    let targetBeat = null;
    let targetNoteId = null;
    if (attach_to_character) {
      targetCharacter = await Characters.getCharacter(attach_to_character);
      if (!targetCharacter) throw new Error(`Character not found: ${attach_to_character}`);
    } else if (attach_to_beat) {
      targetBeat = await resolveBeat(attach_to_beat);
    } else if (srcOwnerType === 'character' && srcOwnerCharacter) {
      targetCharacter = srcOwnerCharacter;
    } else if (srcOwnerType === 'beat' && srcOwnerBeat) {
      targetBeat = srcOwnerBeat;
    } else if (srcOwnerType === 'director_note' && srcOwnerNoteId) {
      targetNoteId = srcOwnerNoteId;
    }

    const targetOwnerId = targetCharacter
      ? targetCharacter._id
      : targetBeat
        ? targetBeat._id
        : targetNoteId || null;
    const targetOwnerType = targetCharacter
      ? 'character'
      : targetBeat
        ? 'beat'
        : targetNoteId
          ? 'director_note'
          : null;
    const targetIsSameOwner =
      targetOwnerType !== null &&
      targetOwnerType === srcOwnerType &&
      targetOwnerId &&
      srcOwnerId &&
      targetOwnerId.equals(srcOwnerId);

    const effectiveSetAsMain =
      typeof set_as_main === 'boolean' ? set_as_main : sourceWasMain && targetIsSameOwner;

    const editPrompt = String(prompt).trim();

    const { buffer, contentType, usageMetadata } = await generateImageBytes({
      prompt: editPrompt,
      aspectRatio: aspect_ratio,
      inputImage: { buffer: srcBuffer, contentType: srcContentType },
    });

    if (usageMetadata) {
      try {
        await recordGeminiImageUsage({
          discordUser: context?.discordUser || null,
          channelId: context?.channelId || null,
          model: NANO_BANANA_MODEL,
          usageMetadata,
        });
      } catch (e) {
        logger.warn(`gemini token usage persist failed: ${e.message}`);
      }
    }

    const file = await Images.uploadGeneratedImage({
      buffer,
      contentType,
      prompt: editPrompt,
      generatedBy: NANO_BANANA_MODEL,
      ownerType: targetOwnerType,
      ownerId: targetOwnerId,
    });

    let where = 'saved to library';
    if (targetCharacter) {
      const charMeta = {
        _id: file._id,
        filename: file.filename,
        content_type: file.content_type,
        size: file.size,
        uploaded_at: file.uploaded_at,
        caption: null,
      };
      await Characters.pushCharacterImage(
        targetCharacter._id.toString(),
        charMeta,
        effectiveSetAsMain,
      );
      where = `attached to character "${targetCharacter.name}"`;
    } else if (targetBeat) {
      const beatMeta = {
        _id: file._id,
        filename: file.filename,
        content_type: file.content_type,
        size: file.size,
        source: 'generated',
        prompt: editPrompt,
        generated_by: NANO_BANANA_MODEL,
        caption: null,
        uploaded_at: file.uploaded_at,
      };
      await Plots.pushBeatImage(targetBeat._id.toString(), beatMeta, effectiveSetAsMain);
      where = `attached to beat "${targetBeat.name}"`;
    } else if (targetNoteId) {
      const noteMeta = {
        _id: file._id,
        filename: file.filename,
        content_type: file.content_type,
        size: file.size,
        source: 'generated',
        prompt: editPrompt,
        generated_by: NANO_BANANA_MODEL,
        caption: null,
        uploaded_at: file.uploaded_at,
      };
      await DirectorNotes.pushDirectorNoteImage(
        targetNoteId.toString(),
        noteMeta,
        effectiveSetAsMain,
      );
      where = `attached to director's note ${targetNoteId}`;
    }

    if (replace_source) {
      try {
        if (srcOwnerType === 'character' && srcOwnerCharacter) {
          await Files.removeCharacterImage({
            character: srcOwnerCharacter._id.toString(),
            imageId: srcFile._id.toString(),
          });
        } else if (srcOwnerType === 'beat' && srcOwnerBeat) {
          await Plots.pullBeatImage(srcOwnerBeat._id.toString(), srcFile._id.toString());
          await Images.deleteImage(srcFile._id);
        } else if (srcOwnerType === 'director_note' && srcOwnerNoteId) {
          await DirectorNotes.pullDirectorNoteImage(
            srcOwnerNoteId.toString(),
            srcFile._id.toString(),
          );
          await Images.deleteImage(srcFile._id);
        } else {
          await Images.deleteImage(srcFile._id);
        }
      } catch (e) {
        logger.warn(`edit_image: source deletion failed (${srcFile._id}): ${e.message}`);
      }
    }

    const { path: filepath } = await Images.streamImageToTmp(file._id);
    logger.info(
      `edit_image: dest=${targetOwnerType || 'library'} replaced=${!!replace_source} bytes=${buffer.length} ${Date.now() - editT0}ms`,
    );
    const replacedNote = replace_source ? ', original deleted' : '';
    return `__IMAGE_PATH__:${filepath}|Edited image (${file._id.toString()}) ${where}${replacedNote}.|${file._id.toString()}`;
  },

  async export_pdf({ title }) {
    const path = await exportToPdf({ title });
    return `__PDF_PATH__:${path}`;
  },

  async export_csv({ entity, columns, filter, group_by, sort, limit, filename } = {}) {
    if (entity === 'characters') {
      const docs = await Characters.findAllCharacters();
      return runCsvExport({ entity, docs, columns, filter, group_by, sort, limit, filename });
    }
    if (entity === 'beats') {
      const docs = await Plots.listBeats();
      return runCsvExport({ entity, docs, columns, filter, group_by, sort, limit, filename });
    }
    return `Tool error (export_csv): unknown entity '${entity}'. Must be 'characters' or 'beats'.`;
  },

  async add_character_image({ character, source_url, filename, caption, set_as_main }) {
    const meta = await Files.attachImageToCharacter({
      character,
      sourceUrl: source_url,
      filename,
      caption,
      setAsMain: set_as_main,
    });
    return `Added image to ${character}.\n${compact({
      _id: meta._id.toString(),
      filename: meta.filename,
      content_type: meta.content_type,
      size: meta.size,
      is_main: meta.is_main,
    })}`;
  },

  async list_character_images({ character }) {
    const { images, main_image_id } = await Files.listCharacterImages(character);
    return compact({
      main_image_id: main_image_id ? main_image_id.toString() : null,
      images: images.map((i) => ({
        _id: i._id.toString(),
        filename: i.filename,
        content_type: i.content_type,
        size: i.size,
        caption: i.caption,
        uploaded_at: i.uploaded_at,
      })),
    });
  },

  async set_main_character_image({ character, image_id }) {
    const res = await Files.setMainCharacterImage({ character, imageId: image_id });
    return `Main image for ${res.character} set to ${res.main_image_id.toString()}.`;
  },

  async remove_character_image({ character, image_id }) {
    const res = await Files.removeCharacterImage({ character, imageId: image_id });
    return `Removed image ${res.removed.toString()} from ${res.character}. Main image is now ${
      res.main_image_id ? res.main_image_id.toString() : 'none'
    }.`;
  },

  async add_beat_attachment({ beat, source_url, filename, caption }) {
    const target = await resolveBeat(beat);
    const file = await Attachments.uploadAttachmentFromUrl({
      sourceUrl: source_url,
      filename,
      ownerType: 'beat',
      ownerId: target._id,
    });
    const meta = {
      _id: file._id,
      filename: file.filename,
      content_type: file.content_type,
      size: file.size,
      caption: caption?.trim() || null,
      uploaded_at: file.uploaded_at,
    };
    await Plots.pushBeatAttachment(target._id.toString(), meta);
    return `Added attachment to beat "${target.name}".\n${compact({
      _id: meta._id.toString(),
      filename: meta.filename,
      content_type: meta.content_type,
      size: meta.size,
      caption: meta.caption,
    })}`;
  },

  async list_beat_attachments({ beat } = {}) {
    const target = await resolveBeat(beat);
    return compact({
      beat: { _id: target._id.toString(), name: target.name },
      attachments: (target.attachments || []).map((a) => ({
        _id: a._id.toString(),
        filename: a.filename,
        content_type: a.content_type,
        size: a.size,
        caption: a.caption || null,
        uploaded_at: a.uploaded_at,
      })),
    });
  },

  async remove_beat_attachment({ beat, attachment_id }) {
    const target = await resolveBeat(beat);
    const { removed, beat: updated } = await Plots.pullBeatAttachment(
      target._id.toString(),
      attachment_id,
    );
    await Attachments.deleteAttachment(removed);
    return `Removed attachment ${removed.toString()} from beat "${updated.name}".`;
  },

  async add_character_attachment({ character, source_url, filename, caption }) {
    const meta = await Attachments.attachToCharacter({
      character,
      sourceUrl: source_url,
      filename,
      caption,
    });
    return `Added attachment to ${meta.character}.\n${compact({
      _id: meta._id.toString(),
      filename: meta.filename,
      content_type: meta.content_type,
      size: meta.size,
      caption: meta.caption,
    })}`;
  },

  async list_character_attachments({ character }) {
    const { character: name, _id, attachments } =
      await Attachments.listCharacterAttachments(character);
    return compact({
      character: { _id: _id.toString(), name },
      attachments: attachments.map((a) => ({
        _id: a._id.toString(),
        filename: a.filename,
        content_type: a.content_type,
        size: a.size,
        caption: a.caption || null,
        uploaded_at: a.uploaded_at,
      })),
    });
  },

  async remove_character_attachment({ character, attachment_id }) {
    const res = await Attachments.removeCharacterAttachment({
      character,
      attachmentId: attachment_id,
    });
    return `Removed attachment ${res.removed.toString()} from ${res.character}.`;
  },

  async tmdb_search_movie({ query, year }) {
    if (!config.tmdb.readAccessToken) {
      return 'Error: TMDB_READ_ACCESS_TOKEN is not configured. Cannot look up movies.';
    }
    const data = await Tmdb.searchMovie({ query, year });
    const results = (data.results || []).slice(0, 5).map((m) => ({
      id: m.id,
      title: m.title,
      year: (m.release_date || '').slice(0, 4) || null,
      overview_preview: preview(m.overview, 200),
      poster_url: Tmdb.posterUrl(m.poster_path),
    }));
    return compact({ query, total_results: data.total_results || 0, results });
  },

  async tmdb_get_movie({ movie_id }) {
    if (!config.tmdb.readAccessToken) {
      return 'Error: TMDB_READ_ACCESS_TOKEN is not configured. Cannot look up movies.';
    }
    const m = await Tmdb.getMovieDetails(movie_id);
    const crew = m.credits?.crew || [];
    const director = crew.find((c) => c.job === 'Director')?.name || null;
    const cast = (m.credits?.cast || []).slice(0, 8).map((c) => ({
      character: c.character,
      actor_name: c.name,
      person_id: c.id,
      photo_url: Tmdb.profileUrl(c.profile_path),
    }));
    return compact({
      id: m.id,
      title: m.title,
      year: (m.release_date || '').slice(0, 4) || null,
      overview: m.overview || '',
      runtime_minutes: m.runtime || null,
      genres: (m.genres || []).map((g) => g.name),
      director,
      poster_url: Tmdb.posterUrl(m.poster_path),
      top_cast: cast,
    });
  },

  async tmdb_get_movie_credits({ movie_id }) {
    if (!config.tmdb.readAccessToken) {
      return 'Error: TMDB_READ_ACCESS_TOKEN is not configured. Cannot look up movies.';
    }
    const data = await Tmdb.getMovieCredits(movie_id);
    const cast = (data.cast || []).map((c) => ({
      character: c.character,
      actor_name: c.name,
      person_id: c.id,
      photo_url: Tmdb.profileUrl(c.profile_path),
      order: c.order,
    }));
    return compact({ movie_id, cast });
  },

  async tmdb_search_person({ query }) {
    if (!config.tmdb.readAccessToken) {
      return 'Error: TMDB_READ_ACCESS_TOKEN is not configured. Cannot look up people.';
    }
    const data = await Tmdb.searchPerson(query);
    const results = (data.results || []).slice(0, 5).map((p) => ({
      id: p.id,
      name: p.name,
      known_for_titles: (p.known_for || [])
        .map((k) => k.title || k.name)
        .filter(Boolean)
        .slice(0, 5),
      photo_url: Tmdb.profileUrl(p.profile_path),
    }));
    return compact({ query, total_results: data.total_results || 0, results });
  },

  async tmdb_show_image({ url, caption }) {
    if (!config.tmdb.readAccessToken) {
      return 'Error: TMDB_READ_ACCESS_TOKEN is not configured. Cannot fetch TMDB images.';
    }
    if (!Tmdb.isTmdbImageUrl(url)) {
      return `Error: tmdb_show_image only accepts URLs on image.tmdb.org. Got: ${url}`;
    }
    const { path: filepath } = await Tmdb.fetchTmdbImageToTmp(url);
    const note = caption?.trim() || 'TMDB image.';
    return `__IMAGE_PATH__:${filepath}|${note}`;
  },

  async tavily_search({
    query,
    max_results,
    search_depth,
    topic,
    time_range,
    include_domains,
    exclude_domains,
  }) {
    if (!config.tavily.apiKey) {
      return 'Error: TAVILY_API_KEY is not configured. Cannot run web search.';
    }
    if (!query || !String(query).trim()) {
      return 'Error: tavily_search requires a non-empty query.';
    }
    const requested = Math.min(Math.max(Number(max_results) || 5, 1), 10);
    const body = {
      query: String(query).trim(),
      search_depth: search_depth === 'basic' ? 'basic' : 'advanced',
      topic: topic === 'news' ? 'news' : 'general',
      max_results: requested,
      include_answer: 'advanced',
      include_images: true,
      include_image_descriptions: true,
    };
    if (time_range) body.time_range = time_range;
    if (Array.isArray(include_domains) && include_domains.length) {
      body.include_domains = include_domains;
    }
    if (Array.isArray(exclude_domains) && exclude_domains.length) {
      body.exclude_domains = exclude_domains;
    }

    const data = await Tavily.search(body);

    const results = (data.results || []).slice(0, requested).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: typeof r.content === 'string' ? r.content.slice(0, 600) : '',
      score: r.score,
    }));
    const images = (data.images || []).slice(0, 5).map((img) =>
      typeof img === 'string'
        ? { url: img }
        : { url: img.url, description: img.description || null },
    );
    return compact({
      query: data.query || query,
      answer: data.answer || null,
      results,
      images,
    });
  },

  async tavily_show_image({ url, caption }) {
    if (!url || typeof url !== 'string') {
      return 'Error: tavily_show_image requires a url.';
    }
    const { path: filepath } = await Tavily.fetchTavilyImageToTmp(url);
    const note = caption?.trim() || 'Web image.';
    return `__IMAGE_PATH__:${filepath}|${note}`;
  },

  async find_repeated_phrases({ fields, sizes, min_count, top_k } = {}) {
    const fieldSet = Array.isArray(fields) && fields.length ? fields : ['desc', 'body'];
    const ns = Array.isArray(sizes) && sizes.length ? sizes : [2, 3, 4];
    const minCount = Math.max(2, Number(min_count) || 2);
    const k = Math.min(100, Math.max(1, Number(top_k) || 25));

    const beats = await Plots.listBeats();
    if (beats.length === 0) {
      return compact({ status: 'empty', message: 'No beats yet — nothing to scan.' });
    }
    const lowSignal = beats.length < 10;

    const docs = beats
      .map((b) => ({
        id: b._id.toString(),
        label: `#${b.order} ${b.name}`,
        text: fieldSet.map((f) => b[f] || '').join('\n').trim(),
      }))
      .filter((d) => d.text);

    const counts = countNgrams(docs, ns, { minCount });
    const ranked = topNgrams(counts, k);

    const trimmed = ranked.map((g) => ({
      gram: g.gram,
      n: g.n,
      count: g.count,
      sources: g.sources.slice(0, 5),
      additional_sources: Math.max(0, g.sources.length - 5),
    }));

    return compact({
      status: lowSignal ? 'low_signal' : 'ok',
      note: lowSignal
        ? `Only ${beats.length} beat(s) — repetition signal is unreliable below ~10. Reporting anyway.`
        : null,
      fields_scanned: fieldSet,
      n_sizes: ns,
      beats_scanned: docs.length,
      min_count: minCount,
      phrases: trimmed,
    });
  },

  async check_similarity({ target_type, identifier, text, threshold, top_k } = {}) {
    if (target_type !== 'character' && target_type !== 'beat') {
      return 'Error: target_type must be "character" or "beat".';
    }
    if (!identifier && !text) {
      return 'Error: provide either `identifier` (existing item) or `text` (candidate text).';
    }
    if (identifier && text) {
      return 'Error: provide `identifier` OR `text`, not both.';
    }
    const thr = typeof threshold === 'number' ? threshold : 0.6;
    const k = Math.min(20, Math.max(1, Number(top_k) || 5));

    let corpus = [];
    let targetTokens = null;
    let excludeId = null;
    let mode = identifier ? 'existing' : 'candidate_text';

    if (target_type === 'character') {
      const all = await Characters.findAllCharacters();
      corpus = all.map((c) => {
        const fields = {};
        for (const f of CHARACTER_TEXT_FIELDS) fields[f] = String(c.fields?.[f] || '');
        return { id: c._id.toString(), label: c.name, fields };
      });
      if (identifier) {
        const t = await Characters.getCharacter(identifier);
        if (!t) return `No character found for "${identifier}".`;
        excludeId = t._id.toString();
        const targetText = CHARACTER_TEXT_FIELDS.map((f) => t.fields?.[f] || '')
          .filter(Boolean)
          .join('\n');
        targetTokens = bagOfWords(targetText);
      } else {
        targetTokens = bagOfWords(text);
      }
    } else {
      const beats = await Plots.listBeats();
      corpus = beats.map((b) => {
        const fields = {};
        for (const f of BEAT_TEXT_FIELDS) fields[f] = String(b[f] || '');
        return { id: b._id.toString(), label: `#${b.order} ${b.name}`, fields };
      });
      if (identifier) {
        const t = await Plots.getBeat(identifier);
        if (!t) return `No beat found for "${identifier}".`;
        excludeId = t._id.toString();
        const targetText = BEAT_TEXT_FIELDS.map((f) => t[f] || '').filter(Boolean).join('\n');
        targetTokens = bagOfWords(targetText);
      } else {
        targetTokens = bagOfWords(text);
      }
    }

    const comparable = corpus.filter((x) => x.id !== excludeId);
    if (comparable.length === 0) {
      return compact({
        status: 'no_corpus',
        message: `No other ${target_type}s to compare against.`,
        matches: [],
      });
    }

    const matches = rankSimilar(
      { tokens: targetTokens },
      corpus,
      { threshold: thr, excludeId },
    ).slice(0, k);

    return compact({
      target_type,
      mode,
      threshold: thr,
      corpus_size: comparable.length,
      matches,
    });
  },

  async find_character_phrases({ character, sizes, fields, top_k } = {}) {
    if (!character) return 'Error: `character` is required.';
    const ns = Array.isArray(sizes) && sizes.length ? sizes : [1, 2, 3];
    const fieldSet = Array.isArray(fields) && fields.length ? fields : ['desc', 'body'];
    const k = Math.min(50, Math.max(1, Number(top_k) || 15));

    const c = await Characters.getCharacter(character);
    if (!c) return `No character found for "${character}". Use list_characters to see options.`;
    const targetName = c.name.toLowerCase();

    const beats = await Plots.listBeats();
    const featuring = beats.filter((b) =>
      (b.characters || []).some((n) => String(n).toLowerCase() === targetName),
    );

    if (featuring.length === 0) {
      return compact({
        status: 'no_beats',
        character: c.name,
        message: `${c.name} is not listed in any beat. Add them via link_character_to_beat first.`,
        phrases_by_size: {},
      });
    }

    const docs = featuring.map((b) => ({
      id: b._id.toString(),
      label: `#${b.order} ${b.name}`,
      text: fieldSet.map((f) => b[f] || '').join('\n'),
    }));

    const counts = countNgrams(docs, ns, { minCount: 2 });
    const grouped = {};
    for (const n of ns) grouped[`size_${n}`] = [];
    for (const g of counts) {
      const key = `size_${g.n}`;
      if (grouped[key]) grouped[key].push({ gram: g.gram, count: g.count });
    }
    for (const key of Object.keys(grouped)) {
      grouped[key].sort((a, b) => b.count - a.count);
      grouped[key] = grouped[key].slice(0, k);
    }

    return compact({
      status: 'ok',
      character: c.name,
      beats_featuring: featuring.length,
      total_beats: beats.length,
      fields_scanned: fieldSet,
      phrases_by_size: grouped,
    });
  },

  async similar_character({ character, focus, max_works } = {}) {
    if (!character) return 'Error: `character` is required.';
    const c = await Characters.getCharacter(character);
    if (!c) return `No character found for "${character}".`;
    if (!config.tavily.apiKey) {
      return 'Error: TAVILY_API_KEY is not configured. Cannot run external similarity search.';
    }
    const max = Math.min(10, Math.max(1, Number(max_works) || 3));
    const profile = {
      hollywood_actor: c.hollywood_actor,
      fields: c.fields || {},
    };
    const hasContent =
      profile.hollywood_actor ||
      CHARACTER_TEXT_FIELDS.some((f) => String(profile.fields?.[f] || '').trim());
    if (!hasContent) {
      return `Error: character "${c.name}" has no descriptive fields to search on. Add background_story / arc / events / memes (or hollywood_actor) first.`;
    }
    const query = buildSimilarityQuery({ kind: 'character', profile, focus });
    const results = await runSimilaritySearch({ query });
    const { system, user } = buildAnalysisPrompt({
      kind: 'character',
      profile,
      results,
      maxWorks: max,
    });
    const analysis = await analyzeText({ system, user });
    return `Similarity scan for **${c.name}** (query: \`${query}\`)\n\n${
      analysis || '(no analysis returned)'
    }`;
  },

  async similar_works({ scope, beat, focus, max_works } = {}) {
    const s = scope === 'beat' ? 'beat' : 'plot';
    if (!config.tavily.apiKey) {
      return 'Error: TAVILY_API_KEY is not configured. Cannot run external similarity search.';
    }
    const max = Math.min(10, Math.max(1, Number(max_works) || 3));
    let kind;
    let profile;
    let label;

    if (s === 'plot') {
      const plot = await Plots.getPlot();
      const synopsis = String(plot.synopsis || '').trim();
      const beats = [...(plot.beats || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
      if (!synopsis && beats.length === 0) {
        return 'Error: plot has no synopsis and no beats yet. Add some content before scanning for similar works.';
      }
      kind = 'plot';
      profile = { synopsis, beats };
      label = 'the current plot';
    } else {
      const target = await resolveBeat(beat);
      if (!String(target.desc || '').trim() && !String(target.body || '').trim()) {
        return `Error: beat "${target.name}" has no desc or body to analyze yet.`;
      }
      kind = 'beat';
      profile = { name: target.name, desc: target.desc, body: target.body };
      label = `beat #${target.order} ${target.name}`;
    }

    const query = buildSimilarityQuery({ kind, profile, focus });
    const results = await runSimilaritySearch({ query });
    const { system, user } = buildAnalysisPrompt({
      kind,
      profile,
      results,
      maxWorks: max,
    });
    const analysis = await analyzeText({ system, user });
    return `Similarity scan for ${label} (query: \`${query}\`)\n\n${
      analysis || '(no analysis returned)'
    }`;
  },

  async search_message_history({
    pattern,
    flags,
    since_days,
    until_days,
    role,
    limit,
    context_chars,
  } = {}) {
    if (!pattern || typeof pattern !== 'string') {
      return 'Error: `pattern` is required.';
    }
    const safeFlags = String(flags || 'i').replace(/[^imsu]/g, '');
    let regex;
    try {
      regex = new RegExp(pattern, safeFlags);
    } catch (e) {
      return `Error: invalid regex /${pattern}/${safeFlags}: ${e.message}`;
    }
    const { results, scanned, scan_limit_hit } = await Messages.searchMessages({
      channelId: config.discord.movieChannelId,
      regex,
      sinceDays: since_days,
      untilDays: until_days,
      role: role === 'user' || role === 'assistant' ? role : 'any',
      limit: Math.min(50, Math.max(1, Number(limit) || 20)),
      contextChars: Math.min(500, Math.max(40, Number(context_chars) || 200)),
    });
    return compact({
      pattern,
      flags: safeFlags,
      scanned,
      scan_limit_hit,
      match_count: results.length,
      results: results.map((r) => ({
        _id: r._id?.toString ? r._id.toString() : String(r._id),
        discord_message_id: r.discord_message_id,
        role: r.role,
        created_at: r.created_at,
        author_tag: r.author_tag,
        excerpt: r.excerpt,
        match: r.match,
      })),
    });
  },

  async analyze_dramatic_arc({ metric, fields } = {}) {
    const m = metric === 'steepest_drop' ? 'steepest_drop' : 'max_deviation';
    const fieldSet = Array.isArray(fields) && fields.length ? fields : ['desc', 'body'];

    const beats = await Plots.listBeats();
    if (beats.length === 0) {
      return compact({ status: 'empty', message: 'No beats yet.' });
    }
    if (beats.length < 3) {
      return compact({
        status: 'low_signal',
        message: `Only ${beats.length} beat(s); arc analysis needs at least 3.`,
      });
    }

    const series = beats.map((b) => ({
      id: b._id.toString(),
      order: b.order,
      name: b.name,
      text: fieldSet.map((f) => b[f] || '').join('\n'),
    }));

    const result = detectClimax(series, m);
    if (result.error) {
      return compact({ status: 'no_signal', message: result.error });
    }

    const climaxBeat = result.climax
      ? beats.find((b) => b._id.toString() === result.climax.id)
      : null;

    return compact({
      status: 'ok',
      metric: result.metric,
      baseline_comparative: result.baseline,
      expected_climax_window: result.expected_window,
      in_expected_window: result.in_expected_window,
      note: result.in_expected_window
        ? 'Detected climax sits in the conventional 75–90% window.'
        : 'Detected climax is outside the conventional 75–90% window — may indicate a front-loaded or misplaced peak.',
      climax: result.climax && {
        beat: {
          id: result.climax.id,
          order: result.climax.order,
          name: climaxBeat?.name || null,
        },
        comparative_sentiment: result.climax.comparative,
        delta: result.climax.deviation_or_drop,
        normalized_position: result.climax.normalized_position,
      },
      series: result.series,
    });
  },

  async calculator({ expression, precision } = {}) {
    if (typeof expression !== 'string' || !expression.trim()) {
      return 'Calculator error: `expression` is required.';
    }
    const p = Math.min(64, Math.max(4, Number(precision) || 14));
    try {
      const value = mj.evaluate(expression);
      let formatted;
      if (mj.isBigNumber(value) && value.isInteger()) {
        formatted = value.toFixed(0);
      } else {
        formatted = mj.format(value, { precision: p });
      }
      return compact({ expression, result: formatted });
    } catch (e) {
      return `Calculator error: ${e.message}`;
    }
  },

  async run_code({ code, timeout_ms } = {}) {
    if (typeof code !== 'string' || !code.trim()) {
      return 'run_code error: `code` is required.';
    }
    const result = runJsInVm(code, { timeoutMs: timeout_ms });
    return compact(result);
  },

  async token_usage_report({ window, user } = {}) {
    const w = String(window || '').toLowerCase();
    if (!['day', 'week', 'month', 'total'].includes(w)) {
      return "Error: window must be one of 'day', 'week', 'month', 'total'.";
    }
    const now = Date.now();
    const sinceFor = {
      day: new Date(now - 24 * 60 * 60 * 1000),
      week: new Date(now - 7 * 24 * 60 * 60 * 1000),
      month: new Date(now - 30 * 24 * 60 * 60 * 1000),
      total: null,
    };
    const since = sinceFor[w];

    const userQuery = typeof user === 'string' && user.trim() ? user.trim() : null;
    const [userRows, toolRows, sectionStats] = await Promise.all([
      aggregateUsage({ since, userQuery }),
      aggregateToolUsage({ since, userQuery }),
      aggregateSectionTokens({ since, userQuery }),
    ]);

    if (!userRows.length) {
      if (userQuery) {
        return `No token usage recorded for '${userQuery}' in this window.`;
      }
      return `No token usage recorded in the ${w} window.`;
    }

    const fmt = (n) => Number(n || 0).toLocaleString('en-US');
    const lines = [];
    lines.push(`**Token usage — ${w}** (${userQuery ? `filter: ${userQuery}` : 'all users'})`);
    lines.push('');
    if (userQuery && userRows.length === 1) {
      const r = userRows[0];
      lines.push(`| User | Anthropic text | Anthropic image | Gemini image | Total |`);
      lines.push(`|---|---:|---:|---:|---:|`);
      lines.push(
        `| ${r.discord_user_display_name} | ${fmt(r.anthropic_text)} | ` +
          `${fmt(r.anthropic_image_input)} | ${fmt(r.gemini_image)} | ${fmt(r.total)} |`,
      );
    } else {
      lines.push(`| Rank | User | Anthropic text | Anthropic image | Gemini image | Total |`);
      lines.push(`|---:|---|---:|---:|---:|---:|`);
      userRows.forEach((r, i) => {
        lines.push(
          `| ${i + 1} | ${r.discord_user_display_name} | ${fmt(r.anthropic_text)} | ` +
            `${fmt(r.anthropic_image_input)} | ${fmt(r.gemini_image)} | ${fmt(r.total)} |`,
        );
      });
    }

    if (toolRows.length) {
      lines.push('');
      lines.push('**Tool usage** (estimated tokens from tool_result payloads)');
      lines.push('');
      lines.push(`| Rank | Tool | Invocations | Est. tokens |`);
      lines.push(`|---:|---|---:|---:|`);
      toolRows.slice(0, 20).forEach((r, i) => {
        lines.push(
          `| ${i + 1} | ${r.tool_name} | ${fmt(r.invocations)} | ${fmt(r.result_tokens)} |`,
        );
      });
      if (toolRows.length > 20) {
        lines.push('');
        lines.push(`_Top 20 of ${toolRows.length} tools shown._`);
      }
    }

    if (sectionStats && sectionStats.sample_count > 0) {
      const avg = sectionStats.averages;
      const total = avg.total || 0;
      const pct = (v) => (total > 0 ? `${((v / total) * 100).toFixed(1)}%` : '0.0%');
      lines.push('');
      lines.push(
        `**Prompt budget allocation** (averages over ${sectionStats.sample_count} turn${sectionStats.sample_count === 1 ? '' : 's'})`,
      );
      lines.push('');
      lines.push(`| Section | Avg tokens | % of total |`);
      lines.push(`|---|---:|---:|`);
      lines.push(`| System prompt | ${fmt(avg.system)} | ${pct(avg.system)} |`);
      lines.push(`| Director's notes | ${fmt(avg.director_notes)} | ${pct(avg.director_notes)} |`);
      lines.push(`| Tool definitions | ${fmt(avg.tools)} | ${pct(avg.tools)} |`);
      lines.push(`| Message history | ${fmt(avg.message_history)} | ${pct(avg.message_history)} |`);
      lines.push(`| User input | ${fmt(avg.user_input)} | ${pct(avg.user_input)} |`);
      lines.push(`| **Total** | **${fmt(total)}** | **100.0%** |`);
    }

    const textBody = lines.join('\n');

    const chartT0 = Date.now();
    const paths = [];
    try {
      paths.push(await renderTokenUsageChart({ window: w, rows: userRows }));
    } catch (e) {
      logger.warn(`user chart render failed: ${e.message}`);
    }
    if (toolRows.length) {
      try {
        paths.push(await renderToolTokensChart({ window: w, rows: toolRows }));
      } catch (e) {
        logger.warn(`tool tokens chart render failed: ${e.message}`);
      }
      try {
        paths.push(await renderToolInvocationsChart({ window: w, rows: toolRows }));
      } catch (e) {
        logger.warn(`tool invocations chart render failed: ${e.message}`);
      }
    }
    if (sectionStats && sectionStats.sample_count > 0) {
      try {
        paths.push(await renderSectionAllocationChart({ window: w, sectionStats }));
      } catch (e) {
        logger.warn(`section allocation chart render failed: ${e.message}`);
      }
    }

    if (paths.length) {
      logger.info(`chart render: ${paths.length} chart(s) ${Date.now() - chartT0}ms`);
    }
    if (!paths.length) return textBody;
    return `__IMAGE_PATHS__:${paths.join('\t')}|${textBody}`;
  },
};

export async function dispatchTool(name, input, context = null) {
  const fn = HANDLERS[name];
  if (!fn) return `Unknown tool: ${name}`;
  try {
    return await fn(input || {}, context);
  } catch (e) {
    return `Tool error (${name}): ${e.message}`;
  }
}
