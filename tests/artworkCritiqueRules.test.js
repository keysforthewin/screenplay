import { describe, it, expect } from 'vitest';
import { ObjectId } from 'mongodb';
import {
  normalizeRequirements,
  normalizeArtworkAudit,
  deriveRequirementStatus,
  subjectAccuracy,
  requirementsSignature,
  auditEntryIsCurrent,
  normalizeMatches,
  buildMatchText,
  matchedEntry,
  reviewCandidates,
  requirementNeedsRegeneration,
  deriveArtworkScore,
  normalizeReviewCriteria,
  REVIEW_CRITERIA,
  AUDIT_SYSTEM_PROMPT,
  composeClimbEditPrompt,
  normalizeProposals,
  composeSetProposalPrompt,
  rebindSetPrompt,
  rebindCharacterPrompt,
  computeCoverage,
  buildSubjectRoster,
  buildAuditText,
  REQUIREMENTS_SCHEMA,
  AUDIT_SCHEMA,
  PROPOSALS_SCHEMA,
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
  it('drops unknown subjects, re-keys ids per subject, clamps, and drops nothing', () => {
    const raw = {
      requirements: [
        { subject_id: String(setId), subject_kind: 'set', category: 'view', summary: 'Lot from the kerb', detail: 'd', quote: 'EXT. LOT', importance: 'essential' },
        { subject_id: 'nope', subject_kind: 'set', category: 'view', summary: 'ghost', detail: '', quote: '', importance: 'useful' },
        { subject_id: String(charId), subject_kind: 'character', category: 'view', summary: 'x'.repeat(200), detail: 'd', quote: 'q', importance: 'maybe' },
        ...Array.from({ length: 14 }, (_, i) => ({ subject_id: String(setId), subject_kind: 'set', category: 'view', summary: `p${i}`, detail: '', quote: '', importance: 'useful' })),
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
    expect(requirements.filter((r) => r.subject_kind === 'set')).toHaveLength(15); // nothing is dropped
    expect(unlinked_mentions).toEqual([{ name: 'Parking lot', kind: 'set', quote: 'the lot' }]);
    expect(warnings.some((w) => /unknown subject/.test(w))).toBe(true);
    expect(warnings.some((w) => /more than/.test(w))).toBe(false);
  });

  it('buildSubjectRoster lists ids the model must echo', () => {
    const text = buildSubjectRoster(subjects);
    expect(text).toContain(`SET "Theatre lot" (id ${setId})`);
    expect(text).toContain(`CHARACTER "Sarah" (id ${charId})`);
  });
});

describe('audit normalizers', () => {
  const artworks = [
    { _id: new ObjectId(), result_image_id: new ObjectId(), name: 'Front', description: '' },
    { _id: new ObjectId(), result_image_id: new ObjectId(), name: 'Side', description: '' },
  ];
  const requirements = [
    { id: 'r1', summary: 'a', detail: '', quote: '', importance: 'essential', category: 'view' },
    { id: 'r2', summary: 'b', detail: '', quote: '', importance: 'useful', category: 'view' },
    { id: 'r3', summary: 'c', detail: '', quote: '', importance: 'useful', category: 'view' },
  ];

  it('normalizeArtworkAudit: per-artwork fits, issues and score; an unanswered artwork stays un-audited', () => {
    const out = normalizeArtworkAudit({
      artworks: [
        { index: 1, fits: [{ requirement_id: 'r1', fit: 'covered', lacking: 'ignored' }, { requirement_id: 'zz', fit: 'covered', lacking: '' }, { requirement_id: 'r1', fit: 'partial', lacking: 'dup' }], score: 14, issues: [], suggested_edit: 'ignored when nothing is wrong' },
        { index: 7, fits: [], score: 3, issues: [{ kind: 'light', note: 'ignored' }], suggested_edit: '' },
      ],
    }, { requirements, artworks, reqSig: 'sig' });
    expect(out[0]).toMatchObject({ artwork_id: artworks[0]._id, score: 10, fits: [{ requirement_id: 'r1', fit: 'covered', lacking: '' }], issues: [], suggested_edit: '', req_sig: 'sig' });
    expect(String(out[0].audited_image_id)).toBe(String(artworks[0].result_image_id));
    expect(out[1]).toMatchObject({ score: null, fits: [], audited_image_id: null });
    const two = normalizeArtworkAudit({
      artworks: [{ index: 2, fits: [{ requirement_id: 'r2', fit: 'partial', lacking: 'wrong coat' }], score: 6, issues: [{ kind: 'wardrobe', note: 'wrong coat' }, { kind: 'bogus', note: 'x' }, { kind: 'light', note: '' }], suggested_edit: 'Change the coat.' }],
    }, { requirements, artworks, reqSig: 'sig' });
    expect(two[1].issues).toEqual([{ kind: 'wardrobe', note: 'wrong coat' }, { kind: 'other', note: 'x' }]);
    expect(two[1].suggested_edit).toBe('Change the coat.');
    expect(auditEntryIsCurrent(two[1], artworks[1], 'sig')).toBe(true);
    expect(auditEntryIsCurrent(two[1], artworks[1], 'other')).toBe(false);
    expect(auditEntryIsCurrent(two[1], { ...artworks[1], result_image_id: new ObjectId() }, 'sig')).toBe(false);
    expect(auditEntryIsCurrent(two[0], artworks[0], 'sig')).toBe(false);
  });

  it('deriveRequirementStatus: covered beats partial, best score first, a partial carries what is lacking', () => {
    const entries = [
      { artwork_id: artworks[0]._id, score: 6, fits: [{ requirement_id: 'r1', fit: 'covered', lacking: '' }, { requirement_id: 'r2', fit: 'partial', lacking: 'too dark' }] },
      { artwork_id: artworks[1]._id, score: 9, fits: [{ requirement_id: 'r1', fit: 'covered', lacking: '' }, { requirement_id: 'r1x', fit: 'covered', lacking: '' }] },
    ];
    const out = deriveRequirementStatus(requirements, entries);
    expect(out.map((r) => r.status)).toEqual(['covered', 'partial', 'missing']);
    expect(out[0].covered_by.map(String)).toEqual([String(artworks[1]._id), String(artworks[0]._id)]);
    expect(out[1]).toMatchObject({ note: 'too dark' });
    expect(out[1].covered_by.map(String)).toEqual([String(artworks[0]._id)]);
    expect(subjectAccuracy(entries)).toBe(7.5);
    // A piece the reviewer has looked at outranks one only its description vouches for.
    const looked = deriveRequirementStatus(requirements, [{ ...entries[0], audited_image_id: 'img' }, entries[1]]);
    expect(looked[0].covered_by.map(String)).toEqual([String(artworks[0]._id), String(artworks[1]._id)]);
    expect(subjectAccuracy([])).toBeNull();
    expect(requirementsSignature(requirements, 'a')).not.toBe(requirementsSignature(requirements, 'b'));
    expect(requirementsSignature(requirements, 'a')).toBe(requirementsSignature(requirements.map((r) => ({ ...r, status: 'covered' })), 'a'));
  });

  it('normalizeMatches: per requirement, best first, with the fit the description supports', () => {
    const out = normalizeMatches({
      matches: [
        { requirement_id: 'r1', artworks: [{ index: 2, fit: 'covered', lacking: 'ignored' }, { index: 2, fit: 'partial', lacking: '' }, { index: 1, fit: 'partial', lacking: 'from the side' }, { index: 9, fit: 'covered', lacking: '' }] },
        { requirement_id: 'nope', artworks: [{ index: 1, fit: 'covered', lacking: '' }] },
      ],
      duplicate_groups: [[1, 2], [2], [1, 44]],
    }, { requirements, artworks });
    expect(out.matches).toEqual([
      { requirement_id: 'r1', artwork_id: String(artworks[1]._id), fit: 'covered', lacking: '' },
      { requirement_id: 'r1', artwork_id: String(artworks[0]._id), fit: 'partial', lacking: 'from the side' },
    ]);
    expect(out.duplicates).toEqual([[String(artworks[0]._id), String(artworks[1]._id)]]);
    // The older shortlist shape still reads: worth a look, not vouched for.
    const old = normalizeMatches({ candidates: [{ requirement_id: 'r1', artwork_indexes: [2, 2, 9] }], duplicate_groups: [] }, { requirements, artworks });
    expect(old.matches).toEqual([{ requirement_id: 'r1', artwork_id: String(artworks[1]._id), fit: 'partial', lacking: '' }]);
    expect(buildMatchText({ beat: { order: 1, name: 'B' }, subject: subjects[0], subjectCard: '', requirements, artworks })).toContain('2. "Side"');
    expect(matchedEntry(artworks[0], [{ requirement_id: 'r1', fit: 'covered', lacking: '' }], 'sig')).toMatchObject({ score: null, audited_image_id: null, action: null, req_sig: 'sig' });
  });

  it('reviewCandidates: the best matches per requirement, a rejected piece making room for the next', () => {
    const a = (n) => `a${n}`;
    const matches = [1, 2, 3, 4].map((n) => ({ requirement_id: 'r1', artwork_id: a(n), fit: 'covered', lacking: '' }));
    expect([...reviewCandidates([{ id: 'r1' }], matches, new Map())]).toEqual([a(1), a(2)]);
    // a1 was looked at and is not it; a2 was looked at and fits → a3 is next.
    const reviewed = new Map([[a(1), { fits: [] }], [a(2), { fits: [{ requirement_id: 'r1', fit: 'covered' }] }]]);
    expect([...reviewCandidates([{ id: 'r1' }], matches, reviewed)]).toEqual([a(2), a(3)]);
  });

  it('the rubric: the score is the weighted mean of the criteria, held near "does the job"', () => {
    expect(REVIEW_CRITERIA.map((c) => c.key)).toEqual(['requirement', 'beat', 'subject', 'reference', 'technical']);
    for (const c of REVIEW_CRITERIA) expect(AUDIT_SYSTEM_PROMPT).toContain(c.anchors[9]);
    const all = (n) => REVIEW_CRITERIA.map((c) => ({ key: c.key, score: n }));
    expect(deriveArtworkScore(all(8))).toBe(8);
    // (2×9 + 1.5×6 + 1.5×9 + 9 + 0.5×9) / 6.5 → 8.3
    expect(deriveArtworkScore(all(9).map((c) => (c.key === 'beat' ? { ...c, score: 6 } : c)))).toBe(8.3);
    // A clean picture of the wrong thing: 3 + 2, not the 8.2 the mean gives.
    expect(deriveArtworkScore(all(10).map((c) => (c.key === 'requirement' ? { ...c, score: 3 } : c)))).toBe(5);
    expect(deriveArtworkScore([])).toBeNull();
    expect(normalizeReviewCriteria([{ key: 'beat', score: 14, note: 'x' }, { key: 'beat', score: 2 }, { key: 'bogus', score: 5 }, { key: 'subject' }])).toEqual([{ key: 'beat', score: 10, note: 'x' }]);
  });

  it('normalizeArtworkAudit: criteria give the score; the action is held to what the answer supports', () => {
    const crit = (n) => REVIEW_CRITERIA.map((c) => ({ key: c.key, score: n, note: 'n' }));
    const out = normalizeArtworkAudit({
      artworks: [
        { index: 1, fits: [{ requirement_id: 'r1', fit: 'partial', lacking: 'door closed' }], criteria: crit(6), issues: [], action: 'edit', suggested_edit: 'Open the door.', regenerate_reason: '' },
        { index: 2, fits: [{ requirement_id: 'r1', fit: 'covered', lacking: '' }], criteria: crit(9), issues: [], action: 'edit', suggested_edit: 'Tweak.', regenerate_reason: '' },
      ],
    }, { requirements, artworks, reqSig: 's' });
    expect(out[0]).toMatchObject({ score: 6, action: 'edit', suggested_edit: 'Open the door.', regenerate_reason: '' });
    expect(out[0].criteria).toHaveLength(5);
    expect(out[1]).toMatchObject({ score: 9, action: 'keep', suggested_edit: '' }); // nothing wrong, 9/10
    const regen = normalizeArtworkAudit({ artworks: [{ index: 1, fits: [], criteria: crit(4), issues: [{ kind: 'angle', note: 'from behind' }], action: 'regenerate', suggested_edit: 'x', regenerate_reason: 'Wrong viewpoint.' }] }, { requirements, artworks: [artworks[0]], reqSig: 's' });
    expect(regen[0]).toMatchObject({ action: 'regenerate', suggested_edit: '', regenerate_reason: 'Wrong viewpoint.' });
    // An edit with no instruction cannot be applied.
    const noEdit = normalizeArtworkAudit({ artworks: [{ index: 1, fits: [], criteria: crit(5), issues: [{ kind: 'light', note: 'day' }], action: 'edit', suggested_edit: '', regenerate_reason: '' }] }, { requirements, artworks: [artworks[0]], reqSig: 's' });
    expect(noEdit[0].action).toBe('regenerate');
  });

  it('requirementNeedsRegeneration: the reviewer said so, or edits stopped helping — until the renders run out', () => {
    const r = { id: 'r1', status: 'covered', covered_by: ['a'] };
    const e = (over) => [{ artwork_id: 'a', audited_image_id: 'i', score: 5, action: 'edit', ...over }];
    expect(requirementNeedsRegeneration(r, e({}), [])).toBe(false);
    expect(requirementNeedsRegeneration(r, e({ action: 'regenerate' }), [])).toBe(true);
    expect(requirementNeedsRegeneration(r, e({ edit_attempts: 2 }), [])).toBe(true);
    expect(requirementNeedsRegeneration(r, e({ edit_attempts: 2, score: 9 }), [])).toBe(false);
    expect(requirementNeedsRegeneration(r, e({ action: 'regenerate', audited_image_id: null }), [])).toBe(false); // not looked at
    const made = [1, 2, 3].map(() => ({ status: 'done', requirement_ids: ['r1'] }));
    expect(requirementNeedsRegeneration(r, e({ action: 'regenerate' }), made)).toBe(false);
    expect(requirementNeedsRegeneration({ ...r, status: 'missing' }, [], [])).toBe(false);
  });

  it('composeClimbEditPrompt: the suggested edit, what is lacking, and what must survive', () => {
    const p = composeClimbEditPrompt({ suggestedEdit: 'Grade to dusk.', lacking: [{ summary: 'The car', lacking: 'door closed' }], keep: ['Lot from the entrance'], direction: 'wet tarmac' });
    expect(p).toContain('Grade to dusk.');
    expect(p).toContain('"The car" — still missing or different: door closed');
    expect(p).toContain('keep what it already shows — Lot from the entrance');
    expect(p).toContain('wet tarmac');
    expect(composeClimbEditPrompt({})).toBe('');
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

  it('binds a set proposal to the set artwork it picked and keeps every proposal', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ requirement_ids: ['set:y:1'], name: `p${i}`, prompt: `prompt ${i}`, reference_indexes: [1], rationale: '' }));
    const { proposals, warnings } = normalizeProposals({ proposals: many }, { subject: subjects[0], requirements: [{ id: 'set:y:1', summary: 's' }], catalog });
    expect(proposals).toHaveLength(9);
    expect(proposals[0].reference_image_ids.map(String)).toEqual(['a'.repeat(24)]);
    expect(proposals[0].prompt.split('\n')).toEqual([
      'Reference image 1 shows this same PLACE as it has already been rendered: match its architecture, materials, signage and colours; take the vantage and the light from the prompt, not from it.',
      '',
      'prompt 0',
    ]);
    expect(proposals[0].host_type).toBe('set');
    expect(warnings.some((w) => /more than|no picture/.test(w))).toBe(false);
  });

  it('a set proposal leads with the set\'s main photo, then its other photos, then artwork — and never another host\'s picture', () => {
    const main = 'd'.repeat(24);
    const photo = 'e'.repeat(24);
    const theatre = { ...subjects[0], doc: { name: 'Theatre lot', main_image_id: new ObjectId(main), images: [{ _id: new ObjectId(photo) }, { _id: new ObjectId(main) }] } };
    const rich = [
      { index: 1, image_id: 'a'.repeat(24), owner_type: 'set', owner_id: String(setId), owner_name: 'Theatre lot' },
      { index: 2, image_id: 'b'.repeat(24), owner_type: 'character', owner_name: 'Sarah' },
      { index: 3, image_id: photo, owner_type: 'set', owner_id: String(setId), owner_name: 'Theatre lot', upload: true },
      { index: 4, image_id: main, owner_type: 'set', owner_id: String(setId), owner_name: 'Theatre lot', upload: true },
      { index: 5, image_id: 'f'.repeat(24), owner_type: 'set', owner_id: 'g'.repeat(24), owner_name: 'Diner' },
    ];
    const { proposals, warnings } = normalizeProposals({
      // The planner listed artwork first and forgot the main photo; another set's plate and a character sneak in.
      proposals: [{ requirement_ids: ['set:y:1'], name: 'Lot at dusk', prompt: 'the lot from the curb at dusk', reference_indexes: [1, 2, 3, 5], rationale: '' }],
    }, { subject: theatre, requirements: [{ id: 'set:y:1', category: 'view', summary: 's' }], catalog: rich });
    const p = proposals[0];
    expect(p.reference_image_ids.map(String)).toEqual([main, photo, 'a'.repeat(24)]);
    const lines = p.prompt.split('\n');
    expect(lines[0]).toMatch(/^Reference image 1 is a photograph of this same PLACE/);
    expect(lines[1]).toMatch(/^Reference image 2 is a photograph of this same PLACE/);
    expect(lines[2]).toMatch(/^Reference image 3 shows this same PLACE as it has already been rendered/);
    expect(lines.at(-1)).toBe('the lot from the curb at dusk');
    expect(warnings).toEqual([]);
  });

  it('a set with no picture on file warns once; a prop plate carries no view of the place', () => {
    const bare = { ...subjects[0], doc: { name: 'Theatre lot', images: [] } };
    const requirements = [{ id: 'set:y:1', category: 'view', summary: 'v' }, { id: 'set:y:2', category: 'prop', summary: 'hacky sack' }];
    const cat = [{ index: 1, image_id: 'a'.repeat(24), owner_type: 'set', owner_id: 'g'.repeat(24), owner_name: 'Diner' }];
    const { proposals, warnings } = normalizeProposals({
      proposals: [
        { requirement_ids: ['set:y:1'], name: 'v', prompt: 'the lot', reference_indexes: [1], rationale: '' },
        { requirement_ids: ['set:y:2'], name: 'sack', prompt: 'a crocheted ball', reference_indexes: [1], rationale: '' },
      ],
    }, { subject: bare, requirements, catalog: cat });
    expect(proposals[0].reference_image_ids).toEqual([]);
    expect(proposals[0].prompt).toBe('the lot');
    expect(proposals[1].reference_image_ids).toEqual([]);
    expect(proposals[1].prompt).toBe('a crocheted ball');
    expect(warnings.filter((w) => /no picture of the set/.test(w))).toHaveLength(1);
  });

  it('rebindSetPrompt replaces a stored binding with the one for the references actually sent', () => {
    const stored = composeSetProposalPrompt('the lot at dusk', { references: [{ image_id: 'a'.repeat(24), role: 'artwork' }] });
    const rebound = rebindSetPrompt(stored, [{ image_id: 'd'.repeat(24), role: 'photo' }, { image_id: 'a'.repeat(24), role: 'artwork' }]);
    const lines = rebound.split('\n');
    expect(lines[0]).toMatch(/^Reference image 1 is a photograph/);
    expect(lines[1]).toMatch(/^Reference image 2 shows this same PLACE/);
    expect(lines.slice(2)).toEqual(['', 'the lot at dusk']);
    expect(rebindSetPrompt(stored, [])).toBe('the lot at dusk');
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
  it('coverage is "a picture answers it"; quality is the rubric score of the best reviewed piece', () => {
    const subjects = [
      { requirements: [{ importance: 'essential', status: 'covered' }, { importance: 'useful', status: 'partial' }, { importance: 'useful', status: 'missing' }] },
      { requirements: [{ importance: 'essential', status: 'missing' }] },
    ];
    // weights: 2 + 1 + 1 + 2 = 6; answered 2 + 1 = 3 → 50%; nothing reviewed → quality 0
    expect(computeCoverage(subjects)).toEqual({ total: 4, covered: 1, partial: 1, missing: 2, reviewed: 0, pct: 50, quality_pct: 0 });
    expect(computeCoverage([])).toEqual({ total: 0, covered: 0, partial: 0, missing: 0, reviewed: 0, pct: null, quality_pct: null });
    const scored = [{
      artworks: [{ artwork_id: 'a', score: 5, audited_image_id: 'i' }, { artwork_id: 'b', score: 8, audited_image_id: 'i' }, { artwork_id: 'c', score: null }],
      requirements: [
        { importance: 'essential', status: 'covered', covered_by: ['a', 'b'] },
        { importance: 'useful', status: 'partial', covered_by: ['a'] },
        { importance: 'useful', status: 'covered', covered_by: ['c'] }, // matched by description, not looked at
      ],
    }];
    // (2 × 0.8 + 1 × 0.5 + 0) / 4 → 53%; coverage 100%
    expect(computeCoverage(scored)).toMatchObject({ pct: 100, quality_pct: 53, reviewed: 2 });
  });
});
