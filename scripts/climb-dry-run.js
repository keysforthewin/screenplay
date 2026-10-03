#!/usr/bin/env node
// Manual live check of ONE step of the writing climb. Not part of the suite.
//
//   node scripts/climb-dry-run.js <beat order> [--project "Title"] [--mode edit|rewrite]
//                                 [--direction "…"] [--fresh] [--out body.txt] [--json out.json]
//
// Takes the beat's stored critique as the baseline (or critiques the beat in
// memory first with --fresh, or when it has none), makes one improvement the
// way the climb would — targeted edits when the beat scores 7 or higher, a
// full rewrite below, or whatever --mode says — critiques the result in
// memory, and prints the plan, the edits and the facet scores before and
// after. NOTHING IS SAVED: the beat's body and its stored critique are
// untouched. It costs one or two calls for the improvement plus seven for
// each critique, on the critique model slot.

import fsp from 'node:fs/promises';
import { connectMongo, closeMongo } from '../src/mongo/client.js';
import { loadModelOverrides } from '../src/mongo/appSettings.js';
import { getDefaultProject, getProjectByTitle } from '../src/mongo/projects.js';
import { getPlot } from '../src/mongo/plots.js';
import { modelFor } from '../src/llm/modelSlots.js';
import { FACETS } from '../src/web/critiqueFacets.js';
import { critiqueBeatInMemory } from '../src/web/critiqueGenerate.js';
import { scoreLevers } from '../src/web/critiqueScoring.js';
import { EDIT_MODE_FLOOR } from '../src/web/critiqueClimb.js';
import {
  synthesizeRewriteStrategy,
  regenerateBeatBody,
  planBeatEdits,
  applyBeatEdits,
  describeEditPlan,
  loadRewriteContext,
  formatScoreLevers,
} from '../src/web/beatRewrite.js';

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

const USAGE = 'usage: node scripts/climb-dry-run.js <beat order> [--project "Title"] [--mode edit|rewrite] [--direction "…"] [--fresh] [--out body.txt] [--json out.json]';

function issueCounts(f) {
  const n = (sev) => (f.issues || []).filter((i) => i.severity === sev).length;
  return `${n('must_fix')}M ${n('should_fix')}S`;
}

function printComparison(before, after) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\n${pad('Facet', 22)}${pad('before', 16)}after`);
  for (const def of FACETS) {
    const b = (before.facets || []).find((f) => f.key === def.key) || {};
    const a = (after.facets || []).find((f) => f.key === def.key) || {};
    const show = (f) => (f.status === 'done' ? `${f.score} (${issueCounts(f)})` : f.status === 'error' ? 'error' : '—');
    const delta = typeof a.score === 'number' && typeof b.score === 'number' ? a.score - b.score : null;
    const mark = delta == null ? '' : delta > 0 ? `  ▲ ${delta.toFixed(1)}` : delta < 0 ? `  ▼ ${Math.abs(delta).toFixed(1)}` : '';
    console.log(`${pad(def.label, 22)}${pad(show(b), 16)}${show(a)}${mark}`);
  }
  console.log(`${pad('OVERALL', 22)}${pad(before.overall ?? '—', 16)}${after.overall ?? '—'}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const valued = new Set(['--project', '--mode', '--direction', '--out', '--json']);
  const positional = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]));
  const beatOrder = Number(positional[0]);
  const wantMode = flag(argv, '--mode');
  if (!Number.isInteger(beatOrder) || beatOrder < 1 || (wantMode && !['edit', 'rewrite'].includes(wantMode))) {
    console.error(USAGE);
    process.exit(2);
  }
  await connectMongo();
  await loadModelOverrides();
  const title = flag(argv, '--project');
  const project = title ? await getProjectByTitle(title) : await getDefaultProject();
  if (!project) throw new Error(`Project not found: ${title}`);
  const projectId = project._id.toString();
  const plot = await getPlot(projectId);
  const beat = (plot.beats || []).find((b) => b.order === beatOrder);
  if (!beat) throw new Error(`No beat at order ${beatOrder} in "${project.title}"`);
  const direction = flag(argv, '--direction') || '';

  console.log(`Dry run — "${project.title}" · beat ${beatOrder} "${beat.name}" · model ${modelFor('critique')} (nothing is saved)\n`);
  const t0 = Date.now();

  let before = beat.critique;
  const usable = before?.status === 'done' && typeof before.overall === 'number';
  if (argv.includes('--fresh') || !usable) {
    console.log(usable ? 'Critiquing the beat as it stands (--fresh)…' : 'No finished critique on the beat; critiquing it as it stands…');
    before = await critiqueBeatInMemory({ projectId, beat });
    if (typeof before.overall !== 'number') throw new Error('The baseline critique failed.');
  } else {
    console.log(`Baseline: the stored critique (${before.overall}/10). If the body was edited since, pass --fresh.`);
  }
  console.log(`\n${formatScoreLevers(before).join('\n')}`);

  const ctx = await loadRewriteContext(projectId, beat);
  const args = { beat, critique: before, ctx, direction, history: [] };
  let mode = wantMode || (before.overall >= EDIT_MODE_FLOOR ? 'edit' : 'rewrite');
  let body = null;
  let plan = '';
  let edits = null;
  if (mode === 'edit') {
    console.log('Planning targeted edits…');
    const planned = await planBeatEdits(args);
    edits = applyBeatEdits(beat.body, planned.edits);
    plan = describeEditPlan({ plan: planned.plan, ...edits });
    if (edits.applied.length) body = edits.body;
    else { console.log(`None of the ${planned.edits.length} edit(s) could be placed; falling back to a full rewrite.`); mode = 'rewrite'; }
  }
  if (mode === 'rewrite') {
    console.log('Planning the rewrite…');
    plan = await synthesizeRewriteStrategy(args);
    console.log('Rewriting…');
    body = await regenerateBeatBody({ ...args, strategy: plan });
  }

  console.log(`\n── Plan (${mode === 'edit' ? 'targeted edits' : 'full rewrite'}) ──\n${plan}`);
  if (edits && mode === 'edit') {
    for (const e of edits.applied) console.log(`\n  ✎ ${e.issue}\n    - ${JSON.stringify(e.find)}\n    + ${JSON.stringify(e.replace)}`);
    for (const e of edits.skipped) console.log(`\n  ✗ ${e.issue} — skipped (${e.reason})\n    - ${JSON.stringify(e.find)}`);
  }
  console.log(`\nBody: ${String(beat.body || '').length} → ${body.length} chars. Critiquing the result…`);

  const after = await critiqueBeatInMemory({ projectId, beat: { ...beat, body } });
  printComparison(before, after);
  const levers = scoreLevers(after, FACETS).filter((l) => l.binding);
  if (levers.length) console.log(`\nStill capped: ${levers.map((l) => `${l.facet_label} (${l.must_fix}M ${l.should_fix}S)`).join(', ')}`);
  for (const f of after.facets) {
    for (const i of (f.issues || []).filter((x) => x.severity === 'must_fix')) console.log(`  must-fix [${f.label}] ${i.problem}`);
  }
  console.log(`\n(${((Date.now() - t0) / 1000).toFixed(1)} s)`);

  const out = flag(argv, '--out');
  if (out) { await fsp.writeFile(out, body); console.log(`wrote ${out}`); }
  const json = flag(argv, '--json');
  if (json) { await fsp.writeFile(json, JSON.stringify({ mode, plan, edits, body, before, after }, null, 2)); console.log(`wrote ${json}`); }
}

main()
  .catch((e) => {
    console.error(e?.stack || e?.message || e);
    process.exitCode = 1;
  })
  .finally(() => closeMongo().catch(() => {}));
