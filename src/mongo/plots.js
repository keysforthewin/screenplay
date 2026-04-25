import { getDb } from './client.js';

const col = () => getDb().collection('plots');

export async function getPlot() {
  const existing = await col().findOne({ _id: 'main' });
  if (existing) return existing;
  const seed = { _id: 'main', synopsis: '', beats: [], notes: '', updated_at: new Date() };
  await col().insertOne(seed);
  return seed;
}

export async function updatePlot(patch) {
  await getPlot();
  const set = { updated_at: new Date() };
  if (patch.synopsis !== undefined) set.synopsis = patch.synopsis;
  if (Array.isArray(patch.beats)) set.beats = patch.beats;
  if (patch.notes !== undefined) set.notes = patch.notes;
  await col().updateOne({ _id: 'main' }, { $set: set });
  return getPlot();
}
