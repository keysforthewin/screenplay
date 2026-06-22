// Storyboard-driven image-sheet tuner.
//
// After a beat's storyboard is generated, this makes a second pass over the
// beat's image sheet. For each storyboard element it asks the model whether the
// beat's EXISTING plates already cover the shot's background; if not, it proposes
// ONE new static background plate. A consolidation pass then merges duplicate
// proposals and drops any already covered by an existing plate. The output is a
// list of proposed plates { name, prompt, justification, quote } rendered later
// through the normal image-sheet generate path.
//
// The per-shot scanner works from a TEXT catalog of existing plates (names +
// prompts) plus the shot's image critique — it is not fed plate images. The
// static-plate rules are shared with the beat planner via STATIC_PLATE_CONSTRAINTS.

import { getAnthropic } from '../anthropic/client.js';
import { logger } from '../log.js';
import { stripMarkdown } from '../util/markdown.js';
import { STORYBOARD_MODEL } from './storyboardGenerate.js';
import { STATIC_PLATE_CONSTRAINTS } from './beatSheetPlanner.js';

// ---------------------------------------------------------------------------
// Per-shot scan
// ---------------------------------------------------------------------------

export const SHOT_PLATE_SCAN_TOOL = {
  name: 'scan_shot_plate',
  description:
    'Decide whether a beat image sheet needs a NEW static background plate to serve one storyboard shot, and if so propose exactly one.',
  input_schema: {
    type: 'object',
    properties: {
      needs_plate: {
        type: 'boolean',
        description:
          'true ONLY if no existing plate adequately serves this shot AND a new static background plate would meaningfully help.',
      },
      name: { type: 'string', description: 'For needs_plate=true: short gallery label for the new plate.' },
      prompt: {
        type: 'string',
        description:
          'For needs_plate=true: full standalone, purely-visual static background plate prompt (location, sub-location, time of day, lighting, palette, mood, lens/framing).',
      },
      justification: {
        type: 'string',
        description: 'For needs_plate=true: one sentence on which gap this plate fills. Reviewer-facing only.',
      },
    },
    required: ['needs_plate'],
    additionalProperties: false,
  },
};

export const SHOT_PLATE_SCAN_SYSTEM_PROMPT = [
  "You are a storyboard supervisor tuning a beat's set of background PLATES (clean, characterless environment images reused as storyboard backdrops). You are given ONE storyboard shot, any critique notes on its rendered frame, and a catalog of the plates that already exist for this beat.",
  '',
  'Decide whether the existing plates already give this shot a usable background. If an existing plate already depicts this shot\'s location / sub-location / angle / lighting well enough, set needs_plate=false. Only set needs_plate=true when there is a genuine GAP — the shot happens somewhere (or from an angle, or in a lighting state) that no existing plate covers, or the image critique shows the background is wrong or missing — AND a new static plate would fix it.',
  '',
  'When needs_plate=true, propose exactly ONE new plate with a concrete, standalone, purely-visual prompt.',
  '',
  '# Plate constraints',
  STATIC_PLATE_CONSTRAINTS,
  '',
  'Be conservative: prefer needs_plate=false when an existing plate is close enough, and never propose a near-duplicate of an existing plate. Return your decision via the scan_shot_plate tool.',
].join('\n');

function formatExistingPlates(plates) {
  if (!plates?.length) return '(none yet)';
  return plates
    .map((p, i) => `${i + 1}. ${(p.name || '').trim() || '(unnamed)'} — ${(p.prompt || '').trim()}`)
    .join('\n');
}

function formatImageCritique(critique) {
  if (!critique || !Array.isArray(critique.lenses)) return '(no image critique yet)';
  const head = Number.isFinite(critique.overall) ? `overall ${critique.overall}/10` : '';
  const parts = critique.lenses
    .filter((l) => l && l.comments)
    .map((l) => `- ${l.lens} (${l.score}/10): ${stripMarkdown(String(l.comments)).trim()}`);
  return [head, ...parts].filter(Boolean).join('\n') || '(no image critique yet)';
}

export function buildShotScanUserText({ sb, existingPlates = [] }) {
  return [
    '# Storyboard shot under review',
    `summary: ${stripMarkdown(sb?.summary || '').trim() || '(none)'}`,
    `prompt: ${stripMarkdown(sb?.text_prompt || '').trim() || '(none)'}`,
    `characters in scene: ${(sb?.characters_in_scene || []).join(', ') || '(none)'}`,
    '',
    "# Image critique of this shot's rendered frame (the \"need\" signal)",
    formatImageCritique(sb?.image_critique),
    '',
    '# Existing plates in the beat image sheet (the coverage catalog)',
    formatExistingPlates(existingPlates),
    '',
    'Use the scan_shot_plate tool. Set needs_plate=true ONLY for a genuine gap.',
  ].join('\n');
}

let scanOverride = null;
export function _setShotPlateScanForTests(fn) { scanOverride = fn; }

export async function scanShotForPlateGap({ sb, existingPlates = [] }) {
  if (scanOverride) {
    try { return await scanOverride({ sb, existingPlates }); }
    catch (e) { logger.warn(`tuner scan override failed: ${e.message}`); return { needs_plate: false }; }
  }
  const userText = buildShotScanUserText({ sb, existingPlates });
  try {
    const client = getAnthropic();
    const resp = await client.messages.create({
      model: STORYBOARD_MODEL,
      max_tokens: 1200,
      system: SHOT_PLATE_SCAN_SYSTEM_PROMPT,
      tools: [SHOT_PLATE_SCAN_TOOL],
      tool_choice: { type: 'tool', name: 'scan_shot_plate' },
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    });
    const toolUse = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'scan_shot_plate');
    return toolUse?.input || { needs_plate: false };
  } catch (e) {
    logger.warn(`tuner scan failed: ${e.message}`);
    return { needs_plate: false };
  }
}

function proposalFromScan(scan) {
  if (!scan?.needs_plate) return null;
  const name = typeof scan.name === 'string' ? scan.name.trim() : '';
  const prompt = typeof scan.prompt === 'string' ? scan.prompt.trim() : '';
  if (!name || !prompt) return null;
  return {
    name,
    prompt,
    justification: typeof scan.justification === 'string' ? scan.justification.trim() : '',
    quote: '',
  };
}

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

export const CONSOLIDATE_PLATES_TOOL = {
  name: 'consolidate_plates',
  description:
    'Merge a list of proposed new background plates, dropping near-duplicates and any already covered by the existing plates.',
  input_schema: {
    type: 'object',
    properties: {
      plates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            prompt: { type: 'string' },
            justification: { type: 'string' },
          },
          required: ['name', 'prompt'],
          additionalProperties: false,
        },
      },
    },
    required: ['plates'],
    additionalProperties: false,
  },
};

export const CONSOLIDATE_PLATES_SYSTEM_PROMPT = [
  'You are consolidating a list of PROPOSED new background plates for a beat image sheet. Merge near-duplicate proposals into one, and DROP any proposal already adequately covered by an existing plate. Keep every genuinely distinct, still-needed plate. Do not invent new plates. Keep prompts purely visual and static.',
  '',
  '# Plate constraints',
  STATIC_PLATE_CONSTRAINTS,
  '',
  'Return the final deduped list via the consolidate_plates tool.',
].join('\n');

let consolidateOverride = null;
export function _setConsolidatePlatesForTests(fn) { consolidateOverride = fn; }

export async function consolidatePlateProposals({ proposals, existingPlates = [] }) {
  const list = (Array.isArray(proposals) ? proposals : []).filter(Boolean);
  if (list.length <= 1) return list; // nothing to dedup
  if (consolidateOverride) {
    try {
      const r = await consolidateOverride({ proposals: list, existingPlates });
      return Array.isArray(r) ? r : list;
    } catch (e) {
      logger.warn(`tuner consolidate override failed: ${e.message}`);
      return list;
    }
  }
  const userText = [
    '# Existing plates (already in the sheet — drop proposals these already cover)',
    formatExistingPlates(existingPlates),
    '',
    '# Proposed new plates (deduplicate and prune)',
    list
      .map((p, i) => `${i + 1}. ${p.name} — ${p.prompt}${p.justification ? ` [why: ${p.justification}]` : ''}`)
      .join('\n'),
    '',
    'Return the final deduped list via the consolidate_plates tool.',
  ].join('\n');
  try {
    const client = getAnthropic();
    const resp = await client.messages.create({
      model: STORYBOARD_MODEL,
      max_tokens: 4000,
      system: CONSOLIDATE_PLATES_SYSTEM_PROMPT,
      tools: [CONSOLIDATE_PLATES_TOOL],
      tool_choice: { type: 'tool', name: 'consolidate_plates' },
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    });
    const toolUse = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'consolidate_plates');
    const out = Array.isArray(toolUse?.input?.plates) ? toolUse.input.plates : null;
    if (!out) return list;
    return out
      .map((p) => ({
        name: typeof p?.name === 'string' ? p.name.trim() : '',
        prompt: typeof p?.prompt === 'string' ? p.prompt.trim() : '',
        justification: typeof p?.justification === 'string' ? p.justification.trim() : '',
        quote: '',
      }))
      .filter((p) => p.name && p.prompt);
  } catch (e) {
    logger.warn(`tuner consolidate failed: ${e.message}`);
    return list;
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

// Scan every storyboard shot, collect plate proposals, consolidate, and return
// the final list. onProgress(evt) receives { phase, step, frame?, total?, message }.
export async function tuneStoryboardImageSheet({ storyboards = [], existingPlates = [], onProgress = null } = {}) {
  const emit = (e) => { try { onProgress?.(e); } catch { /* best-effort */ } };

  emit({
    phase: 'scanning', step: 'scan_start', total: storyboards.length,
    message: `Scanning ${storyboards.length} shot${storyboards.length === 1 ? '' : 's'}…`,
  });
  const proposals = [];
  let done = 0;
  for (const sb of storyboards) {
    let scan;
    try { scan = await scanShotForPlateGap({ sb, existingPlates }); }
    catch (e) { logger.warn(`tuner scan shot ${sb?._id} failed: ${e.message}`); scan = { needs_plate: false }; }
    const proposal = proposalFromScan(scan);
    if (proposal) proposals.push(proposal);
    done += 1;
    emit({ phase: 'scanning', step: 'scan_progress', frame: done, total: storyboards.length, message: `Scanned ${done}/${storyboards.length}…` });
  }

  emit({
    phase: 'consolidating', step: 'consolidate_start', total: proposals.length,
    message: `Consolidating ${proposals.length} proposed plate${proposals.length === 1 ? '' : 's'}…`,
  });
  const images = await consolidatePlateProposals({ proposals, existingPlates });
  emit({ phase: 'derived', step: 'tune_done', total: images.length, message: `${images.length} new plate${images.length === 1 ? '' : 's'} proposed.` });
  return { images };
}
