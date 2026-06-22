// Unit tests for the deterministic character-linking backstop used during
// storyboard generation. Pure functions — no Mongo, but importing the module
// pulls in the mongo client, so stub it like the other generate tests.
import { describe, it, expect, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { findAppearingBeatCharacters, linkBeatCharactersForShot } = await import(
  '../src/web/storyboardGenerate.js'
);

describe('findAppearingBeatCharacters', () => {
  it('finds a beat character named in the text', () => {
    expect(findAppearingBeatCharacters('Alice opens the door.', ['Alice', 'Bob'])).toEqual(['Alice']);
  });

  it('excludes a beat character not mentioned', () => {
    expect(findAppearingBeatCharacters('Alice opens the door.', ['Bob'])).toEqual([]);
  });

  it('does not match on a substring (whole-word only)', () => {
    expect(findAppearingBeatCharacters('They are all the same.', ['Sam'])).toEqual([]);
  });

  it('matches multi-word names as a phrase', () => {
    expect(findAppearingBeatCharacters('The Narrator speaks.', ['The Narrator'])).toEqual(['The Narrator']);
  });

  it('is case-insensitive and markdown-insensitive', () => {
    expect(findAppearingBeatCharacters('the door creaks as ALICE enters', ['**Alice**'])).toEqual(['Alice']);
  });

  it('returns each match once even if named twice', () => {
    expect(findAppearingBeatCharacters('Bob waves. Bob smiles.', ['Bob'])).toEqual(['Bob']);
  });
});

describe('linkBeatCharactersForShot', () => {
  it('unions the planner picks with text-detected beat characters', () => {
    const frame = {
      characters_in_scene: ['Alice'],
      description: 'Two figures talk.',
      start_frame_prompt: 'Alice and Bob at the counter.',
      video_prompt: 'Bob leans in; Alice reacts.',
    };
    expect(linkBeatCharactersForShot(frame, ['Alice', 'Bob'])).toEqual(['Alice', 'Bob']);
  });

  it('keeps planner picks even when not in beat.characters', () => {
    const frame = { characters_in_scene: ['Ghost'], description: '', start_frame_prompt: '', video_prompt: '' };
    expect(linkBeatCharactersForShot(frame, ['Alice'])).toEqual(['Ghost']);
  });

  it('dedupes a planner pick that is also text-detected', () => {
    const frame = { characters_in_scene: ['Bob'], description: 'Bob enters.', start_frame_prompt: '', video_prompt: '' };
    expect(linkBeatCharactersForShot(frame, ['Bob'])).toEqual(['Bob']);
  });

  it('links a character named only in the video_prompt', () => {
    const frame = { characters_in_scene: [], description: '', start_frame_prompt: '', video_prompt: 'Bob leans in.' };
    expect(linkBeatCharactersForShot(frame, ['Alice', 'Bob'])).toEqual(['Bob']);
  });

  it('links a character named only in the summary (description)', () => {
    const frame = { characters_in_scene: [], description: 'Alice waits alone.', start_frame_prompt: '', video_prompt: '' };
    expect(linkBeatCharactersForShot(frame, ['Alice', 'Bob'])).toEqual(['Alice']);
  });

  it('does not scan transition_in', () => {
    const frame = { characters_in_scene: [], description: '', start_frame_prompt: '', video_prompt: '', transition_in: 'Cut from Bob.' };
    expect(linkBeatCharactersForShot(frame, ['Bob'])).toEqual([]);
  });
});
