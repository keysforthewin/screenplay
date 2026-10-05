#!/usr/bin/env node
// Manual live check of the artwork critique's two phases. Not part of the suite.
//
//   node scripts/artwork-review-dry-run.js <beat order> [--project "Title"] [--subject "name"] [--review 2]
//
// For ONE subject of the beat (the first with artwork, or --subject), using
// the requirements already stored by a critique run: phase 1 matches them
// against every artwork's description (one text call, storyboard slot), then
// the reviewer scores the first --review candidates on the rubric (one vision
// call, artwork_review slot). NOTHING IS SAVED.

import { connectMongo, closeMongo } from '../src/mongo/client.js';
import { loadModelOverrides } from '../src/mongo/appSettings.js';
import { getDefaultProject, getProjectByTitle } from '../src/mongo/projects.js';
import { getPlot } from '../src/mongo/plots.js';
import { modelFor } from '../src/llm/modelSlots.js';
import { critiqueSubjectDryRun } from '../src/web/artworkCritique.js';

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

const argv = process.argv.slice(2);
const order = Number(argv[0]);
if (!Number.isInteger(order)) {
  console.error('usage: node scripts/artwork-review-dry-run.js <beat order> [--project "Title"] [--subject "name"] [--review 2]');
  process.exit(1);
}

await connectMongo();
await loadModelOverrides();
try {
  const title = flag(argv, '--project');
  const project = title ? await getProjectByTitle(title) : await getDefaultProject();
  if (!project) throw new Error(`no such project: ${title}`);
  const projectId = project._id.toString();
  const beat = ((await getPlot(projectId)).beats || []).find((b) => b.order === order);
  if (!beat) throw new Error(`no beat at order ${order}`);
  console.log(`Beat #${beat.order}: ${beat.name}\nmatch on ${modelFor('storyboard')} · review on ${modelFor('artwork_review')}\n`);
  const out = await critiqueSubjectDryRun({ projectId, beatId: beat._id.toString(), subjectName: flag(argv, '--subject') || '', reviewLimit: Number(flag(argv, '--review')) || 2 });
  const nameOf = new Map(out.subject.artworks.map((a) => [String(a._id), a.name || 'untitled']));
  console.log(`${out.subject.kind.toUpperCase()} "${out.subject.name}" — ${out.subject.artworks.length} artworks, ${out.requirements.length} requirements\n`);
  console.log('PHASE 1 — coverage by description');
  for (const r of out.requirements) {
    const ms = out.matches.filter((m) => m.requirement_id === r.id);
    console.log(`  ${ms.length ? '✓' : '✗'} ${r.id} ${r.summary}`);
    for (const m of ms) console.log(`      ${m.fit === 'covered' ? 'covered' : 'partial'}  "${nameOf.get(m.artwork_id)}"${m.lacking ? ` — lacks: ${m.lacking}` : ''}`);
  }
  const answered = out.requirements.filter((r) => out.matches.some((m) => m.requirement_id === r.id)).length;
  console.log(`  → ${answered}/${out.requirements.length} requirements have a picture; ${out.duplicates.length} duplicate group(s)\n`);
  console.log('PHASE 2 — rubric review');
  for (const e of out.reviews) {
    console.log(`  "${e.name}" → ${e.score ?? '?'}/10, ${e.action}${e.regenerate_reason ? ` (${e.regenerate_reason})` : ''}`);
    for (const c of e.criteria) console.log(`      ${String(c.score).padStart(2)}  ${c.key}: ${c.note}`);
    for (const f of e.fits) console.log(`      fits ${f.requirement_id}: ${f.fit}${f.lacking ? ` — ${f.lacking}` : ''}`);
    for (const i of e.issues) console.log(`      issue [${i.kind}] ${i.note}`);
    if (e.suggested_edit) console.log(`      edit: ${e.suggested_edit}`);
  }
  for (const w of out.warnings) console.log(`warning: ${w}`);
} finally {
  await closeMongo();
}
