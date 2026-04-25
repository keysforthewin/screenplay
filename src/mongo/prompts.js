import { getDb } from './client.js';

const col = () => getDb().collection('prompts');

export async function getCharacterTemplate() {
  return col().findOne({ _id: 'character_template' });
}

export async function setCharacterTemplate(doc) {
  await col().updateOne(
    { _id: 'character_template' },
    { $set: { ...doc, updated_at: new Date() } },
    { upsert: true },
  );
  return getCharacterTemplate();
}

export async function updateCharacterTemplateFields({ add = [], remove = [] }) {
  const tpl = await getCharacterTemplate();
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
  return setCharacterTemplate({ fields });
}

export async function getPlotTemplate() {
  return col().findOne({ _id: 'plot_template' });
}

export async function setPlotTemplate(doc) {
  await col().updateOne(
    { _id: 'plot_template' },
    { $set: { ...doc, updated_at: new Date() } },
    { upsert: true },
  );
  return getPlotTemplate();
}
