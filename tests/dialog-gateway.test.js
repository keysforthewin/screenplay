// Verifies the dialog gateway flows in fallback mode (no Hocuspocus).

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

const { createProject } = await import('../src/mongo/projects.js');
const Gateway = await import('../src/web/gateway.js');
const Dialogs = await import('../src/mongo/dialogs.js');
const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');

describe('dialog gateway (fallback)', () => {
  let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

  async function makeBeat() {
    return Plots.createBeat({ projectId, name: 'Diner', desc: 'A diner scene.' });
  }

  it('createDialogViaGateway creates a row and returns it', async () => {
    const beat = await makeBeat();
    const d = await Gateway.createDialogViaGateway({ projectId, beatId: beat._id });
    expect(d._id).toBeInstanceOf(ObjectId);
    expect(d.beat_id.toString()).toBe(beat._id.toString());
    expect(d.order).toBe(1);
  });

  it('createDialogViaGateway accepts initial body and character', async () => {
    const beat = await makeBeat();
    const d = await Gateway.createDialogViaGateway({ projectId,
      beatId: beat._id,
      body: 'Lights out.',
      character: 'Alice',
    });
    expect(d.body).toBe('Lights out.');
    expect(d.character).toBe('Alice');
  });

  it('setDialogTextFieldViaGateway writes body via fallback', async () => {
    const beat = await makeBeat();
    const d = await Gateway.createDialogViaGateway({ projectId, beatId: beat._id });
    await Gateway.setDialogTextFieldViaGateway({ projectId,
      dialogId: d._id,
      field: 'body',
      text: 'Get out of my house.',
    });
    const fresh = await Dialogs.getDialog(projectId, d._id);
    expect(fresh.body).toBe('Get out of my house.');
  });

  it('setDialogTextFieldViaGateway writes character via fallback', async () => {
    const beat = await makeBeat();
    const d = await Gateway.createDialogViaGateway({ projectId, beatId: beat._id });
    await Gateway.setDialogTextFieldViaGateway({ projectId,
      dialogId: d._id,
      field: 'character',
      text: 'Detective Bob',
    });
    const fresh = await Dialogs.getDialog(projectId, d._id);
    expect(fresh.character).toBe('Detective Bob');
  });

  it('setDialogTextFieldViaGateway rejects unknown fields', async () => {
    const beat = await makeBeat();
    const d = await Gateway.createDialogViaGateway({ projectId, beatId: beat._id });
    await expect(
      Gateway.setDialogTextFieldViaGateway({ projectId,
        dialogId: d._id,
        field: 'something',
        text: 'x',
      }),
    ).rejects.toThrow(/unknown dialog field/);
  });

  it('reorderDialogsViaGateway recompacts orders to 1..N', async () => {
    const beat = await makeBeat();
    const a = await Gateway.createDialogViaGateway({ projectId, beatId: beat._id });
    const b = await Gateway.createDialogViaGateway({ projectId, beatId: beat._id });
    const c = await Gateway.createDialogViaGateway({ projectId, beatId: beat._id });
    const reordered = await Gateway.reorderDialogsViaGateway({ projectId,
      beatId: beat._id,
      orderedIds: [c._id.toString(), a._id.toString(), b._id.toString()],
    });
    expect(reordered.map((s) => s._id.toString())).toEqual([
      c._id.toString(),
      a._id.toString(),
      b._id.toString(),
    ]);
    expect(reordered.map((s) => s.order)).toEqual([1, 2, 3]);
  });

  it('setDialogCharacterViaGateway accepts an existing character (case-insensitive)', async () => {
    const beat = await makeBeat();
    await Characters.createCharacter({ projectId, name: 'Alice' });
    const d = await Gateway.createDialogViaGateway({ projectId, beatId: beat._id });
    const updated = await Gateway.setDialogCharacterViaGateway({ projectId,
      dialogId: d._id,
      characterName: 'alice',
    });
    expect(updated.character).toBe('Alice');
    const fresh = await Dialogs.getDialog(projectId, d._id);
    expect(fresh.character).toBe('Alice');
  });

  it('setDialogCharacterViaGateway stores the canonical plain name even when the character has markdown', async () => {
    const beat = await makeBeat();
    await Characters.createCharacter({ projectId, name: '**Bob**' });
    const d = await Gateway.createDialogViaGateway({ projectId, beatId: beat._id });
    await Gateway.setDialogCharacterViaGateway({ projectId,
      dialogId: d._id,
      characterName: 'bob',
    });
    const fresh = await Dialogs.getDialog(projectId, d._id);
    expect(fresh.character).toBe('Bob');
  });

  it('setDialogCharacterViaGateway accepts unknown names as free-text speakers, as typed', async () => {
    const beat = await makeBeat();
    await Characters.createCharacter({ projectId, name: 'Alice' });
    const d = await Gateway.createDialogViaGateway({ projectId, beatId: beat._id });
    const updated = await Gateway.setDialogCharacterViaGateway({ projectId,
      dialogId: d._id,
      characterName: 'radio',
    });
    expect(updated.character).toBe('radio');
    const fresh = await Dialogs.getDialog(projectId, d._id);
    expect(fresh.character).toBe('radio');
  });

  it('setDialogCharacterViaGateway preserves the casing of free-text speakers', async () => {
    const beat = await makeBeat();
    const d = await Gateway.createDialogViaGateway({ projectId, beatId: beat._id });
    await Gateway.setDialogCharacterViaGateway({ projectId,
      dialogId: d._id,
      characterName: 'TV ANCHOR',
    });
    const fresh = await Dialogs.getDialog(projectId, d._id);
    expect(fresh.character).toBe('TV ANCHOR');
  });

  it('setDialogCharacterViaGateway trims surrounding whitespace from free-text speakers', async () => {
    const beat = await makeBeat();
    const d = await Gateway.createDialogViaGateway({ projectId, beatId: beat._id });
    await Gateway.setDialogCharacterViaGateway({ projectId,
      dialogId: d._id,
      characterName: '   intercom   ',
    });
    const fresh = await Dialogs.getDialog(projectId, d._id);
    expect(fresh.character).toBe('intercom');
  });

  it('setDialogCharacterViaGateway rejects empty/missing character', async () => {
    const beat = await makeBeat();
    const d = await Gateway.createDialogViaGateway({ projectId, beatId: beat._id });
    await expect(
      Gateway.setDialogCharacterViaGateway({ projectId,
        dialogId: d._id,
        characterName: '   ',
      }),
    ).rejects.toThrow(/character is required/);
  });

  it('deleteDialogViaGateway removes the row and recompacts the rest', async () => {
    const beat = await makeBeat();
    const a = await Gateway.createDialogViaGateway({ projectId, beatId: beat._id });
    const b = await Gateway.createDialogViaGateway({ projectId, beatId: beat._id });
    const c = await Gateway.createDialogViaGateway({ projectId, beatId: beat._id });
    await Gateway.deleteDialogViaGateway({ projectId, dialogId: b._id });
    const list = await Dialogs.listDialogs({ beatId: beat._id });
    expect(list.map((s) => s._id.toString())).toEqual([
      a._id.toString(),
      c._id.toString(),
    ]);
    expect(list.map((s) => s.order)).toEqual([1, 2]);
  });
});
