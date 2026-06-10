import { getDb } from './client.js';
import { resolveProjectId } from './projects.js';

const col = () => getDb().collection('prompts');

// Composite per-project doc ids: '<projectId>:character_template' etc.
// No lazy claim of the legacy singleton ids — scripts/migrate-multi-project.js
// re-keys them (insert-new + delete-old; string _ids are immutable).
export function promptDocId(projectId, name) {
  return `${projectId}:${name}`;
}

export async function getCharacterTemplate(projectId) {
  projectId = await resolveProjectId(projectId);
  return col().findOne({ _id: promptDocId(projectId, 'character_template') });
}

export async function setCharacterTemplate(projectId, doc) {
  projectId = await resolveProjectId(projectId);
  await col().updateOne(
    { _id: promptDocId(projectId, 'character_template') },
    { $set: { ...doc, project_id: projectId, updated_at: new Date() } },
    { upsert: true },
  );
  return getCharacterTemplate(projectId);
}

export async function updateCharacterTemplateFields({ projectId, add = [], remove = [] }) {
  projectId = await resolveProjectId(projectId);
  const tpl = await getCharacterTemplate(projectId);
  let fields = tpl?.fields ? [...tpl.fields] : [];
  for (const name of remove) {
    const target = fields.find((f) => f.name === name);
    if (target?.core) throw new Error(`Cannot remove core field: ${name}`);
    fields = fields.filter((f) => f.name !== name);
  }
  for (const f of add) {
    if (fields.some((x) => x.name === f.name)) continue;
    fields.push({ name: f.name, description: f.description, required: !!f.required, core: false });
  }
  return setCharacterTemplate(projectId, { fields });
}

export async function getPlotTemplate(projectId) {
  projectId = await resolveProjectId(projectId);
  return col().findOne({ _id: promptDocId(projectId, 'plot_template') });
}

export async function setPlotTemplate(projectId, doc) {
  projectId = await resolveProjectId(projectId);
  await col().updateOne(
    { _id: promptDocId(projectId, 'plot_template') },
    { $set: { ...doc, project_id: projectId, updated_at: new Date() } },
    { upsert: true },
  );
  return getPlotTemplate(projectId);
}
