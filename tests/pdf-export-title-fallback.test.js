import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const analyzeTextMock = vi.fn(async () => 'Inferred Slug');
vi.mock('../src/llm/analyze.js', () => ({
  analyzeText: (...args) => analyzeTextMock(...args),
}));

const { createProject } = await import('../src/mongo/projects.js');
const { exportToPdf } = await import('../src/pdf/export.js');
const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  analyzeTextMock.mockClear();
});

function userPromptFromCall() {
  return analyzeTextMock.mock.calls[0][0].user;
}

describe('exportToPdf title fallback', () => {
  it('uses an explicit title argument when one is provided (overrides plot.title)', async () => {
    await Plots.updatePlot(projectId, { title: 'Stored Title' });
    const result = await exportToPdf({ projectId, title: 'Explicit Title' });
    expect(result.path).toMatch(/\.pdf$/);
    expect(userPromptFromCall()).toMatch(/Working title: "Explicit Title"/);
  });

  it('falls back to the persisted plot.title when no title argument is given', async () => {
    await Plots.updatePlot(projectId, { title: 'Stored Title' });
    const result = await exportToPdf({ projectId,});
    expect(result.path).toMatch(/\.pdf$/);
    expect(userPromptFromCall()).toMatch(/Working title: "Stored Title"/);
  });

  it('passes "(none)" when neither arg nor plot.title is set (lets renderScreenplayPdf default kick in)', async () => {
    await Plots.getPlot(projectId);
    const result = await exportToPdf({ projectId,});
    expect(result.path).toMatch(/\.pdf$/);
    expect(userPromptFromCall()).toMatch(/Working title: \(none\)/);
  });

  it('treats a whitespace-only title argument as missing and uses plot.title', async () => {
    await Plots.updatePlot(projectId, { title: 'Stored Title' });
    const result = await exportToPdf({ projectId, title: '   ' });
    expect(result.path).toMatch(/\.pdf$/);
    expect(userPromptFromCall()).toMatch(/Working title: "Stored Title"/);
  });

  it('character-only filter (synthetic plot has no title) reads plot.title from DB as fallback', async () => {
    await Characters.createCharacter({ projectId, name: 'Alice', plays_self: true, own_voice: true });
    await Plots.updatePlot(projectId, { title: 'Stored Title' });
    const result = await exportToPdf({ projectId, characters: ['Alice'] });
    expect(result.path).toMatch(/\.pdf$/);
    expect(userPromptFromCall()).toMatch(/Working title: "Stored Title"/);
  });

  it('beats_query mode (synthetic plot) reads plot.title from DB as fallback', async () => {
    await Plots.createBeat({ projectId, name: 'Heist Setup', desc: 'Plan the score.' });
    await Plots.updatePlot(projectId, { title: 'Stored Title' });
    const result = await exportToPdf({ projectId, beats_query: 'heist' });
    expect(result.path).toMatch(/\.pdf$/);
    expect(userPromptFromCall()).toMatch(/Working title: "Stored Title"/);
  });
});
