// Per-project ElevenLabs voice collection. Each doc is one voice a project
// has saved from the shared library, cloned, or designed. `added_to_account`
// tracks whether the voice exists in the ElevenLabs account's My Voices —
// shared-library voices can't be used for TTS/STS until they do (the eleven
// routes lazily add them on first use).

import { getDb } from './client.js';

const COLLECTION = 'eleven_voices';
const SOURCES = new Set(['library', 'clone', 'design']);

function requireProjectId(projectId) {
  if (!projectId) throw new Error('projectId required');
  return String(projectId);
}

function coll() {
  return getDb().collection(COLLECTION);
}

export async function listCollectionVoices(projectId) {
  const pid = requireProjectId(projectId);
  return coll().find({ project_id: pid }).sort({ created_at: 1 }).toArray();
}

export async function getCollectionVoice(projectId, voiceId) {
  const pid = requireProjectId(projectId);
  return coll().findOne({ project_id: pid, voice_id: String(voiceId) });
}

export async function addVoiceToCollection(projectId, voice = {}) {
  const pid = requireProjectId(projectId);
  const voiceId = String(voice.voice_id || '').trim();
  if (!voiceId) throw new Error('voice_id required');
  const doc = {
    project_id: pid,
    voice_id: voiceId,
    public_owner_id: voice.public_owner_id ? String(voice.public_owner_id) : null,
    name: String(voice.name || 'Unnamed voice').slice(0, 200),
    description: voice.description ? String(voice.description).slice(0, 2000) : null,
    preview_url: voice.preview_url ? String(voice.preview_url) : null,
    labels: voice.labels && typeof voice.labels === 'object' ? voice.labels : {},
    category: voice.category ? String(voice.category) : null,
    source: SOURCES.has(voice.source) ? voice.source : 'library',
    added_to_account: Boolean(voice.added_to_account),
  };
  await coll().updateOne(
    { project_id: pid, voice_id: voiceId },
    { $set: doc, $setOnInsert: { created_at: new Date() } },
    { upsert: true },
  );
  return coll().findOne({ project_id: pid, voice_id: voiceId });
}

export async function removeVoiceFromCollection(projectId, voiceId) {
  const pid = requireProjectId(projectId);
  const r = await coll().deleteOne({ project_id: pid, voice_id: String(voiceId) });
  return (r?.deletedCount || 0) > 0;
}

export async function markVoiceAddedToAccount(projectId, voiceId) {
  const pid = requireProjectId(projectId);
  await coll().updateOne(
    { project_id: pid, voice_id: String(voiceId) },
    { $set: { added_to_account: true } },
  );
}
