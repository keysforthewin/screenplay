// Advisory pre-generation readiness report: deterministic inventory checks +
// one LLM gap pass, persisted on the beat, never blocking generation.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
const Plots = await import('../src/mongo/plots.js');
const Sets = await import('../src/mongo/sets.js');
const Characters = await import('../src/mongo/characters.js');
const Readiness = await import('../src/web/storyboardReadiness.js');
const Generate = await import('../src/web/storyboardGenerate.js');
const { appendDoneArtwork } = await import('../src/mongo/artworks.js');
const { _setFrameReferenceScorerForTests } = await import('../src/llm/frameReferenceSelector.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  Readiness._setGapReporterForTests(async () => ({ gaps: [], summary: '' }));
});

afterEach(() => {
  Readiness._setGapReporterForTests(null);
});

function codesOf(checks, severity = null) {
  return checks
    .filter((c) => (severity ? c.severity === severity : true))
    .map((c) => c.code);
}

describe('runDeterministicChecks', () => {
  it('flags unresolvable roster names as missing', () => {
    const beat = {
      name: 'B', body: 'stuff happens',
      characters: ['Steve', 'Ghost'], sets: ['Kitchen', 'Nowhere'],
    };
    const checks = Readiness.runDeterministicChecks({
      beat,
      characters: [{ name: 'Steve', images: [{ _id: 1 }], fields: { description: 'x' } }],
      sets: [{ name: 'Kitchen', artworks: [{ status: 'done', result_image_id: 1 }], description: 'x' }],
    });
    expect(codesOf(checks, 'warn')).toContain('missing_character');
    expect(codesOf(checks, 'warn')).toContain('missing_set');
    expect(checks.find((c) => c.code === 'missing_character').subject).toBe('Ghost');
    expect(checks.find((c) => c.code === 'missing_set').subject).toBe('Nowhere');
  });

  it('flags characters without visuals and with thin descriptions', () => {
    const beat = { name: 'B', body: 'x', characters: ['Bare'], sets: [] };
    const checks = Readiness.runDeterministicChecks({
      beat,
      characters: [{ name: 'Bare', images: [], artworks: [], character_sheet_image_ids: [], fields: {} }],
      sets: [],
    });
    expect(codesOf(checks, 'warn')).toContain('character_no_visuals');
    expect(codesOf(checks, 'info')).toContain('character_thin_description');
  });

  it('distinguishes reference-only sets from artwork-less sets', () => {
    const beat = { name: 'B', body: 'x', characters: [], sets: ['RefOnly', 'Empty'] };
    const checks = Readiness.runDeterministicChecks({
      beat,
      characters: [],
      sets: [
        { name: 'RefOnly', images: [{ _id: 1 }], artworks: [], description: 'look' },
        { name: 'Empty', images: [], artworks: [], description: '' },
      ],
    });
    expect(codesOf(checks, 'info')).toContain('set_reference_only');
    expect(codesOf(checks, 'warn')).toContain('set_no_artwork');
    expect(codesOf(checks, 'info')).toContain('set_thin_description');
  });

  it('flags sets and characters whose artwork carries no descriptions', () => {
    const beat = { name: 'B', body: 'x', characters: ['Steve'], sets: ['Kitchen'] };
    const checks = Readiness.runDeterministicChecks({
      beat,
      characters: [{
        name: 'Steve',
        images: [{ _id: 1 }],
        artworks: [{ status: 'done', result_image_id: 1, description: '' }],
        fields: { description: 'a guy' },
      }],
      sets: [{
        name: 'Kitchen',
        images: [{ _id: 2 }],
        artworks: [{ status: 'done', result_image_id: 2, description: '' }],
        description: 'greasy',
      }],
    });
    // Codes are host-prefixed so ReadinessPanel's entityLink() can route the
    // reader to the right page from the code alone.
    expect(codesOf(checks, 'info')).toContain('character_artwork_no_description');
    expect(codesOf(checks, 'info')).toContain('set_artwork_no_description');
    expect(checks.find((c) => c.code === 'character_artwork_no_description').subject).toBe('Steve');
    expect(checks.find((c) => c.code === 'set_artwork_no_description').subject).toBe('Kitchen');
  });

  it('stays quiet when at least one plate is described', () => {
    const beat = { name: 'B', body: 'x', characters: [], sets: ['Kitchen'] };
    const checks = Readiness.runDeterministicChecks({
      beat,
      characters: [],
      sets: [{
        name: 'Kitchen',
        images: [{ _id: 2 }],
        artworks: [
          { status: 'done', result_image_id: 2, description: 'Greasy tiled galley kitchen.' },
          { status: 'done', result_image_id: 3, description: '' },
        ],
        description: 'greasy',
      }],
    });
    expect(codesOf(checks)).not.toContain('set_artwork_no_description');
  });

  it('does not flag artwork descriptions on a host with no artwork at all', () => {
    const beat = { name: 'B', body: 'x', characters: [], sets: ['Empty'] };
    const checks = Readiness.runDeterministicChecks({
      beat,
      characters: [],
      sets: [{ name: 'Empty', images: [], artworks: [], description: 'x' }],
    });
    // set_no_artwork already covers this case — a second check would be noise.
    expect(codesOf(checks)).not.toContain('set_artwork_no_description');
  });

  it('notes missing sets and empty bodies as info', () => {
    const beat = { name: 'B', body: '   ', characters: [], sets: [] };
    const checks = Readiness.runDeterministicChecks({ beat, characters: [], sets: [] });
    expect(codesOf(checks, 'info')).toContain('no_sets_linked');
    expect(codesOf(checks, 'info')).toContain('empty_body');
  });

  it('is silent on a fully-backed beat', () => {
    const beat = { name: 'B', body: 'They fight in the kitchen.', characters: ['Steve'], sets: ['Kitchen'] };
    const checks = Readiness.runDeterministicChecks({
      beat,
      characters: [{
        name: 'Steve',
        images: [{ _id: 1 }],
        artworks: [{ status: 'done', result_image_id: 1 }],
        fields: { description: 'a guy' },
      }],
      sets: [{
        name: 'Kitchen',
        images: [{ _id: 2 }],
        artworks: [{ status: 'done', result_image_id: 2 }],
        description: 'greasy',
      }],
    });
    expect(checks.filter((c) => c.severity === 'warn')).toEqual([]);
  });
});

describe('rosterManifest', () => {
  it('tells the gap reporter how many plates carry descriptions', () => {
    const manifest = Readiness.rosterManifest(
      [],
      [{
        name: 'Kitchen',
        images: [],
        description: 'greasy',
        artworks: [
          { status: 'done', result_image_id: 1, description: 'Tiled galley kitchen.' },
          { status: 'done', result_image_id: 2, description: '' },
        ],
      }],
    );
    expect(manifest).toContain('described plates: 1/2');
  });

  it('reports no plates when the host has none', () => {
    const manifest = Readiness.rosterManifest(
      [{ name: 'Steve', images: [], artworks: [], fields: { description: 'a guy' } }],
      [],
    );
    expect(manifest).toContain('described plates: 0/0');
  });
});

describe('buildReadinessReport', () => {
  it('combines checks with the LLM gap pass and counts severities', async () => {
    await Sets.createSet({ projectId, name: 'Kitchen', description: 'greasy' });
    const beat = await Plots.createBeat({
      projectId, name: 'B', desc: 'd', body: 'A dragon lands on the kitchen.', sets: ['Kitchen'],
    });
    Readiness._setGapReporterForTests(async ({ beat: b }) => {
      expect(b.name).toBe('B');
      return {
        gaps: [{
          element: 'dragon', element_kind: 'effect', issue: 'no_matching_entity',
          matched_entity: null, note: 'No visual reference for the dragon.',
        }],
        summary: 'One unbacked element.',
      };
    });
    const report = await Readiness.buildReadinessReport({
      projectId,
      beat: await Plots.getBeat(projectId, beat._id.toString()),
    });
    expect(report.gaps).toHaveLength(1);
    expect(report.summary).toBe('One unbacked element.');
    expect(report.counts.warnings).toBeGreaterThan(0); // set_no_artwork at least
    expect(report.llm_error).toBeUndefined();
  });

  it('survives a gap-reporter failure (advisory contract: never throws)', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'x' });
    Readiness._setGapReporterForTests(async () => {
      throw new Error('model down');
    });
    const report = await Readiness.buildReadinessReport({
      projectId,
      beat: await Plots.getBeat(projectId, beat._id.toString()),
    });
    expect(report.gaps).toEqual([]);
    expect(report.llm_error).toMatch(/model down/);
    expect(Array.isArray(report.checks)).toBe(true);
  });
});

describe('standalone readiness job', () => {
  it('runs to done and carries the report', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'x' });
    const { job_id } = await Readiness.startReadinessJob({
      projectId,
      beatId: beat._id.toString(),
    });
    let job;
    for (let i = 0; i < 200; i++) {
      job = Readiness.getReadinessJob(job_id);
      if (job && ['done', 'error'].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(job.status).toBe('done');
    expect(job.report).toBeTruthy();
    expect(Array.isArray(job.report.checks)).toBe(true);
    // Persisted on the beat too.
    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.readiness_report).toBeTruthy();
  });
});

describe('generation integrates readiness as a non-blocking first phase', () => {
  beforeEach(() => {
    Generate._setScenePlannerForTests(async () => ({
      sceneBible: null,
      outline: [{
        description: 'one shot', shot_type: 'medium', duration_seconds: 5,
        transition_in: '', characters_in_scene: [],
      }],
    }));
    Generate._setShotExpanderForTests(async ({ outline }) =>
      outline.map(() => ({ start_frame_prompt: 'a frame', video_prompt: 'motion' })),
    );
    Generate._setImageDispatcherForTests(() => {
      throw new Error('no images during generation');
    });
    Generate._setCritiquePanelForTests(async () => ({
      overall: 7, lowest_lens: 'cinematic',
      lenses: [{ lens: 'bible', score: 7, comments: 'ok' }],
      model: 'test', created_at: new Date(), target: 'prompt',
    }));
    _setFrameReferenceScorerForTests(async ({ candidates }) => {
      const m = new Map();
      candidates.forEach((_, i) => m.set(i + 1, 0.9));
      return m;
    });
  });
  afterEach(() => {
    _setFrameReferenceScorerForTests(null);
  });

  async function waitForJob(jobId) {
    for (let i = 0; i < 300; i++) {
      const job = Generate.getStoryboardGenerationJob(jobId);
      if (job && ['done', 'partial', 'error'].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('job never completed');
  }

  it('persists the report on the beat and the job, then generates normally', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'x' });
    const jobId = await Generate.startStoryboardGenerationJob({
      projectId, beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');
    expect(job.readiness).toBeTruthy();
    expect(Array.isArray(job.readiness.checks)).toBe(true);
    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.readiness_report).toBeTruthy();
  });

  it('still generates when the readiness builder itself blows up', async () => {
    Readiness._setGapReporterForTests(() => {
      throw new Error('synchronous explosion');
    });
    const beat = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'x' });
    const jobId = await Generate.startStoryboardGenerationJob({
      projectId, beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');
    expect(job.completed).toBe(1);
  });
});
