// Integration test for the dialog auto-generation pipeline.

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
const Dialogs = await import('../src/mongo/dialogs.js');
const Characters = await import('../src/mongo/characters.js');
const Generate = await import('../src/web/dialogGenerate.js');
const BeatLocks = await import('../src/web/beatLocks.js');
const { _setAnthropicClientForTests, _resetAnthropicClientForTests } =
  await import('../src/anthropic/client.js');

beforeEach(() => {
  fakeDb.reset();
  BeatLocks._clearBeatLocksForTests();
  _resetAnthropicClientForTests();
});

const TWO_LINE_RESULT = {
  entries: [
    { character: 'Alice', body: 'Where is Bob?' },
    { character: 'Bob', body: "I'm right here." },
  ],
};

function fakeAnthropicClient(toolInput) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [
          {
            type: 'tool_use',
            name: 'populate_dialog',
            input: toolInput,
          },
        ],
      })),
    },
  };
}

async function waitForJob(jobId) {
  for (let i = 0; i < 200; i++) {
    const job = Generate.getDialogGenerationJob(jobId);
    if (job && (job.status === 'done' || job.status === 'error')) {
      return job;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job never completed');
}

describe('dialog auto-generation', () => {
  it('extracts spoken lines and persists them in story order', async () => {
    _setAnthropicClientForTests(fakeAnthropicClient(TWO_LINE_RESULT));

    const beat = await Plots.createBeat({
      name: 'Diner reunion',
      desc: 'Alice meets Bob at the diner.',
      body: 'Alice arrives. "Where is Bob?" she asks. Bob: "I\'m right here."',
      characters: ['Alice', 'Bob'],
    });

    const jobId = await Generate.startDialogGenerationJob({
      beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);

    expect(job.status).toBe('done');
    expect(job.extracted).toBe(2);
    expect(job.created).toBe(2);

    const stored = await Dialogs.listDialogs({ beatId: beat._id });
    expect(stored).toHaveLength(2);
    expect(stored.map((d) => d.character)).toEqual(['Alice', 'Bob']);
    expect(stored.map((d) => d.body)).toEqual(['Where is Bob?', "I'm right here."]);
    expect(stored.map((d) => d.order)).toEqual([1, 2]);
  });

  it('returns immediately with status=done when the model returns no entries', async () => {
    _setAnthropicClientForTests(fakeAnthropicClient({ entries: [] }));

    const beat = await Plots.createBeat({
      name: 'E', desc: 'e', body: '', characters: [],
    });
    const jobId = await Generate.startDialogGenerationJob({
      beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');
    expect(job.extracted).toBe(0);
    const stored = await Dialogs.listDialogs({ beatId: beat._id });
    expect(stored).toHaveLength(0);
  });

  it('replaces existing dialogs when extraction returns a non-empty list', async () => {
    _setAnthropicClientForTests(fakeAnthropicClient(TWO_LINE_RESULT));

    const beat = await Plots.createBeat({
      name: 'R', desc: 'r', body: 'r', characters: [],
    });
    await Dialogs.createDialog({ beatId: beat._id, body: 'old 1', character: 'X' });
    await Dialogs.createDialog({ beatId: beat._id, body: 'old 2', character: 'Y' });
    const before = await Dialogs.listDialogs({ beatId: beat._id });
    expect(before).toHaveLength(2);
    const oldIds = new Set(before.map((s) => s._id.toString()));

    const jobId = await Generate.startDialogGenerationJob({
      beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');

    const after = await Dialogs.listDialogs({ beatId: beat._id });
    expect(after).toHaveLength(2);
    expect(after.map((s) => s.order)).toEqual([1, 2]);
    for (const d of after) {
      expect(oldIds.has(d._id.toString())).toBe(false);
    }
  });

  it('preserves existing dialogs when extraction returns no entries', async () => {
    _setAnthropicClientForTests(fakeAnthropicClient({ entries: [] }));

    const beat = await Plots.createBeat({
      name: 'P', desc: 'p', body: 'p', characters: [],
    });
    await Dialogs.createDialog({ beatId: beat._id, body: 'keep 1', character: 'A' });
    await Dialogs.createDialog({ beatId: beat._id, body: 'keep 2', character: 'B' });
    const before = await Dialogs.listDialogs({ beatId: beat._id });
    const beforeIds = before.map((s) => s._id.toString()).sort();

    const jobId = await Generate.startDialogGenerationJob({
      beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');
    expect(job.extracted).toBe(0);

    const after = await Dialogs.listDialogs({ beatId: beat._id });
    expect(after).toHaveLength(2);
    expect(after.map((s) => s._id.toString()).sort()).toEqual(beforeIds);
    expect(after.map((s) => s.body)).toEqual(['keep 1', 'keep 2']);
  });

  it('includes character bio fields in the prompt sent to Claude', async () => {
    const client = fakeAnthropicClient(TWO_LINE_RESULT);
    _setAnthropicClientForTests(client);

    await Characters.createCharacter({
      name: 'Alice',
      fields: {
        background_story: 'Former diner waitress turned private investigator.',
        memes: 'Always orders black coffee. Says "well well well" before bad news.',
        arc: 'Learns to trust her partner.',
      },
    });
    await Characters.createCharacter({
      name: 'Bob',
      hollywood_actor: 'Sam Smith',
      fields: { background_story: 'Recently widowed mechanic.' },
    });

    const beat = await Plots.createBeat({
      name: 'Diner meeting',
      desc: 'Alice confronts Bob about the missing car.',
      body: 'They meet at the diner.',
      characters: ['Alice', 'Bob'],
    });

    const jobId = await Generate.startDialogGenerationJob({
      beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');

    expect(client.messages.create).toHaveBeenCalledTimes(1);
    const callArg = client.messages.create.mock.calls[0][0];
    const userText = callArg.messages[0].content[0].text;
    expect(userText).toContain('## Alice');
    expect(userText).toContain('background_story: Former diner waitress');
    expect(userText).toContain('memes: Always orders black coffee');
    expect(userText).toContain('arc: Learns to trust');
    expect(userText).toContain('## Bob');
    expect(userText).toContain('hollywood_actor: Sam Smith');
    expect(userText).toContain('background_story: Recently widowed mechanic');
    // System prompt is the new dialogue-writing prompt, not the old extraction prompt.
    expect(callArg.system).toMatch(/screenwriter/i);
    expect(callArg.system).not.toMatch(/extract every line/i);
  });

  it('declares a required plan field in the populate_dialog tool schema', async () => {
    const client = fakeAnthropicClient(TWO_LINE_RESULT);
    _setAnthropicClientForTests(client);
    const beat = await Plots.createBeat({ name: 'P', desc: 'p', body: 'p', characters: [] });
    const jobId = await Generate.startDialogGenerationJob({ beatId: beat._id.toString() });
    await waitForJob(jobId);

    const callArg = client.messages.create.mock.calls[0][0];
    const tool = (callArg.tools || []).find((t) => t.name === 'populate_dialog');
    expect(tool).toBeTruthy();
    expect(tool.input_schema.properties.plan).toBeTruthy();
    expect(tool.input_schema.required).toContain('plan');
  });

  it('includes story context (logline + previous beat dialogue) in the prompt', async () => {
    const client = fakeAnthropicClient(TWO_LINE_RESULT);
    _setAnthropicClientForTests(client);
    await Plots.updatePlot(undefined, { title: 'Nightfall', synopsis: 'A courier crosses a dead country.' });
    const b1 = await Plots.createBeat({ name: 'The diner', desc: 'd1', body: 'b1' });
    await Dialogs.createDialog({ beatId: b1._id, body: 'No. Drive.', character: 'Bob' });
    const b2 = await Plots.createBeat({ name: 'The road', desc: 'd2', body: 'b2' });

    const jobId = await Generate.startDialogGenerationJob({ beatId: b2._id.toString() });
    await waitForJob(jobId);

    const userText = client.messages.create.mock.calls[0][0].messages[0].content[0].text;
    expect(userText).toContain('A courier crosses a dead country.');
    expect(userText).toContain('The diner');
    expect(userText).toContain('No. Drive.');
  });

  it('drops entries with empty body or missing character', async () => {
    _setAnthropicClientForTests(
      fakeAnthropicClient({
        entries: [
          { character: 'Alice', body: 'first' },
          { character: '', body: 'no speaker' },
          { character: 'Bob', body: '' },
          { character: 'Carol', body: 'last' },
        ],
      }),
    );
    const beat = await Plots.createBeat({
      name: 'D', desc: 'd', body: 'b', characters: [],
    });
    const jobId = await Generate.startDialogGenerationJob({
      beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');
    expect(job.extracted).toBe(2);
    const stored = await Dialogs.listDialogs({ beatId: beat._id });
    expect(stored.map((d) => d.body)).toEqual(['first', 'last']);
    expect(stored.map((d) => d.character)).toEqual(['Alice', 'Carol']);
  });
});
