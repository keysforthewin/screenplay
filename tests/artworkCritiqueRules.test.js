import { describe, it, expect } from 'vitest';
import { ObjectId } from 'mongodb';
import {
  normalizeRequirements,
  normalizeAudit,
  normalizeProposals,
  rebindCharacterPrompt,
  computeCoverage,
  buildSubjectRoster,
  buildAuditText,
  REQUIREMENTS_SCHEMA,
  AUDIT_SCHEMA,
  PROPOSALS_SCHEMA,
  MAX_REQUIREMENTS_PER_SUBJECT,
  MAX_PROPOSALS_PER_SUBJECT,
} from '../src/web/artworkCritiqueRules.js';

const setId = new ObjectId();
const charId = new ObjectId();
const portraitId = 'f'.repeat(24);
const subjects = [
  { kind: 'set', id: setId, name: 'Theatre lot', doc: { name: 'Theatre lot' } },
  { kind: 'character', id: charId, name: 'Sarah', doc: { name: 'Sarah', hollywood_actor: 'Jodie Comer', fields: {}, main_image_id: new ObjectId(portraitId), images: [{ _id: new ObjectId(portraitId) }] } },
];

function walkSchema(node, fn) {
  if (!node || typeof node !== 'object') return;
  fn(node);
  for (const v of Object.values(node.properties || {})) walkSchema(v, fn);
  if (node.items) walkSchema(node.items, fn);
}

describe('schemas', () => {
  it('every object forbids additional properties', () => {
    for (const s of [REQUIREMENTS_SCHEMA, AUDIT_SCHEMA, PROPOSALS_SCHEMA]) {
      walkSchema(s, (n) => { if (n.type === 'object') expect(n.additionalProperties).toBe(false); });
    }
  });
});

describe('normalizeRequirements', () => {
  it('drops unknown subjects, re-keys ids per subject, clamps and caps', () => {
    const raw = {
      requirements: [
        { subject_id: String(setId), subject_kind: 'set', category: 'view', summary: 'Lot from the kerb', detail: 'd', quote: 'EXT. LOT', importance: 'essential' },
        { subject_id: 'nope', subject_kind: 'set', category: 'view', summary: 'ghost', detail: '', quote: '', importance: 'useful' },
        { subject_id: String(charId), subject_kind: 'character', category: 'view', summary: 'x'.repeat(200), detail: 'd', quote: 'q', importance: 'maybe' },
        ...Array.from({ length: MAX_REQUIREMENTS_PER_SUBJECT + 2 }, (_, i) => ({ subject_id: String(setId), subject_kind: 'set', category: 'prop', summary: `p${i}`, detail: '', quote: '', importance: 'useful' })),
      ],
      unlinked_mentions: [{ name: 'Parking lot', kind: 'set', quote: 'the lot' }, { name: '', kind: 'set', quote: '' }],
    };
    const { requirements, unlinked_mentions, warnings } = normalizeRequirements(raw, subjects);
    expect(requirements[0]).toMatchObject({ id: `set:${setId}:1`, subject_kind: 'set', category: 'view', importance: 'essential', status: 'missing', covered_by: [] });
    const charReq = requirements.find((r) => r.subject_kind === 'character');
    expect(charReq.id).toBe(`character:${charId}:1`);
    expect(charReq.category).toBe('costume'); // set category on a character → first character category
    expect(charReq.summary.length).toBeLessThanOrEqual(120);
    expect(charReq.importance).toBe('useful');
    expect(requirements.filter((r) => r.subject_kind === 'set')).toHaveLength(MAX_REQUIREMENTS_PER_SUBJECT);
    expect(unlinked_mentions).toEqual([{ name: 'Parking lot', kind: 'set', quote: 'the lot' }]);
    expect(warnings.some((w) => /unknown subject/.test(w))).toBe(true);
    expect(warnings.some((w) => /more than/.test(w))).toBe(true);
  });

  it('buildSubjectRoster lists ids the model must echo', () => {
    const text = buildSubjectRoster(subjects);
    expect(text).toContain(`SET "Theatre lot" (id ${setId})`);
    expect(text).toContain(`CHARACTER "Sarah" (id ${charId})`);
  });
});

describe('normalizeAudit', () => {
  const artworks = [
    { _id: new ObjectId(), result_image_id: new ObjectId(), name: 'Front', description: '' },
    { _id: new ObjectId(), result_image_id: new ObjectId(), name: 'Side', description: '' },
  ];
  const requirements = [
    { id: 'r1', summary: 'a', detail: '', quote: '', importance: 'essential', category: 'view' },
    { id: 'r2', summary: 'b', detail: '', quote: '', importance: 'useful', category: 'view' },
    { id: 'r3', summary: 'c', detail: '', quote: '', importance: 'useful', category: 'view' },
  ];

  it('maps indexes to artwork ids, defaults unmentioned requirements to missing, clamps the score', () => {
    const out = normalizeAudit({
      coverage: [
        { requirement_id: 'r1', status: 'covered', artwork_indexes: [1, 9], note: 'ok' },
        { requirement_id: 'r2', status: 'partial', artwork_indexes: [], note: 'no image' },
      ],
      artworks: [
        { index: 2, issues: [{ kind: 'wardrobe', note: 'wrong coat' }, { kind: 'bogus', note: 'x' }, { kind: 'light', note: '' }], suggested_edit: 'Change the coat.' },
        { index: 7, issues: [{ kind: 'light', note: 'ignored' }], suggested_edit: '' },
      ],
      accuracy_score: 14,
      summary: 'sum',
    }, { requirements, artworks });
    expect(out.requirements[0]).toMatchObject({ status: 'covered', note: 'ok' });
    expect(out.requirements[0].covered_by.map(String)).toEqual([String(artworks[0]._id)]);
    expect(out.requirements[1].status).toBe('missing'); // partial with no covering image → missing
    expect(out.requirements[2].status).toBe('missing');
    expect(out.artworks[0]).toMatchObject({ artwork_id: artworks[0]._id, issues: [], suggested_edit: '' });
    expect(out.artworks[1].issues).toEqual([{ kind: 'wardrobe', note: 'wrong coat' }, { kind: 'other', note: 'x' }]);
    expect(out.artworks[1].suggested_edit).toBe('Change the coat.');
    expect(out.accuracy_score).toBe(10);
    expect(out.summary).toBe('sum');
  });

  it('buildAuditText numbers the artwork in attachment order and lists every requirement', () => {
    const text = buildAuditText({ beat: { order: 2, name: 'B' }, subject: subjects[0], subjectCard: '- Theatre lot', requirements, artworks });
    expect(text).toContain('Artwork 1 — "Front"');
    expect(text).toContain('Artwork 2 — "Side"');
    expect(text).toContain('r3 [view] c');
  });
});

describe('normalizeProposals', () => {
  const catalog = [
    { index: 1, image_id: 'a'.repeat(24), owner_type: 'set', owner_name: 'Theatre lot' },
    { index: 2, image_id: 'b'.repeat(24), owner_type: 'character', owner_name: 'Sarah' },
  ];
  const requirements = [{ id: 'character:x:1', summary: 'Fury, close' }, { id: 'character:x:2', summary: 'Brown coat' }];

  it('resolves references, composes the character prompt, assigns ids and status', () => {
    const { proposals, warnings } = normalizeProposals({
      proposals: [
        { requirement_ids: ['character:x:1', 'character:x:2', 'ghost'], name: 'Sarah furious in the brown coat', prompt: 'jaw set, eyes narrowed', reference_indexes: [2, 2, 9], rationale: 'r' },
        { requirement_ids: ['ghost'], name: 'dropped', prompt: 'p', reference_indexes: [], rationale: '' },
        { requirement_ids: ['character:x:1'], name: 'dropped too', prompt: '', reference_indexes: [], rationale: '' },
      ],
    }, { subject: subjects[1], requirements, catalog });
    expect(proposals).toHaveLength(1);
    const p = proposals[0];
    expect(p._id).toBeInstanceOf(ObjectId);
    expect(p).toMatchObject({ host_type: 'character', host_name: 'Sarah', status: 'proposed', model: null, artwork_id: null, requirement_ids: ['character:x:1', 'character:x:2'] });
    expect(String(p.host_id)).toBe(String(charId));
    // The portrait leads even though the planner never picked it; the artwork pick follows.
    expect(p.reference_image_ids.map(String)).toEqual([portraitId, 'b'.repeat(24)]);
    expect(p.prompt).toContain('Jodie Comer');
    expect(p.prompt).not.toContain('Sarah');
    expect(p.prompt).toContain('jaw set, eyes narrowed');
    expect(p.prompt).toContain("Reference image 1 is this person's portrait");
    expect(p.prompt).toContain('Reference image 2 is the same person, another view');
    expect(p.prompt).toContain('STRICT OUTPUT RULES');
    // two dropped proposals + no wardrobe lock on this character
    expect(warnings).toHaveLength(3);
    expect(warnings.some((w) => /no wardrobe lock/.test(w))).toBe(true);
  });

  it('quotes the locked wardrobe and attaches the plate at reference 2', () => {
    const plate = 'c'.repeat(24);
    const locked = { ...subjects[1], doc: { ...subjects[1].doc, wardrobe_image_id: new ObjectId(plate), fields: { ...(subjects[1].doc.fields || {}), wardrobe: '**navy** flannel shirt, tan canvas jacket' } } };
    const { proposals, warnings } = normalizeProposals({
      proposals: [{ requirement_ids: ['character:x:1'], name: 'Fury', prompt: 'jaw set', reference_indexes: [1, 2], rationale: '' }],
    }, { subject: locked, requirements, catalog });
    const p = proposals[0];
    expect(p.reference_image_ids.map(String)).toEqual([portraitId, plate, 'b'.repeat(24), 'a'.repeat(24)]);
    const lines = p.prompt.split('\n');
    expect(lines[1]).toBe('Wardrobe (locked — reproduce exactly): navy flannel shirt, tan canvas jacket');
    expect(lines[3]).toMatch(/^Reference image 2 is this person's wardrobe plate/);
    expect(warnings.some((w) => /wardrobe/.test(w))).toBe(false);
  });

  it('a beat override replaces the character wardrobe for that beat', () => {
    const locked = { ...subjects[1], doc: { ...subjects[1].doc, _id: charId, fields: { wardrobe: 'navy flannel shirt' } } };
    const beat = { wardrobe_overrides: { [String(charId)]: 'shirt sleeves rolled, no jacket' } };
    const { proposals } = normalizeProposals({
      proposals: [{ requirement_ids: ['character:x:1'], name: 'Fury', prompt: 'jaw set', reference_indexes: [], rationale: '' }],
    }, { subject: locked, requirements, catalog, beat });
    expect(proposals[0].prompt).toContain('Wardrobe (locked — reproduce exactly): shirt sleeves rolled, no jacket');
    expect(proposals[0].prompt).not.toContain('navy flannel');
  });

  it('a plate that is also the portrait stays one reference with both jobs', () => {
    const locked = { ...subjects[1], doc: { ...subjects[1].doc, wardrobe_image_id: new ObjectId(portraitId) } };
    const { proposals } = normalizeProposals({
      proposals: [{ requirement_ids: ['character:x:1'], name: 'Fury', prompt: 'jaw set', reference_indexes: [], rationale: '' }],
    }, { subject: locked, requirements, catalog });
    expect(proposals[0].reference_image_ids.map(String)).toEqual([portraitId]);
    expect(proposals[0].prompt).toContain("Reference image 1 is this person's portrait AND wardrobe plate");
  });

  it('orders a character proposal portrait → artwork → set plate and binds each image', () => {
    const { proposals } = normalizeProposals({
      proposals: [{ requirement_ids: ['character:x:1'], name: 'Seated', prompt: 'seated in the rear bench', reference_indexes: [1, 2], rationale: '' }],
    }, { subject: subjects[1], requirements, catalog });
    const p = proposals[0];
    // The planner listed the set plate first; it still goes last so image 1 is never the place.
    expect(p.reference_image_ids.map(String)).toEqual([portraitId, 'b'.repeat(24), 'a'.repeat(24)]);
    expect(p.prompt).toContain('Reference image 3 shows the PLACE only');
    expect(p.prompt.indexOf("Reference image 1 is this person's portrait")).toBeLessThan(p.prompt.indexOf('seated in the rear bench'));
  });

  it('falls back to the first gallery image, then warns once when the character has no portrait', () => {
    const galleryOnly = { ...subjects[1], doc: { ...subjects[1].doc, main_image_id: null, images: [{ _id: new ObjectId('e'.repeat(24)) }] } };
    const one = normalizeProposals({ proposals: [{ requirement_ids: ['character:x:1'], name: 'n', prompt: 'p', reference_indexes: [], rationale: '' }] }, { subject: galleryOnly, requirements, catalog });
    expect(one.proposals[0].reference_image_ids.map(String)).toEqual(['e'.repeat(24)]);
    expect(one.warnings.filter((w) => /no portrait/.test(w))).toHaveLength(0);

    const bare = { ...subjects[1], doc: { ...subjects[1].doc, main_image_id: null, images: [] } };
    const two = normalizeProposals({
      proposals: [
        { requirement_ids: ['character:x:1'], name: 'n', prompt: 'p', reference_indexes: [2], rationale: '' },
        { requirement_ids: ['character:x:2'], name: 'm', prompt: 'q', reference_indexes: [], rationale: '' },
      ],
    }, { subject: bare, requirements, catalog });
    expect(two.proposals[0].reference_image_ids.map(String)).toEqual(['b'.repeat(24)]);
    expect(two.proposals[1].reference_image_ids).toEqual([]);
    expect(two.proposals[1].prompt).not.toContain('Reference image');
    expect(two.warnings.filter((w) => /no portrait/.test(w))).toHaveLength(1);
  });

  it('leaves a set prompt as written and caps the count', () => {
    const many = Array.from({ length: MAX_PROPOSALS_PER_SUBJECT + 1 }, (_, i) => ({ requirement_ids: ['set:y:1'], name: `p${i}`, prompt: `prompt ${i}`, reference_indexes: [1], rationale: '' }));
    const { proposals, warnings } = normalizeProposals({ proposals: many }, { subject: subjects[0], requirements: [{ id: 'set:y:1', summary: 's' }], catalog });
    expect(proposals).toHaveLength(MAX_PROPOSALS_PER_SUBJECT);
    expect(proposals[0].prompt).toBe('prompt 0');
    expect(proposals[0].host_type).toBe('set');
    expect(warnings.some((w) => /more than/.test(w))).toBe(true);
  });
});

describe('rebindCharacterPrompt', () => {
  const refs = [{ image_id: portraitId, role: 'portrait' }, { image_id: 'a'.repeat(24), role: 'set' }];

  it('replaces the pre-portrait authority sentence with the per-image binding, after the Subject line', () => {
    const old = 'Subject: a boy.\nThe attached reference images are the authority on this person\'s appearance: exact same face.\n\nseated at the window\n\nSTRICT OUTPUT RULES:\n- one person';
    const out = rebindCharacterPrompt(old, refs);
    expect(out.split('\n')[0]).toBe('Subject: a boy.');
    expect(out.split('\n')[1]).toMatch(/^Reference image 1 is this person's portrait/);
    expect(out.split('\n')[2]).toMatch(/^Reference image 2 shows the PLACE only/);
    expect(out).not.toContain('attached reference images are the authority');
    expect(out).toContain('seated at the window');
    expect(out).toContain('STRICT OUTPUT RULES');
  });

  it('is idempotent and tracks a changed reference list', () => {
    const once = rebindCharacterPrompt('Subject: a boy.\n\nprose', refs);
    const twice = rebindCharacterPrompt(once, refs);
    expect(twice).toBe(once);
    const fewer = rebindCharacterPrompt(once, [refs[0]]);
    expect(fewer).toContain('Reference image 1 is this person');
    expect(fewer).not.toContain('Reference image 2');
  });

  it('drops a stale binding entirely when nothing is attached', () => {
    const out = rebindCharacterPrompt('Subject: a boy.\nReference image 1 is this person\'s portrait: x.\n\nprose', []);
    expect(out).toBe('Subject: a boy.\n\nprose');
  });

  it('refreshes a stale wardrobe line and drops it when the lock is gone', () => {
    const stale = 'Subject: a boy.\nWardrobe (locked — reproduce exactly): red hoodie\nReference image 1 is this person\'s portrait: x.\n\nprose';
    const out = rebindCharacterPrompt(stale, [refs[0]], { wardrobe: 'Wardrobe (locked — reproduce exactly): navy flannel shirt' });
    expect(out.split('\n')[1]).toBe('Wardrobe (locked — reproduce exactly): navy flannel shirt');
    expect(out).not.toContain('red hoodie');
    expect(out.split('\n')[2]).toMatch(/^Reference image 1/);
    const gone = rebindCharacterPrompt(stale, [refs[0]]);
    expect(gone).not.toContain('Wardrobe (locked');
  });
});

describe('computeCoverage', () => {
  it('weights essential requirements double and partial half', () => {
    const subjects = [
      { requirements: [{ importance: 'essential', status: 'covered' }, { importance: 'useful', status: 'partial' }, { importance: 'useful', status: 'missing' }] },
      { requirements: [{ importance: 'essential', status: 'missing' }] },
    ];
    // weights: 2 + 1 + 1 + 2 = 6; covered 2 + 0.5 = 2.5 → 42%
    expect(computeCoverage(subjects)).toEqual({ total: 4, covered: 1, partial: 1, missing: 2, pct: 42 });
    expect(computeCoverage([])).toEqual({ total: 0, covered: 0, partial: 0, missing: 0, pct: null });
  });
});
