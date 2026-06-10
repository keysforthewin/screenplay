// Verifies the gateway's fallback path for the singleton `plot` room: when
// Hocuspocus is not running, plot text mutations reach Mongo via updatePlot /
// editPlotField, so the agent can edit title/synopsis/dialogue_style and append
// film dialogue samples.

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
const Gateway = await import('../src/web/gateway.js');
const Plots = await import('../src/mongo/plots.js');

describe('gateway plot fallback (no Hocuspocus)', () => {
  let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

  it('setEntityFieldMarkdown writes plot.synopsis', async () => {
    await Gateway.setEntityFieldMarkdown({ projectId,
      entityType: 'plot',
      entityId: 'plot',
      field: 'synopsis',
      markdown: 'A new synopsis.',
    });
    const plot = await Plots.getPlot(projectId);
    expect(plot.synopsis).toBe('A new synopsis.');
  });

  it('setEntityFieldMarkdown writes plot.title', async () => {
    await Gateway.setEntityFieldMarkdown({ projectId,
      entityType: 'plot',
      entityId: 'plot',
      field: 'title',
      markdown: 'Neon City',
    });
    const plot = await Plots.getPlot(projectId);
    expect(plot.title).toBe('Neon City');
  });

  it('editEntityFieldMarkdown applies find/replace to plot.dialogue_style', async () => {
    await Plots.updatePlot(projectId, { dialogue_style: 'foo bar baz' });
    const result = await Gateway.editEntityFieldMarkdown({ projectId,
      entityType: 'plot',
      entityId: 'plot',
      field: 'dialogue_style',
      edits: [{ find: 'bar', replace: 'BAR' }],
    });
    expect(result.applied).toHaveLength(1);
    const plot = await Plots.getPlot(projectId);
    expect(plot.dialogue_style).toBe('foo BAR baz');
  });

  it('appendEntityFieldMarkdown appends to plot.dialogue_style', async () => {
    await Plots.updatePlot(projectId, { dialogue_style: 'Base style.' });
    await Gateway.appendEntityFieldMarkdown({ projectId,
      entityType: 'plot',
      entityId: 'plot',
      field: 'dialogue_style',
      content: 'Sample line.',
    });
    const plot = await Plots.getPlot(projectId);
    expect(plot.dialogue_style).toBe('Base style.\n\nSample line.');
  });
});
