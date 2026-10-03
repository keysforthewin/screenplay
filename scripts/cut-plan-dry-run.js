#!/usr/bin/env node
// Manual live check of the cut planner's prompts. Not part of the suite.
//
//   node scripts/cut-plan-dry-run.js <beat order> [scene order] [--project "Title"] [--direction "…"] [--json out.json]
//
// Plans ONE existing scene of a beat with the real model — shot table, blocks,
// start/end still prompts, then the review pass — and prints the result.
// NOTHING IS SAVED and nothing is rendered: the scene's stored cuts, frames
// and clips are untouched. It costs four model calls on the scene & cut
// planning slot.

import fsp from 'node:fs/promises';
import { connectMongo, closeMongo } from '../src/mongo/client.js';
import { loadModelOverrides } from '../src/mongo/appSettings.js';
import { getDefaultProject, getProjectByTitle } from '../src/mongo/projects.js';
import { getPlot } from '../src/mongo/plots.js';
import { listVideoScenes } from '../src/mongo/videoScenes.js';
import { planSceneDryRun } from '../src/web/cutPlanner.js';
import { findRepeatedSetups } from '../src/web/cutCoverage.js';
import { cameraTravels, cutHandles } from '../src/web/cutTiming.js';

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const valued = new Set(['--project', '--direction', '--json']);
  const positional = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]));
  const beatOrder = Number(positional[0]);
  const sceneOrder = Number(positional[1] || 1);
  if (!Number.isInteger(beatOrder) || beatOrder < 1) {
    console.error('usage: node scripts/cut-plan-dry-run.js <beat order> [scene order] [--project "Title"] [--direction "…"] [--json out.json] [--montage ["subject; subject"]]');
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
  const scenes = await listVideoScenes({ projectId, beatId: beat._id });
  const scene = scenes[sceneOrder - 1];
  if (!scene) throw new Error(`Beat "${beat.name}" has ${scenes.length} scene(s); no scene ${sceneOrder}. Plan the beat once on the Prompts tab first.`);

  console.log(`Dry run — "${project.title}" · beat ${beatOrder} "${beat.name}" · scene ${sceneOrder} "${scene.title || scene.slug}" (nothing is saved)\n`);
  const t0 = Date.now();
  // --montage ["subject; subject"]: plan a scene stored before scenes had a kind as a montage.
  const montage = argv.includes('--montage');
  const subjects = montage ? String(flag(argv, '--montage') || '').split(';').map((x) => x.trim()).filter((x) => x && !x.startsWith('--')) : [];
  const out = await planSceneDryRun({
    projectId,
    sceneId: String(scene._id),
    direction: flag(argv, '--direction') || '',
    sceneOverrides: montage ? { kind: 'montage', ...(subjects.length ? { montage_subjects: subjects } : {}) } : {},
  });
  if (out.scene.kind === 'montage') console.log(`Montage — subjects: ${(out.scene.montage_subjects || []).join('; ') || '(none listed)'}`);
  console.log(`Intention: ${out.scene.intention || '—'}`);
  console.log(`Tempo: ${out.scene.tempo || '—'}`);
  console.log(`Lengths: ${out.cuts.map((c) => `${c.duration_seconds}s`).join(' · ')}  (total ${out.cuts.reduce((m, c) => m + (c.duration_seconds || 0), 0)} s)\n`);
  for (const c of out.cuts) {
    const cam = c.camera || {};
    const h = cutHandles(c);
    console.log(`── Cut ${out.scene.order}.${c.cut_index} — ${c.title || ''}${c.continues_previous ? '  [continues previous cut]' : ''}`);
    console.log(`   camera: ${cam.size || '?'}, ${cam.angle || '?'}, ${cam.side || '?'} — on ${c.action_by || 'no one'}`);
    console.log(`   ${c.duration_seconds} s${h.head || h.tail ? ` (+${h.head + h.tail} s handles, trimmed at assembly)` : ''} · ${cam.size || '?'} · ${cam.movement || 'static'}${cameraTravels(c) ? ` · travel: ${cam.travel || '—'}${cam.travel_widths != null ? ` (${cam.travel_widths} frame-widths)` : ''}` : ''}`);
    console.log(`   action: ${c.action || '—'}`);
    console.log(`   felt intent: ${c.felt_intent || '—'}`);
    console.log(`   hook: ${c.hook || '—'}`);
    console.log(`   BLOCK: ${c.prompt || '—'}`);
    console.log(`   START: ${c.start_frame?.prompt || '—'}`);
    console.log(`   END${c.end_frame?.derive ? ' (derived from the start frame)' : ''}: ${c.end_frame?.prompt || '—'}`);
    if (c.lint?.length) console.log(`   lint: ${c.lint.map((l) => `${l.code} — ${l.message}`).join(' | ')}`);
    console.log('');
  }
  const repeats = findRepeatedSetups(out.cuts);
  console.log(repeats.length ? `Repeated setups: ${repeats.map((r) => `cuts ${r.index} and ${r.index + 1}`).join('; ')}` : 'Repeated setups: none');
  const review = out.events.filter((e) => e.startsWith('✎ '));
  console.log(`Review notes (${review.length}):`);
  for (const e of review) console.log(`  ${e}`);
  if (out.warnings.length) {
    console.log(`\nWarnings (${out.warnings.length}):`);
    for (const w of out.warnings) console.log(`  ⚠ ${w}`);
  }
  console.log(`\n${Math.round((Date.now() - t0) / 1000)} s · ${out.usage.input_tokens} in / ${out.usage.output_tokens} out · ${out.usage.model || ''}`);
  const json = flag(argv, '--json');
  if (json) {
    await fsp.writeFile(json, JSON.stringify(out, null, 2));
    console.log(`wrote ${json}`);
  }
}

main()
  .catch((e) => {
    console.error(e?.stack || e?.message || e);
    process.exitCode = 1;
  })
  .finally(() => closeMongo().catch(() => {}));
