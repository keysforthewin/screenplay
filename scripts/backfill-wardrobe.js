#!/usr/bin/env node
// Fill the `wardrobe` field (the wardrobe lock, src/web/wardrobe.js) of
// characters that have none, from what the project already says about them:
// the character card, the beat that introduces them and the paragraphs of the
// next beats that name them. One model call per character on the writer slot.
//
//   node scripts/backfill-wardrobe.js [--project "Title" | --all-projects]
//                                     [--character "Name"] [--overwrite]
//                                     [--slot writer|analysis|…] [--apply]
//
// DRY RUN BY DEFAULT: prints each proposed wardrobe with the quotes it rests
// on (or "invented" when the pages say nothing about clothes) and writes
// nothing. `--apply` saves them through the gateway (the same path the
// character page uses, so an open editor updates live). Characters that
// already have a wardrobe are skipped unless `--overwrite`. Idempotent: a
// second run finds nothing to do.

import { connectMongo, closeMongo } from '../src/mongo/client.js';
import { loadModelOverrides } from '../src/mongo/appSettings.js';
import { getDefaultProject, getProjectByTitle, listProjects } from '../src/mongo/projects.js';
import { getPlot } from '../src/mongo/plots.js';
import { findAllCharacters } from '../src/mongo/characters.js';
import { updateCharacterViaGateway } from '../src/web/gateway.js';
import { proposeWardrobe } from '../src/web/wardrobeBackfill.js';
import { WARDROBE_FIELD } from '../src/web/wardrobe.js';
import { stripMarkdown } from '../src/util/markdown.js';

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: node scripts/backfill-wardrobe.js [--project "Title" | --all-projects] [--character "Name"] [--overwrite] [--slot writer] [--apply]');
    process.exit(0);
  }
  const apply = argv.includes('--apply');
  const overwrite = argv.includes('--overwrite');
  const slot = flag(argv, '--slot') || 'writer';
  const only = flag(argv, '--character');

  await connectMongo();
  await loadModelOverrides();
  let projects;
  if (argv.includes('--all-projects')) projects = await listProjects();
  else {
    const title = flag(argv, '--project');
    const p = title ? await getProjectByTitle(title) : await getDefaultProject();
    if (!p) throw new Error(`Project not found: ${title}`);
    projects = [p];
  }

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — wardrobe backfill on ${projects.map((p) => `"${p.title}"`).join(', ')} (slot: ${slot})\n`);
  let written = 0, skipped = 0, failed = 0;
  for (const project of projects) {
    const projectId = project._id.toString();
    const plot = await getPlot(projectId);
    const characters = await findAllCharacters(projectId);
    for (const character of characters) {
      const name = stripMarkdown(character.name || '').trim();
      if (only && name.toLowerCase() !== only.toLowerCase()) continue;
      const current = stripMarkdown(String(character.fields?.[WARDROBE_FIELD] || '')).trim();
      if (current && !overwrite) {
        skipped += 1;
        console.log(`• ${name} — already locked: ${current}`);
        continue;
      }
      try {
        const r = await proposeWardrobe({ plot, character, slot });
        const intro = r.context.intro ? `beat ${r.context.intro.beat.order}` : 'no beat';
        console.log(`• ${name} (introduced: ${intro}; ${r.context.appearanceCount} appearance${r.context.appearanceCount === 1 ? '' : 's'})${r.invented ? ' — INVENTED from the card' : ''}`);
        if (current) console.log(`    was: ${current}`);
        console.log(`    wardrobe: ${r.wardrobe}`);
        for (const e of r.evidence) console.log(`    ↳ ${e.beat}: “${e.quote}”`);
        if (apply) {
          await updateCharacterViaGateway(projectId, character._id.toString(), { fields: { [WARDROBE_FIELD]: r.wardrobe } });
          written += 1;
          console.log('    saved');
        }
      } catch (e) {
        failed += 1;
        console.log(`• ${name} — FAILED: ${e.message}`);
      }
    }
  }
  console.log(`\n${apply ? `Saved ${written}` : 'Dry run — nothing saved'}; ${skipped} already locked; ${failed} failed.${apply ? '' : ' Re-run with --apply to write.'}`);
}

main()
  .catch((e) => { console.error(e?.stack || e); process.exitCode = 1; })
  .finally(() => closeMongo().catch(() => {}));
