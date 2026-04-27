import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/tmdb/client.js', () => {
  const buildUrl = (p) =>
    p ? `https://image.tmdb.org/t/p/w500${p.startsWith('/') ? '' : '/'}${p}` : null;
  return {
    searchMovie: vi.fn(),
    getMovieDetails: vi.fn(),
    getMovieCredits: vi.fn(),
    searchPerson: vi.fn(),
    getPerson: vi.fn(),
    posterUrl: buildUrl,
    profileUrl: buildUrl,
    isTmdbImageUrl: () => true,
    fetchTmdbImageToTmp: vi.fn(),
    findActorPortraitUrl: vi.fn(),
  };
});

vi.mock('../src/mongo/files.js', () => ({
  attachImageToCharacter: vi.fn(),
  listCharacterImages: vi.fn(),
  setMainCharacterImage: vi.fn(),
  removeCharacterImage: vi.fn(),
  readCharacterImageBuffer: vi.fn(),
}));

const { HANDLERS } = await import('../src/agent/handlers.js');
const Tmdb = await import('../src/tmdb/client.js');
const Files = await import('../src/mongo/files.js');
const { config } = await import('../src/config.js');

beforeEach(() => {
  fakeDb.reset();
  config.tmdb.readAccessToken = 'test-token';
  Tmdb.findActorPortraitUrl.mockReset();
  Files.attachImageToCharacter.mockReset();
  Files.attachImageToCharacter.mockResolvedValue({
    _id: new ObjectId(),
    filename: 'fake.jpg',
    content_type: 'image/jpeg',
    size: 1234,
    is_main: true,
  });
});

async function seedExistingCharacter(overrides) {
  const _id = new ObjectId();
  await fakeDb.collection('characters').insertOne({
    _id,
    name: 'Bob',
    name_lower: 'bob',
    plays_self: false,
    hollywood_actor: null,
    own_voice: true,
    fields: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  });
  return _id;
}

describe('create_character auto-portrait', () => {
  it('fetches TMDB portrait when plays_self=false and hollywood_actor is set', async () => {
    Tmdb.findActorPortraitUrl.mockResolvedValue({
      ok: true,
      url: 'https://image.tmdb.org/t/p/w500/cm.jpg',
      tmdb_person_id: 42,
      person_name: 'Cillian Murphy',
    });
    const out = await HANDLERS.create_character({
      name: 'J. Robert Oppenheimer',
      plays_self: false,
      hollywood_actor: 'Cillian Murphy',
    });
    expect(Tmdb.findActorPortraitUrl).toHaveBeenCalledWith('Cillian Murphy');
    expect(Files.attachImageToCharacter).toHaveBeenCalledTimes(1);
    expect(Files.attachImageToCharacter.mock.calls[0][0]).toMatchObject({
      sourceUrl: 'https://image.tmdb.org/t/p/w500/cm.jpg',
      caption: 'TMDB profile photo for Cillian Murphy',
      setAsMain: true,
    });
    expect(out).toMatch(/Auto-attached TMDB portrait for "Cillian Murphy"/);
  });

  it('does not fetch when plays_self is true', async () => {
    const out = await HANDLERS.create_character({ name: 'Self Played', plays_self: true });
    expect(Tmdb.findActorPortraitUrl).not.toHaveBeenCalled();
    expect(Files.attachImageToCharacter).not.toHaveBeenCalled();
    expect(out).not.toMatch(/Auto-attached/);
    expect(out).not.toMatch(/Note:/);
  });

  it('surfaces a note when TMDB returns no_match without failing the mutation', async () => {
    Tmdb.findActorPortraitUrl.mockResolvedValue({ ok: false, reason: 'no_match' });
    const out = await HANDLERS.create_character({
      name: 'Bob',
      plays_self: false,
      hollywood_actor: 'Nobody Real',
    });
    expect(out).toMatch(/Created character Bob/);
    expect(out).toMatch(/Note: TMDB portrait lookup for "Nobody Real" failed: no_match/);
    expect(Files.attachImageToCharacter).not.toHaveBeenCalled();
  });

  it('surfaces tmdb_not_configured note when token is missing', async () => {
    Tmdb.findActorPortraitUrl.mockResolvedValue({ ok: false, reason: 'tmdb_not_configured' });
    const out = await HANDLERS.create_character({
      name: 'Charlie',
      plays_self: false,
      hollywood_actor: 'Some Actor',
    });
    expect(out).toMatch(/Note: TMDB portrait lookup for "Some Actor" failed: tmdb_not_configured/);
    expect(Files.attachImageToCharacter).not.toHaveBeenCalled();
  });

  it('surfaces a note when attach throws but does not fail the mutation', async () => {
    Tmdb.findActorPortraitUrl.mockResolvedValue({
      ok: true,
      url: 'https://image.tmdb.org/t/p/w500/x.jpg',
      tmdb_person_id: 1,
      person_name: 'Test Person',
    });
    Files.attachImageToCharacter.mockRejectedValueOnce(new Error('image too large'));
    const out = await HANDLERS.create_character({
      name: 'Diane',
      plays_self: false,
      hollywood_actor: 'Test Person',
    });
    expect(out).toMatch(/Created character Diane/);
    expect(out).toMatch(/Note: TMDB portrait found but attach failed: image too large/);
  });
});

describe('update_character auto-portrait', () => {
  it('fetches portrait when update sets hollywood_actor and there is no main image', async () => {
    await seedExistingCharacter();
    Tmdb.findActorPortraitUrl.mockResolvedValue({
      ok: true,
      url: 'https://image.tmdb.org/t/p/w500/o.jpg',
      tmdb_person_id: 99,
      person_name: 'Bob Odenkirk',
    });
    const out = await HANDLERS.update_character({
      identifier: 'Bob',
      patch: { hollywood_actor: 'Bob Odenkirk' },
    });
    expect(Tmdb.findActorPortraitUrl).toHaveBeenCalledWith('Bob Odenkirk');
    expect(Files.attachImageToCharacter).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/Auto-attached TMDB portrait for "Bob Odenkirk"/);
  });

  it('skips fetch when character already has a main_image_id', async () => {
    await seedExistingCharacter({
      name: 'Alice',
      name_lower: 'alice',
      hollywood_actor: 'Old Actor',
      main_image_id: new ObjectId(),
    });
    const out = await HANDLERS.update_character({
      identifier: 'Alice',
      patch: { hollywood_actor: 'New Actor' },
    });
    expect(Tmdb.findActorPortraitUrl).not.toHaveBeenCalled();
    expect(Files.attachImageToCharacter).not.toHaveBeenCalled();
    expect(out).toMatch(/Updated Alice/);
    expect(out).not.toMatch(/Auto-attached/);
  });

  it('skips fetch when plays_self stays true', async () => {
    await seedExistingCharacter({
      name: 'Real Person',
      name_lower: 'real person',
      plays_self: true,
    });
    await HANDLERS.update_character({
      identifier: 'Real Person',
      patch: { fields: { background_story: 'born in 1970' } },
    });
    expect(Tmdb.findActorPortraitUrl).not.toHaveBeenCalled();
    expect(Files.attachImageToCharacter).not.toHaveBeenCalled();
  });
});
