// Test for the dialogue critic: scores each line (advisory), mapping the
// model's line numbers back to dialog ids.

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
const { critiqueDialog } = await import('../src/web/dialogCritique.js');
const { _setAnthropicClientForTests, _resetAnthropicClientForTests } =
  await import('../src/anthropic/client.js');

beforeEach(() => {
  fakeDb.reset();
  _resetAnthropicClientForTests();
});

function fakeClient(toolInput) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'tool_use', name: 'score_dialog', input: toolInput }],
      })),
    },
  };
}

describe('critiqueDialog', () => {
  it('maps line numbers back to dialog ids with score and issue', async () => {
    _setAnthropicClientForTests(
      fakeClient({
        scores: [
          { line_number: 1, score: 5, issue: '' },
          { line_number: 2, score: 2, issue: 'on-the-nose' },
        ],
      }),
    );
    const beat = await Plots.createBeat({ name: 'B', desc: 'd', body: 'b' });
    const d1 = await Dialogs.createDialog({ beatId: beat._id, body: 'Hi.', character: 'A' });
    const d2 = await Dialogs.createDialog({ beatId: beat._id, body: 'I am very sad right now.', character: 'B' });

    const result = await critiqueDialog({ beatId: beat._id.toString() });
    expect(result.scores).toEqual([
      { dialog_id: d1._id.toString(), score: 5, issue: '' },
      { dialog_id: d2._id.toString(), score: 2, issue: 'on-the-nose' },
    ]);
  });

  it('returns an empty list with no model call when the beat has no lines', async () => {
    const client = fakeClient({ scores: [] });
    _setAnthropicClientForTests(client);
    const beat = await Plots.createBeat({ name: 'B', desc: 'd', body: 'b' });

    const result = await critiqueDialog({ beatId: beat._id.toString() });
    expect(result.scores).toEqual([]);
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it('sends the numbered line list to the model', async () => {
    const client = fakeClient({ scores: [{ line_number: 1, score: 4, issue: '' }] });
    _setAnthropicClientForTests(client);
    const beat = await Plots.createBeat({ name: 'B', desc: 'd', body: 'b' });
    await Dialogs.createDialog({ beatId: beat._id, body: 'Where were you?', character: 'A' });

    await critiqueDialog({ beatId: beat._id.toString() });
    const userText = client.messages.create.mock.calls[0][0].messages[0].content[0].text;
    expect(userText).toContain('1.');
    expect(userText).toContain('Where were you?');
  });
});
