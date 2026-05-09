// Tests for the LLM-driven batch edit endpoint (src/web/storyboardEdit.js).
//
// Mocks Anthropic to emit a chosen sequence of tool_use blocks, then asserts
// the apply algorithm produces the expected final storyboard list.

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

const Plots = await import('../src/mongo/plots.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Edit = await import('../src/web/storyboardEdit.js');
const { _setAnthropicClientForTests, _resetAnthropicClientForTests } =
  await import('../src/anthropic/client.js');

beforeEach(() => {
  fakeDb.reset();
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

async function seedBeat(prompts) {
  const beat = await Plots.createBeat({
    name: 'B',
    desc: 'd',
    body: 'b',
    characters: [],
  });
  for (const p of prompts) {
    await Storyboards.createStoryboard({ beatId: beat._id, textPrompt: p });
  }
  return beat;
}

describe('storyboard LLM edit', () => {
  it('returns ok with no changes when the model emits no tool calls', async () => {
    _setAnthropicClientForTests(({
      messages: { create: vi.fn(async () => ({ content: [{ type: 'text', text: 'looks great' }] })) },
    }));
    const beat = await seedBeat(['a', 'b', 'c']);
    const result = await Edit.editStoryboard({
      beatId: beat._id,
      instructions: 'do nothing',
    });
    expect(result.ok).toBe(true);
    expect(result.ops_applied).toEqual({ add: 0, update: 0, move: 0, delete: 0 });
    expect(result.message).toMatch(/no changes/i);
    const after = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(after.map((s) => s.text_prompt)).toEqual(['a', 'b', 'c']);
  });

  it('applies update_description against the original list, not the running list', async () => {
    // delete(2) + update_description(3, "X")
    // Item originally at #3 should receive the update — even though after the
    // delete it now lives at index 2.
    _setAnthropicClientForTests(
      fakeAnthropicEmitting([
        { name: 'delete', input: { item_number: 2 } },
        { name: 'update_description', input: { item_number: 3, text_prompt: 'X' } },
      ]),
    );
    const beat = await seedBeat(['a', 'b', 'c', 'd']);
    const result = await Edit.editStoryboard({
      beatId: beat._id,
      instructions: 'delete 2, change 3',
    });
    expect(result.ok).toBe(true);
    expect(result.ops_applied).toEqual({ add: 0, update: 1, move: 0, delete: 1 });
    const after = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(after.map((s) => s.text_prompt)).toEqual(['a', 'X', 'd']);
    expect(after.map((s) => s.order)).toEqual([1, 2, 3]);
  });

  it('applies a mixed batch (add + update + move + delete) producing contiguous order', async () => {
    // Original: [a, b, c, d, e]
    // Ops: add(after=2,"NEW"), update_description(3,"C2"),
    //      move(1, after=3), delete(5)
    // After update: [a, b, c→C2, d, e]
    // After delete: [a, b, c→C2 (kept text), d, e(del)]
    // After add (after=2): [a, b, NEW, c→C2, d, e(del)]
    // After move (1, after=3): place originally-#1 (a) after originally-#3 (c→C2)
    //   working list (filtering deletes for visualization): [b, NEW, c→C2, a, d]
    _setAnthropicClientForTests(
      fakeAnthropicEmitting([
        { name: 'add', input: { after_item_number: 2, text_prompt: 'NEW' } },
        { name: 'update_description', input: { item_number: 3, text_prompt: 'C2' } },
        { name: 'move', input: { item_number: 1, after_item_number: 3 } },
        { name: 'delete', input: { item_number: 5 } },
      ]),
    );
    const beat = await seedBeat(['a', 'b', 'c', 'd', 'e']);
    const result = await Edit.editStoryboard({
      beatId: beat._id,
      instructions: 'mixed batch',
    });
    expect(result.ok).toBe(true);
    expect(result.ops_applied).toEqual({ add: 1, update: 1, move: 1, delete: 1 });
    const after = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(after.map((s) => s.text_prompt)).toEqual(['b', 'NEW', 'C2', 'a', 'd']);
    expect(after.map((s) => s.order)).toEqual([1, 2, 3, 4, 5]);
  });

  it('multiple add ops with the same anchor stack in tool-call order', async () => {
    _setAnthropicClientForTests(
      fakeAnthropicEmitting([
        { name: 'add', input: { after_item_number: 2, text_prompt: 'A' } },
        { name: 'add', input: { after_item_number: 2, text_prompt: 'B' } },
      ]),
    );
    const beat = await seedBeat(['x', 'y', 'z']);
    await Edit.editStoryboard({ beatId: beat._id, instructions: 'add two' });
    const after = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(after.map((s) => s.text_prompt)).toEqual(['x', 'y', 'A', 'B', 'z']);
  });

  it('move(N, after=0) places at start; move(1, after=N) places at end', async () => {
    _setAnthropicClientForTests(
      fakeAnthropicEmitting([
        { name: 'move', input: { item_number: 3, after_item_number: 0 } },
      ]),
    );
    let beat = await seedBeat(['a', 'b', 'c', 'd']);
    await Edit.editStoryboard({ beatId: beat._id, instructions: 'move 3 to start' });
    let after = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(after.map((s) => s.text_prompt)).toEqual(['c', 'a', 'b', 'd']);

    fakeDb.reset();
    _setAnthropicClientForTests(
      fakeAnthropicEmitting([
        { name: 'move', input: { item_number: 1, after_item_number: 4 } },
      ]),
    );
    beat = await seedBeat(['a', 'b', 'c', 'd']);
    await Edit.editStoryboard({ beatId: beat._id, instructions: 'move 1 to end' });
    after = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(after.map((s) => s.text_prompt)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('rejects the whole batch when an op references an item that does not exist', async () => {
    _setAnthropicClientForTests(
      fakeAnthropicEmitting([
        { name: 'update_description', input: { item_number: 1, text_prompt: 'OK' } },
        { name: 'delete', input: { item_number: 99 } },
      ]),
    );
    const beat = await seedBeat(['a', 'b', 'c']);
    await expect(
      Edit.editStoryboard({ beatId: beat._id, instructions: 'invalid' }),
    ).rejects.toMatchObject({ code: 'INVALID_OPS' });
    // Original storyboards untouched — nothing was applied partially.
    const after = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(after.map((s) => s.text_prompt)).toEqual(['a', 'b', 'c']);
  });

  it('rejects when an op also targets an item being deleted', async () => {
    _setAnthropicClientForTests(
      fakeAnthropicEmitting([
        { name: 'delete', input: { item_number: 2 } },
        { name: 'update_description', input: { item_number: 2, text_prompt: 'huh' } },
      ]),
    );
    const beat = await seedBeat(['a', 'b', 'c']);
    let err;
    try {
      await Edit.editStoryboard({ beatId: beat._id, instructions: 'conflict' });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe('INVALID_OPS');
    expect(err.details.some((d) => /also being deleted/i.test(d.reason))).toBe(true);
    // Storyboards unchanged.
    const after = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(after.map((s) => s.text_prompt)).toEqual(['a', 'b', 'c']);
  });

  it('rejects move(n, after_n) where after_n equals item_number', async () => {
    _setAnthropicClientForTests(
      fakeAnthropicEmitting([
        { name: 'move', input: { item_number: 2, after_item_number: 2 } },
      ]),
    );
    const beat = await seedBeat(['a', 'b', 'c']);
    await expect(
      Edit.editStoryboard({ beatId: beat._id, instructions: 'self-move' }),
    ).rejects.toMatchObject({ code: 'INVALID_OPS' });
  });

  it('handles only-add (empty initial list)', async () => {
    _setAnthropicClientForTests(
      fakeAnthropicEmitting([
        { name: 'add', input: { after_item_number: 0, text_prompt: 'first' } },
      ]),
    );
    const beat = await seedBeat([]);
    const result = await Edit.editStoryboard({
      beatId: beat._id,
      instructions: 'add first',
    });
    expect(result.ok).toBe(true);
    const after = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(after.map((s) => s.text_prompt)).toEqual(['first']);
    expect(after.map((s) => s.order)).toEqual([1]);
  });
});
