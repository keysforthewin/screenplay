// The parameters that actually reached the image provider are recorded on the
// artwork as `generation` — requested model vs the endpoint that ran, the
// prompt, and which reference images were sent — so a user can open any
// thumbnail and see exactly what produced it. The artwork's own `model` field
// stays the picker id the user chose: the old behavior of overwriting it with
// the routed endpoint id (e.g. 'flux-2-pro' → 'fal-ai/flux-2-pro/edit') broke
// regenerate/retry, which validate the stored model against the picker list.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const imageBlobs = new Map();
vi.mock('../src/mongo/images.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readImageBuffer: vi.fn(async (id) => imageBlobs.get(String(id)) || null),
  uploadGeneratedImage: vi.fn(async (_projectId, { filename, buffer, contentType }) => {
    const file = { _id: new ObjectId(), filename, contentType: contentType || 'image/png', metadata: {} };
    imageBlobs.set(String(file._id), { buffer, file });
    return file;
  }),
}));

const dispatchMock = vi.fn(async () => ({
  buffer: Buffer.from('rendered'),
  contentType: 'image/png',
  model: 'fal-ai/flux-2-pro/edit',
  inputImageCount: 1,
}));
vi.mock('../src/web/imageReplaceDispatch.js', () => ({
  dispatchImageReplace: dispatchMock,
  ALLOWED_IMAGE_MODELS: ['nano-banana-pro', 'flux-2-pro', 'flux-pro-kontext', 'openai'],
}));

vi.mock('../src/discord/announcer.js', () => ({
  announceMediaEvent: vi.fn(async () => {}),
}));

vi.mock('../src/llm/referenceImageDescription.js', () => ({
  describeReferenceImage: vi.fn(async () => ({ name: 'n', description: 'd' })),
  REFERENCE_KINDS: ['auto', 'character', 'location', 'prop'],
}));

const { createProject } = await import('../src/mongo/projects.js');
const Sets = await import('../src/mongo/sets.js');
const Artworks = await import('../src/mongo/artworks.js');
const ArtworkJobs = await import('../src/web/artworkJobs.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  imageBlobs.clear();
  dispatchMock.mockClear();
  projectId = (await createProject('Test Project'))._id.toString();
});

function seedReference() {
  const id = new ObjectId();
  imageBlobs.set(String(id), {
    buffer: Buffer.from('ref-bytes'),
    file: { contentType: 'image/png', metadata: {} },
  });
  return id.toString();
}

async function renderOne({ referenceImageIds = [] } = {}) {
  const set = await Sets.createSet({ projectId, name: 'Alley' });
  const hostId = set._id.toString();
  const { artwork } = await Artworks.createPendingArtwork({
    projectId,
    hostType: 'set',
    hostId,
    prompt: 'sodium-lit alley, wet asphalt',
    model: 'flux-2-pro',
    referenceImageIds,
  });
  await ArtworkJobs.generateArtworkImageInline({
    projectId,
    hostType: 'set',
    hostId,
    artworkId: artwork._id.toString(),
    prompt: 'sodium-lit alley, wet asphalt',
    model: 'flux-2-pro',
    referenceImageIds,
  });
  const out = await Artworks.getArtwork({
    projectId,
    hostType: 'set',
    hostId,
    artworkId: artwork._id.toString(),
  });
  return out.artwork;
}

describe('generateArtworkImageInline generation record', () => {
  it('records requested model, endpoint, prompt, and the references sent', async () => {
    const refId = seedReference();
    const art = await renderOne({ referenceImageIds: [refId] });

    expect(art.generation).toBeTruthy();
    expect(art.generation.requested_model).toBe('flux-2-pro');
    expect(art.generation.endpoint).toBe('fal-ai/flux-2-pro/edit');
    expect(art.generation.mode).toBe('generate');
    expect(art.generation.prompt).toBe('sodium-lit alley, wet asphalt');
    expect(art.generation.reference_image_ids).toEqual([refId]);
    expect(art.generation.reference_sent_count).toBe(1);
    expect(art.generation.completed_at).toBeTruthy();
  });

  it('keeps the artwork model as the picker id instead of the routed endpoint', async () => {
    const refId = seedReference();
    const art = await renderOne({ referenceImageIds: [refId] });
    expect(art.model).toBe('flux-2-pro');
  });

  it('falls back to the loaded reference count when the provider reports none', async () => {
    dispatchMock.mockResolvedValueOnce({
      buffer: Buffer.from('rendered'),
      contentType: 'image/png',
      model: 'gpt-image-2',
    });
    const refId = seedReference();
    const art = await renderOne({ referenceImageIds: [refId] });
    expect(art.generation.reference_sent_count).toBe(1);
    expect(art.generation.endpoint).toBe('gpt-image-2');
  });

  it('records generation with zero references for a prompt-only render', async () => {
    dispatchMock.mockResolvedValueOnce({
      buffer: Buffer.from('rendered'),
      contentType: 'image/png',
      model: 'fal-ai/flux-2-pro',
      inputImageCount: 0,
    });
    const art = await renderOne();
    expect(art.generation.reference_image_ids).toEqual([]);
    expect(art.generation.reference_sent_count).toBe(0);
    expect(art.model).toBe('flux-2-pro');
  });
});
