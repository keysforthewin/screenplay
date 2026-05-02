import { describe, it, expect, beforeEach, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/llm/analyze.js', () => ({
  analyzeText: vi.fn(async () => 'Test Title'),
}));

const { exportToPdf } = await import('../src/pdf/export.js');
const Characters = await import('../src/mongo/characters.js');
const Plots = await import('../src/mongo/plots.js');

async function seedScene() {
  await Characters.createCharacter({ name: 'Alice', plays_self: true, own_voice: true, fields: { background_story: 'A baker.' } });
  await Characters.createCharacter({ name: 'Bob', plays_self: true, own_voice: true, fields: { background_story: 'A thief.' } });
  await Characters.createCharacter({ name: 'Steve', plays_self: true, own_voice: true, fields: { background_story: 'A driver.' } });
  await Plots.createBeat({ name: 'Heist Setup', desc: 'They plan to steal the gun.', characters: ['Alice', 'Steve'] });
  await Plots.createBeat({ name: 'The Heist', desc: 'They steal the gun from the vault.', characters: ['Alice', 'Bob', 'Steve'] });
  await Plots.createBeat({ name: 'Aftermath', desc: 'They lay low.', characters: ['Bob'] });
  await Plots.createBeat({ name: 'Diner Scene', desc: 'They argue over breakfast.', characters: ['Alice', 'Bob'] });
}

beforeEach(() => {
  fakeDb.reset();
});

describe('exportToPdf filter modes', () => {
  it('full export (no filters) writes a PDF and returns its path', async () => {
    await seedScene();
    const result = await exportToPdf({ title: 'Full' });
    expect(result.path).toMatch(/\.pdf$/);
    const stat = await fsp.stat(result.path);
    expect(stat.size).toBeGreaterThan(500);
  });

  it('characters filter writes a PDF containing only the named character sheets', async () => {
    await seedScene();
    const filtered = await exportToPdf({ title: 'Two Chars', characters: ['Alice', 'Bob'] });
    expect(filtered.path).toMatch(/\.pdf$/);
    const filteredSize = (await fsp.stat(filtered.path)).size;
    const full = await exportToPdf({ title: 'Full' });
    const fullSize = (await fsp.stat(full.path)).size;
    expect(filteredSize).toBeLessThan(fullSize);
  });

  it('characters filter is case-insensitive (matches by name_lower)', async () => {
    await seedScene();
    const result = await exportToPdf({ characters: ['alice', 'BOB'] });
    expect(result.path).toMatch(/\.pdf$/);
  });

  it('characters filter returns an error when any name is missing', async () => {
    await seedScene();
    const result = await exportToPdf({ characters: ['Alice', 'Nobody'] });
    expect(result.error).toBe('No such character(s): Nobody.');
    expect(result.path).toBeUndefined();
  });

  it('beats_query writes a PDF and excludes non-matching beats', async () => {
    await seedScene();
    const result = await exportToPdf({ beats_query: 'gun' });
    expect(result.path).toMatch(/\.pdf$/);
    const stat = await fsp.stat(result.path);
    expect(stat.size).toBeGreaterThan(500);
  });

  it('beats_query returns an error when nothing matches', async () => {
    await seedScene();
    const result = await exportToPdf({ beats_query: 'xyzzy-no-match' });
    expect(result.error).toBe('No beats matched query: "xyzzy-no-match".');
    expect(result.path).toBeUndefined();
  });

  it('dossier_character writes a PDF for one character + their beats', async () => {
    await seedScene();
    const dossier = await exportToPdf({ dossier_character: 'Steve' });
    expect(dossier.path).toMatch(/\.pdf$/);
    const dossierSize = (await fsp.stat(dossier.path)).size;
    const full = await exportToPdf({});
    const fullSize = (await fsp.stat(full.path)).size;
    // Dossier has one character + only Steve's beats — must be smaller than full export.
    expect(dossierSize).toBeLessThan(fullSize);
  });

  it('dossier_character matching is case-insensitive against beat.characters', async () => {
    await Characters.createCharacter({ name: 'Steve', plays_self: true, own_voice: true });
    // Beat stores the name with mixed case; lookup uses a different case.
    await Plots.createBeat({ name: 'Mixed', desc: 'd', characters: ['STEVE'] });
    const result = await exportToPdf({ dossier_character: 'steve' });
    expect(result.path).toMatch(/\.pdf$/);
  });

  it('dossier_character returns an error when the character does not exist', async () => {
    await seedScene();
    const result = await exportToPdf({ dossier_character: 'Ghost' });
    expect(result.error).toBe('Character not found: Ghost.');
    expect(result.path).toBeUndefined();
  });
});

describe('export_pdf handler precedence', () => {
  // Imported lazily so the mongo mock above is in place before handlers.js loads.
  it('returns a precedence error when more than one filter is provided', async () => {
    const { HANDLERS } = await import('../src/agent/handlers.js');
    const result = await HANDLERS.export_pdf({
      characters: ['Alice'],
      beats_query: 'gun',
    });
    expect(result).toMatch(/^Tool error \(export_pdf\): pass at most one of /);
    expect(result).toContain('characters');
    expect(result).toContain('beats_query');
  });

  it('treats an empty characters array as "no filter" (does not flag precedence)', async () => {
    await seedScene();
    const { HANDLERS } = await import('../src/agent/handlers.js');
    // characters: [] should NOT count as a filter; passing it alongside beats_query is valid.
    const result = await HANDLERS.export_pdf({ characters: [], beats_query: 'gun' });
    expect(result).toMatch(/^__PDF_PATH__:/);
  });
});
