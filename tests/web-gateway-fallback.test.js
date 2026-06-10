// Verifies the gateway's fallback path: when Hocuspocus is not running (i.e.
// in tests / CLI scripts), text-mutation gateway calls reach Mongo via the
// underlying helpers, and non-text mutations still update Mongo + no-op the
// stateless broadcast. This is the same code path the agent loop's existing
// tests already exercise transitively, but covering it directly catches
// regressions.

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

vi.mock('../src/rag/queue.js', () => ({ enqueueReindex: () => {} }));
vi.mock('../src/rag/indexer.js', () => ({ deleteEntity: () => Promise.resolve() }));

const { createProject } = await import('../src/mongo/projects.js');
const Gateway = await import('../src/web/gateway.js');
const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const DirectorNotes = await import('../src/mongo/directorNotes.js');
const Projects = await import('../src/mongo/projects.js');
const Attachments = await import('../src/mongo/attachments.js');

describe('gateway fallback (no Hocuspocus)', () => {
  let projectId;

  beforeEach(async () => {
    fakeDb.reset();
    projectId = (await createProject('Test Project'))._id.toString();
  });

  it('setBeatBodyViaGateway writes the beat body via Mongo', async () => {
    const pid = (await Projects.getDefaultProject())._id.toString();
    const beat = await Plots.createBeat({ projectId: pid, name: 'Pilot', desc: 'Opening scene' });
    await Gateway.setBeatBodyViaGateway(pid, beat._id.toString(), 'Once upon a time...');
    const fresh = await Plots.getBeat(pid, beat._id.toString());
    expect(fresh.body).toBe('Once upon a time...');
  });

  it('appendBeatBodyViaGateway appends to the beat body', async () => {
    const pid = (await Projects.getDefaultProject())._id.toString();
    const beat = await Plots.createBeat({ projectId: pid, name: 'Pilot', desc: 'X', body: 'first' });
    await Gateway.appendBeatBodyViaGateway(pid, beat._id.toString(), 'second');
    const fresh = await Plots.getBeat(pid, beat._id.toString());
    expect(fresh.body).toBe('first\n\nsecond');
  });

  it('editBeatBodyViaGateway applies find/replace edits', async () => {
    const pid = (await Projects.getDefaultProject())._id.toString();
    const beat = await Plots.createBeat({ projectId: pid, name: 'Pilot', desc: 'X', body: 'foo bar baz' });
    const result = await Gateway.editBeatBodyViaGateway(pid, beat._id.toString(), [
      { find: 'bar', replace: 'BAZ' },
    ]);
    expect(result.applied).toHaveLength(1);
    const fresh = await Plots.getBeat(pid, beat._id.toString());
    expect(fresh.body).toBe('foo BAZ baz');
  });

  it('updateBeatViaGateway rejects non-object patches', async () => {
    const pid = (await Projects.getDefaultProject())._id.toString();
    await expect(
      Gateway.updateBeatViaGateway(pid, '1', 'not-an-object'),
    ).rejects.toThrow(/must be an object/);
  });

  it('updateCharacterViaGateway writes name + custom field', async () => {
    const pid = (await Projects.getDefaultProject())._id.toString();
    const c = await Characters.createCharacter({ projectId: pid, name: 'Steve' });
    await Gateway.updateCharacterViaGateway(pid, c._id.toString(), {
      name: 'Steven',
      'fields.background_story': 'Born in 1990.',
    });
    const fresh = await Characters.getCharacter(pid, c._id.toString());
    expect(fresh.name).toBe('Steven');
    expect(fresh.fields?.background_story).toBe('Born in 1990.');
  });

  it('updateCharacterViaGateway rejects unrecognized fields', async () => {
    const pid = (await Projects.getDefaultProject())._id.toString();
    const c = await Characters.createCharacter({ projectId: pid, name: 'Bob' });
    await expect(
      Gateway.updateCharacterViaGateway(pid, c._id.toString(), { totally_made_up: 'x' }),
    ).rejects.toThrow(/no recognized fields/);
  });

  it('addDirectorNoteViaGateway then editDirectorNoteViaGateway round-trips text', async () => {
    const pid = (await Projects.getDefaultProject())._id.toString();
    const note = await Gateway.addDirectorNoteViaGateway({ projectId: pid, text: 'first version' });
    await Gateway.editDirectorNoteViaGateway({ projectId: pid, noteId: note._id.toString(), text: 'second version' });
    const doc = await DirectorNotes.getDirectorNotes(pid);
    expect(doc.notes).toHaveLength(1);
    expect(doc.notes[0].text).toBe('second version');
  });

  it('removeDirectorNoteViaGateway deletes the note', async () => {
    const pid = (await Projects.getDefaultProject())._id.toString();
    const note = await Gateway.addDirectorNoteViaGateway({ projectId: pid, text: 'doomed' });
    await Gateway.removeDirectorNoteViaGateway({ projectId: pid, noteId: note._id.toString() });
    const doc = await DirectorNotes.getDirectorNotes(pid);
    expect(doc.notes).toHaveLength(0);
  });

  it('director-note gateway helpers stay scoped to the passed project', async () => {
    const a = await Projects.createProject('A');
    const b = await Projects.createProject('B');
    const aid = a._id.toString();
    const bid = b._id.toString();
    const note = await Gateway.addDirectorNoteViaGateway({ projectId: aid, text: 'scoped' });
    await Gateway.editDirectorNoteViaGateway({
      projectId: aid,
      noteId: note._id.toString(),
      text: 'scoped v2',
    });
    expect((await DirectorNotes.getDirectorNotes(aid)).notes[0].text).toBe('scoped v2');
    expect((await DirectorNotes.getDirectorNotes(bid)).notes || []).toHaveLength(0);
  });

  it('attachExistingAttachmentToBeatViaGateway requires an explicit projectId (strict mode)', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Rooftop', desc: 'Chase' });
    const fileDoc = {
      _id: new ObjectId(),
      filename: 'ambience.mp3',
      contentType: 'audio/mpeg',
      length: 1000,
      uploadDate: new Date(),
      metadata: { project_id: projectId, owner_type: null, owner_id: null, source: 'upload', content_type: 'audio/mpeg' },
    };
    fakeDb.collection('attachments.files')._docs.push(fileDoc);
    // Strict mode: an omitted projectId throws...
    await expect(
      Gateway.attachExistingAttachmentToBeatViaGateway({
        projectId: undefined,
        beatId: beat._id.toString(),
        attachmentId: fileDoc._id,
      }),
    ).rejects.toThrow(/projectId required/);
    // ...and an explicit one resolves and broadcasts without throwing.
    const res = await Gateway.attachExistingAttachmentToBeatViaGateway({
      projectId,
      beatId: beat._id.toString(),
      attachmentId: fileDoc._id,
    });
    expect(res.beat.name).toBe('Rooftop');
  });

});
