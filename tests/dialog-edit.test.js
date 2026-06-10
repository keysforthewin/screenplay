// Tests for the LLM-driven batch edit endpoint (src/web/dialogEdit.js).

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
const Plots = await import('../src/mongo/plots.js');
const Dialogs = await import('../src/mongo/dialogs.js');
const Edit = await import('../src/web/dialogEdit.js');
const { _setAnthropicClientForTests, _resetAnthropicClientForTests } =
  await import('../src/anthropic/client.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  _resetAnthropicClientForTests();
});

function fakeAnthropicEmitting(ops) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: ops.map((op) => ({
          type: 'tool_use',
          name: op.name,
          input: op.input,
        })),
      })),
    },
  };
}

async function seedBeat(entries) {
  const beat = await Plots.createBeat({ projectId,
    name: 'B', desc: 'd', body: 'b', characters: [],
  });
  for (const e of entries) {
    await Dialogs.createDialog({ projectId,
      beatId: beat._id,
      body: e.body,
      character: e.character,
    });
  }
  return beat;
}

describe('dialog LLM edit', () => {
  it('returns ok with no changes when the model emits no tool calls', async () => {
    _setAnthropicClientForTests(({
      messages: {
        create: vi.fn(async () => ({
          content: [{ type: 'text', text: 'looks great' }],
        })),
      },
    }));
    const beat = await seedBeat([
      { body: 'a', character: 'X' },
      { body: 'b', character: 'Y' },
    ]);
    const result = await Edit.editDialog({ projectId,
      beatId: beat._id,
      instructions: 'do nothing',
    });
    expect(result.ok).toBe(true);
    expect(result.ops_applied).toEqual({ add: 0, update: 0, move: 0, delete: 0 });
    expect(result.message).toMatch(/no changes/i);
    const after = await Dialogs.listDialogs({ beatId: beat._id });
    expect(after.map((s) => s.body)).toEqual(['a', 'b']);
  });

  it('applies update against the original list, not the running list', async () => {
    // delete(2) + update(3, body="X")
    // Item originally at #3 should receive the update.
    _setAnthropicClientForTests(
      fakeAnthropicEmitting([
        { name: 'delete', input: { item_number: 2 } },
        { name: 'update', input: { item_number: 3, body: 'X' } },
      ]),
    );
    const beat = await seedBeat([
      { body: 'a', character: 'A' },
      { body: 'b', character: 'B' },
      { body: 'c', character: 'C' },
      { body: 'd', character: 'D' },
    ]);
    const result = await Edit.editDialog({ projectId,
      beatId: beat._id,
      instructions: 'delete 2, change 3',
    });
    expect(result.ok).toBe(true);
    expect(result.ops_applied).toEqual({ add: 0, update: 1, move: 0, delete: 1 });
    const after = await Dialogs.listDialogs({ beatId: beat._id });
    expect(after.map((s) => s.body)).toEqual(['a', 'X', 'd']);
    expect(after.map((s) => s.character)).toEqual(['A', 'C', 'D']);
    expect(after.map((s) => s.order)).toEqual([1, 2, 3]);
  });

  it('updates body and character in a single op', async () => {
    _setAnthropicClientForTests(
      fakeAnthropicEmitting([
        { name: 'update', input: { item_number: 1, body: 'new body', character: 'New' } },
      ]),
    );
    const beat = await seedBeat([{ body: 'old', character: 'Old' }]);
    const result = await Edit.editDialog({ projectId,
      beatId: beat._id,
      instructions: 'update item 1',
    });
    expect(result.ops_applied.update).toBe(1);
    const after = await Dialogs.listDialogs({ beatId: beat._id });
    expect(after[0].body).toBe('new body');
    expect(after[0].character).toBe('New');
  });

  it('rejects update with neither body nor character', async () => {
    _setAnthropicClientForTests(
      fakeAnthropicEmitting([
        { name: 'update', input: { item_number: 1 } },
      ]),
    );
    const beat = await seedBeat([{ body: 'a', character: 'A' }]);
    await expect(
      Edit.editDialog({ projectId, beatId: beat._id, instructions: 'noop update' }),
    ).rejects.toMatchObject({ code: 'INVALID_OPS' });
  });

  it('applies a mixed batch (add + update + move + delete) producing contiguous order', async () => {
    _setAnthropicClientForTests(
      fakeAnthropicEmitting([
        { name: 'add', input: { after_item_number: 2, body: 'NEW', character: 'Z' } },
        { name: 'update', input: { item_number: 3, body: 'C2' } },
        { name: 'move', input: { item_number: 1, after_item_number: 3 } },
        { name: 'delete', input: { item_number: 5 } },
      ]),
    );
    const beat = await seedBeat([
      { body: 'a', character: 'A' },
      { body: 'b', character: 'B' },
      { body: 'c', character: 'C' },
      { body: 'd', character: 'D' },
      { body: 'e', character: 'E' },
    ]);
    const result = await Edit.editDialog({ projectId,
      beatId: beat._id,
      instructions: 'mixed batch',
    });
    expect(result.ok).toBe(true);
    expect(result.ops_applied).toEqual({ add: 1, update: 1, move: 1, delete: 1 });
    const after = await Dialogs.listDialogs({ beatId: beat._id });
    expect(after.map((s) => s.body)).toEqual(['b', 'NEW', 'C2', 'a', 'd']);
    expect(after.map((s) => s.order)).toEqual([1, 2, 3, 4, 5]);
  });

  it('multiple add ops with the same anchor stack in tool-call order', async () => {
    _setAnthropicClientForTests(
      fakeAnthropicEmitting([
        { name: 'add', input: { after_item_number: 2, body: 'A', character: 'X' } },
        { name: 'add', input: { after_item_number: 2, body: 'B', character: 'Y' } },
      ]),
    );
    const beat = await seedBeat([
      { body: 'x', character: 'X' },
      { body: 'y', character: 'Y' },
      { body: 'z', character: 'Z' },
    ]);
    await Edit.editDialog({ projectId, beatId: beat._id, instructions: 'add two' });
    const after = await Dialogs.listDialogs({ beatId: beat._id });
    expect(after.map((s) => s.body)).toEqual(['x', 'y', 'A', 'B', 'z']);
  });

  it('move(N, after=0) places at start; move(1, after=N) places at end', async () => {
    _setAnthropicClientForTests(
      fakeAnthropicEmitting([
        { name: 'move', input: { item_number: 3, after_item_number: 0 } },
      ]),
    );
    let beat = await seedBeat([
      { body: 'a', character: 'A' },
      { body: 'b', character: 'B' },
      { body: 'c', character: 'C' },
      { body: 'd', character: 'D' },
    ]);
    await Edit.editDialog({ projectId, beatId: beat._id, instructions: 'move 3 to start' });
    let after = await Dialogs.listDialogs({ beatId: beat._id });
    expect(after.map((s) => s.body)).toEqual(['c', 'a', 'b', 'd']);

    fakeDb.reset();
    _setAnthropicClientForTests(
      fakeAnthropicEmitting([
        { name: 'move', input: { item_number: 1, after_item_number: 4 } },
      ]),
    );
    beat = await seedBeat([
      { body: 'a', character: 'A' },
      { body: 'b', character: 'B' },
      { body: 'c', character: 'C' },
      { body: 'd', character: 'D' },
    ]);
    await Edit.editDialog({ projectId, beatId: beat._id, instructions: 'move 1 to end' });
    after = await Dialogs.listDialogs({ beatId: beat._id });
    expect(after.map((s) => s.body)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('rejects the whole batch when an op references an item that does not exist', async () => {
    _setAnthropicClientForTests(
      fakeAnthropicEmitting([
        { name: 'update', input: { item_number: 1, body: 'OK' } },
        { name: 'delete', input: { item_number: 99 } },
      ]),
    );
    const beat = await seedBeat([
      { body: 'a', character: 'A' },
      { body: 'b', character: 'B' },
      { body: 'c', character: 'C' },
    ]);
    await expect(
      Edit.editDialog({ projectId, beatId: beat._id, instructions: 'invalid' }),
    ).rejects.toMatchObject({ code: 'INVALID_OPS' });
    const after = await Dialogs.listDialogs({ beatId: beat._id });
    expect(after.map((s) => s.body)).toEqual(['a', 'b', 'c']);
  });

  it('rejects when an op also targets an item being deleted', async () => {
    _setAnthropicClientForTests(
      fakeAnthropicEmitting([
        { name: 'delete', input: { item_number: 2 } },
        { name: 'update', input: { item_number: 2, body: 'huh' } },
      ]),
    );
    const beat = await seedBeat([
      { body: 'a', character: 'A' },
      { body: 'b', character: 'B' },
      { body: 'c', character: 'C' },
    ]);
    let err;
    try {
      await Edit.editDialog({ projectId, beatId: beat._id, instructions: 'conflict' });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe('INVALID_OPS');
    expect(err.details.some((d) => /also being deleted/i.test(d.reason))).toBe(true);
    const after = await Dialogs.listDialogs({ beatId: beat._id });
    expect(after.map((s) => s.body)).toEqual(['a', 'b', 'c']);
  });

  it('rejects move(n, after_n) where after_n equals item_number', async () => {
    _setAnthropicClientForTests(
      fakeAnthropicEmitting([
        { name: 'move', input: { item_number: 2, after_item_number: 2 } },
      ]),
    );
    const beat = await seedBeat([
      { body: 'a', character: 'A' },
      { body: 'b', character: 'B' },
      { body: 'c', character: 'C' },
    ]);
    await expect(
      Edit.editDialog({ projectId, beatId: beat._id, instructions: 'self-move' }),
    ).rejects.toMatchObject({ code: 'INVALID_OPS' });
  });

  it('handles only-add (empty initial list)', async () => {
    _setAnthropicClientForTests(
      fakeAnthropicEmitting([
        { name: 'add', input: { after_item_number: 0, body: 'first', character: 'Alice' } },
      ]),
    );
    const beat = await seedBeat([]);
    const result = await Edit.editDialog({ projectId,
      beatId: beat._id,
      instructions: 'add first',
    });
    expect(result.ok).toBe(true);
    const after = await Dialogs.listDialogs({ beatId: beat._id });
    expect(after.map((s) => s.body)).toEqual(['first']);
    expect(after.map((s) => s.character)).toEqual(['Alice']);
    expect(after.map((s) => s.order)).toEqual([1]);
  });
});
