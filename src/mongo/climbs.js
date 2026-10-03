// Per-beat climb records: the last "Climb" run of the writing critique
// (`plots.beats[].critique_climb`) and of the artwork critique
// (`plots.beats[].artwork_critique_climb`). Latest-only, one small object,
// always replaced wholesale. Kept beside — not inside — the critique objects
// because every critique run overwrites those, and the climb's summary has to
// outlive the runs it is made of.

import { getDb } from './client.js';
import { getBeat } from './plots.js';
import { resolveProjectId } from './projects.js';

const col = () => getDb().collection('plots');

const FIELDS = { writing: 'critique_climb', artwork: 'artwork_critique_climb' };

function fieldFor(kind) {
  const field = FIELDS[kind];
  if (!field) throw new Error(`unknown climb kind: ${kind}`);
  return field;
}

export async function getBeatClimb(projectId, beatId, kind) {
  projectId = await resolveProjectId(projectId);
  const beat = await getBeat(projectId, String(beatId));
  return beat?.[fieldFor(kind)] || null;
}

export async function setBeatClimb(projectId, beatId, kind, climb) {
  projectId = await resolveProjectId(projectId);
  const beat = await getBeat(projectId, String(beatId));
  if (!beat?._id) throw new Error(`Beat not found: ${beatId}`);
  await col().updateOne(
    { project_id: projectId },
    { $set: { [`beats.$[b].${fieldFor(kind)}`]: climb } },
    { arrayFilters: [{ 'b._id': beat._id }] },
  );
}
