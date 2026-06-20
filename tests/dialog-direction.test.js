// Test for "Direction" note generation — the voice-actor performance note that
// explains what's happening in the scene at this moment and how to deliver the
// line. Per-line (one focused note) and whole-beat (one note per numbered line).

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
const { generateDirectionForLine, generateDirectionForBeat } = await import(
  '../src/web/dialogDirection.js'
);
const { _setAnthropicClientForTests, _resetAnthropicClientForTests } =
  await import('../src/anthropic/client.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  _resetAnthropicClientForTests();
});

function fakeClient(toolName, toolInput) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'tool_use', name: toolName, input: toolInput }],
      })),
    },
  };
}

async function seedBeat() {
  const beat = await Plots.createBeat({
    projectId,
    name: 'Standoff',
    desc: 'They face off in the rain.',
    body: 'b',
    characters: ['Alice', 'Bob'],
  });
  await Dialogs.createDialog({ projectId, beatId: beat._id, body: 'You sure about this?', character: 'Alice' });
  const mid = await Dialogs.createDialog({ projectId, beatId: beat._id, body: 'No. Drive.', character: 'Bob' });
  await Dialogs.createDialog({ projectId, beatId: beat._id, body: 'Then drive.', character: 'Alice' });
  return { beat, mid };
}

describe('generateDirectionForLine', () => {
  it('returns the direction note the model wrote, for the target line', async () => {
    _setAnthropicClientForTests(
      fakeClient('write_direction', {
        direction: 'Bob is scared but hiding it. Clipped and urgent, eyes on the mirror.',
      }),
    );
    const { mid } = await seedBeat();

    const result = await generateDirectionForLine({ projectId, dialogId: mid._id.toString() });
    expect(result.dialogId).toBe(mid._id.toString());
    expect(result.direction).toBe(
      'Bob is scared but hiding it. Clipped and urgent, eyes on the mirror.',
    );
  });

  it('sends the previous line, next line, and the speaker as context', async () => {
    const client = fakeClient('write_direction', { direction: 'x' });
    _setAnthropicClientForTests(client);
    const { mid } = await seedBeat();

    await generateDirectionForLine({ projectId, dialogId: mid._id.toString() });
    const userText = client.messages.create.mock.calls[0][0].messages[0].content[0].text;
    expect(userText).toContain('You sure about this?'); // the line before
    expect(userText).toContain('Then drive.'); // the line after
    expect(userText).toContain('No. Drive.'); // the line being performed
    expect(userText).toContain('Bob'); // the speaker
  });

  it('returns an empty string when the model writes nothing usable', async () => {
    _setAnthropicClientForTests(fakeClient('write_direction', { direction: '   ' }));
    const { mid } = await seedBeat();
    const result = await generateDirectionForLine({ projectId, dialogId: mid._id.toString() });
    expect(result.direction).toBe('');
  });
});

describe('generateDirectionForBeat', () => {
  it('maps line numbers back to dialog ids', async () => {
    _setAnthropicClientForTests(
      fakeClient('write_directions', {
        notes: [
          { line_number: 1, direction: 'Open warm — testing the water.' },
          { line_number: 2, direction: 'Cold turn. Shut it down.' },
          { line_number: 3, direction: 'Final, quiet. No anger left.' },
        ],
      }),
    );
    const { beat } = await seedBeat();

    const result = await generateDirectionForBeat({ projectId, beatId: beat._id.toString() });
    const all = await Dialogs.listDialogs({ beatId: beat._id });
    expect(result.notes).toEqual([
      { dialog_id: all[0]._id.toString(), direction: 'Open warm — testing the water.' },
      { dialog_id: all[1]._id.toString(), direction: 'Cold turn. Shut it down.' },
      { dialog_id: all[2]._id.toString(), direction: 'Final, quiet. No anger left.' },
    ]);
  });

  it('returns an empty list with no model call when the beat has no lines', async () => {
    const client = fakeClient('write_directions', { notes: [] });
    _setAnthropicClientForTests(client);
    const beat = await Plots.createBeat({ projectId, name: 'Empty', desc: 'd', body: 'b' });

    const result = await generateDirectionForBeat({ projectId, beatId: beat._id.toString() });
    expect(result.notes).toEqual([]);
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it('ignores out-of-range line numbers', async () => {
    _setAnthropicClientForTests(
      fakeClient('write_directions', {
        notes: [
          { line_number: 2, direction: 'Only this one is valid.' },
          { line_number: 99, direction: 'No such line.' },
        ],
      }),
    );
    const { beat } = await seedBeat();
    const result = await generateDirectionForBeat({ projectId, beatId: beat._id.toString() });
    const all = await Dialogs.listDialogs({ beatId: beat._id });
    expect(result.notes).toEqual([
      { dialog_id: all[1]._id.toString(), direction: 'Only this one is valid.' },
    ]);
  });
});
