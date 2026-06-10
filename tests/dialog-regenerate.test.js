// Test for per-line dialogue regeneration: returns N alternative bodies for a
// single line, keeping the speaker fixed and the surrounding lines as context.

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
const { generateAlternatives } = await import('../src/web/dialogRegenerate.js');
const { _setAnthropicClientForTests, _resetAnthropicClientForTests } =
  await import('../src/anthropic/client.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  _resetAnthropicClientForTests();
});

function fakeClient(toolInput) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'tool_use', name: 'propose_alternatives', input: toolInput }],
      })),
    },
  };
}

async function seedBeat() {
  const beat = await Plots.createBeat({ projectId, name: 'Standoff', desc: 'd', body: 'b', characters: ['Alice', 'Bob'] });
  await Dialogs.createDialog({ projectId, beatId: beat._id, body: 'You sure about this?', character: 'Alice' });
  const mid = await Dialogs.createDialog({ projectId, beatId: beat._id, body: 'No. Drive.', character: 'Bob' });
  await Dialogs.createDialog({ projectId, beatId: beat._id, body: 'Then drive.', character: 'Alice' });
  return { beat, mid };
}

describe('generateAlternatives', () => {
  it('returns the alternative bodies the model proposed', async () => {
    _setAnthropicClientForTests(
      fakeClient({ alternatives: ['Just go.', 'Drive, Alice.', "We're not talking about it."] }),
    );
    const { mid } = await seedBeat();

    const result = await generateAlternatives({ projectId, dialogId: mid._id.toString() });
    expect(result.alternatives).toEqual(['Just go.', 'Drive, Alice.', "We're not talking about it."]);
  });

  it('sends the neighbouring lines and the target speaker as context', async () => {
    const client = fakeClient({ alternatives: ['a', 'b', 'c'] });
    _setAnthropicClientForTests(client);
    const { mid } = await seedBeat();

    await generateAlternatives({ projectId, dialogId: mid._id.toString() });
    const userText = client.messages.create.mock.calls[0][0].messages[0].content[0].text;
    expect(userText).toContain('You sure about this?'); // line before
    expect(userText).toContain('Then drive.'); // line after
    expect(userText).toContain('No. Drive.'); // the line being regenerated
    expect(userText).toContain('Bob'); // the fixed speaker
  });

  it('drops empty alternatives', async () => {
    _setAnthropicClientForTests(fakeClient({ alternatives: ['keep', '', '   ', 'also'] }));
    const { mid } = await seedBeat();
    const result = await generateAlternatives({ projectId, dialogId: mid._id.toString() });
    expect(result.alternatives).toEqual(['keep', 'also']);
  });
});
