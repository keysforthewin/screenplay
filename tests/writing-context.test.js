// Unit test for buildWritingContext — the agent's scoped steering-context
// assembler used by the load_writing_context tool.

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

const Projects = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const { buildWritingContext } = await import('../src/agent/writingContext.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await Projects.createProject('Test Project'))._id.toString();
});

async function setPlotStyle(text) {
  await fakeDb.collection('plots').updateOne({}, { $set: { dialogue_style: text } });
}

describe('buildWritingContext', () => {
  it('includes full bios only for the named characters (scoping)', async () => {
    await Characters.createCharacter({ projectId, name: 'Alice', fields: { bio: 'Former courier.' } });
    await Characters.createCharacter({ projectId, name: 'Bob', fields: { bio: 'Ex-cop.' } });
    await Characters.createCharacter({ projectId, name: 'Carol', fields: { bio: 'The fixer.' } });
    const beat = await Plots.createBeat({
      projectId, name: 'Standoff', desc: 'd', body: 'b',
      characters: ['Alice', 'Bob', 'Carol'],
    });

    const ctx = await buildWritingContext(projectId, beat, ['Alice']);
    expect(ctx).toContain('## Alice');
    expect(ctx).toContain('bio: Former courier.');
    expect(ctx).not.toContain('## Bob');
    expect(ctx).not.toContain('## Carol');
  });

  it('includes beat name, desc, dialog_notes and body', async () => {
    const beat = await Plots.createBeat({
      projectId, name: 'The Diner', desc: 'They argue over coffee.', body: 'Alice slams the mug down.',
    });
    beat.dialog_notes = 'Keep it clipped.';

    const ctx = await buildWritingContext(projectId, beat, []);
    expect(ctx).toContain('The Diner');
    expect(ctx).toContain('They argue over coffee.');
    expect(ctx).toContain('Keep it clipped.');
    expect(ctx).toContain('Alice slams the mug down.');
  });

  it('includes the logline and dialogue style', async () => {
    await Plots.updatePlot(projectId, { title: 'The Long Drive', synopsis: 'A courier crosses a dead country.' });
    await setPlotStyle('1970s neo-noir. Think Chinatown.');
    const beat = await Plots.createBeat({ projectId, name: 'Road', desc: 'd', body: 'b' });

    const ctx = await buildWritingContext(projectId, beat, []);
    expect(ctx).toContain('The Long Drive');
    expect(ctx).toContain('A courier crosses a dead country.');
    expect(ctx).toContain('1970s neo-noir');
    expect(ctx).toContain('Chinatown');
  });

  it('reports character names that are not on file', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'X', desc: 'd', body: 'b' });
    const ctx = await buildWritingContext(projectId, beat, ['Zed']);
    expect(ctx).toMatch(/No character on file named "Zed"/);
  });

  it('truncates a large body to a preview with a pointer to the read tools', async () => {
    const huge = 'A'.repeat(9000) + 'TAILMARKER';
    const beat = await Plots.createBeat({ projectId, name: 'Big', desc: 'd', body: huge });

    const ctx = await buildWritingContext(projectId, beat, []);
    expect(ctx).not.toContain('TAILMARKER');
    expect(ctx).toMatch(/read_beat_body/);
  });

  it('includes the screenplay-format writing guide', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Road', desc: 'd', body: 'b' });
    const ctx = await buildWritingContext(projectId, beat, []);
    expect(ctx).toContain('# Writing in screenplay format');
    expect(ctx.toLowerCase()).toContain('photographable');
  });
});
