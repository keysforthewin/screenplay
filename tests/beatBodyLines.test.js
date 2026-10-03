// Every write of a beat body keeps the page's line breaks: markdown joins a
// bare newline inside a paragraph into a space, so the gateway turns them
// into hard breaks — for the agent's tools as much as for the rewrite passes.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as Y from 'yjs';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({ getDb: () => fakeDb, connectMongo: async () => fakeDb }));
vi.mock('../src/log.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/web/announceHelpers.js', () => ({
  announceBeatMedia: vi.fn(), announceCharacterMedia: vi.fn(), announceNoteMedia: vi.fn(),
  announceStoryboardMedia: vi.fn(), announceLibraryMedia: vi.fn(), announceBatchSummary: vi.fn(),
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const GW = await import('../src/web/gateway.js');
const H = await import('../src/web/headlessEditor.js');
const { linesToHardBreaks, hardBreaksToLines, stripMarkdownLines } = await import('../src/util/markdown.js');

const PAGE = 'INT. LOBBY — NIGHT\n\nKEYS\n(flat)\nCompliance.\n\nHe turns.';
const STORED = 'INT. LOBBY — NIGHT\n\nKEYS\\\n(flat)\\\nCompliance.\n\nHe turns.';

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('P'))._id.toString();
});
const bodyOf = async (id) => (await Plots.getBeat(projectId, String(id))).body;

describe('line helpers', () => {
  it('round-trip a page and leave fragments untrimmed on request', () => {
    expect(linesToHardBreaks(PAGE)).toBe(STORED);
    expect(hardBreaksToLines(STORED)).toBe(PAGE);
    expect(linesToHardBreaks('\nKEYS\n(flat)\n', { trim: false })).toBe('\nKEYS\\\n(flat)\n');
    expect(stripMarkdownLines('**KEYS**\\\n(flat)\\\nCompliance.')).toBe('KEYS\n(flat)\nCompliance.');
  });

  it('the stored form survives the editor: the lines are still apart after a save', () => {
    const doc = new Y.Doc();
    H.setFragmentMarkdown(doc, 'body', STORED);
    expect(H.fragmentToMarkdown(doc, 'body')).toBe(STORED);
    const bare = new Y.Doc();
    H.setFragmentMarkdown(bare, 'body', PAGE);
    expect(H.fragmentToMarkdown(bare, 'body')).toContain('KEYS (flat) Compliance.'); // what used to be saved
  });
});

describe('beat body writes through the gateway', () => {
  it('create, set and append store hard breaks', async () => {
    const beat = await GW.createBeatViaGateway({ projectId, name: 'B', body: PAGE });
    expect(await bodyOf(beat._id)).toBe(STORED);
    await GW.setBeatBodyViaGateway(projectId, beat._id, 'MOM\nLet him.');
    expect(await bodyOf(beat._id)).toBe('MOM\\\nLet him.');
    await GW.appendBeatBodyViaGateway(projectId, beat._id, 'DAD\n(quiet)\nOkay.');
    expect(await bodyOf(beat._id)).toBe('MOM\\\nLet him.\n\nDAD\\\n(quiet)\\\nOkay.');
  });

  it('update_beat with a body keeps its lines', async () => {
    const beat = await GW.createBeatViaGateway({ projectId, name: 'B', body: 'x' });
    await GW.updateBeatViaGateway(projectId, String(beat._id), { body: PAGE });
    expect(await bodyOf(beat._id)).toBe(STORED);
  });

  it('an edit typed with plain newlines finds the stored passage and writes its lines', async () => {
    const beat = await GW.createBeatViaGateway({ projectId, name: 'B', body: PAGE });
    await GW.editBeatBodyViaGateway(projectId, beat._id, [{ find: 'KEYS\n(flat)\nCompliance.', replace: 'KEYS (O.S.)\nCompliance.' }]);
    expect(await bodyOf(beat._id)).toBe('INT. LOBBY — NIGHT\n\nKEYS (O.S.)\\\nCompliance.\n\nHe turns.');
  });

  it('the same edit applies inside a live y-doc', () => {
    const doc = new Y.Doc();
    H.setFragmentMarkdown(doc, 'body', STORED);
    const find = 'KEYS\n(flat)';
    H.editFragmentMarkdown(doc, 'body', [{ find, find_alt: linesToHardBreaks(find, { trim: false }), replace: 'KEYS' }]);
    expect(H.fragmentToMarkdown(doc, 'body')).toBe('INT. LOBBY — NIGHT\n\nKEYS\\\nCompliance.\n\nHe turns.');
  });

  it('other text fields are left as written', async () => {
    const beat = await GW.createBeatViaGateway({ projectId, name: 'B', body: 'x' });
    await GW.updateBeatViaGateway(projectId, String(beat._id), { name: 'Two\nlines' });
    expect((await Plots.getBeat(projectId, String(beat._id))).name).not.toContain('\\');
  });
});
