// Prop plates: an artwork that shows ONE object by itself (`artwork.prop` =
// the object's name). The artwork critique asks for one per prop, and a cut
// frame binds it as that object — never as a view of the set that owns it.

import { describe, it, expect } from 'vitest';
import { ObjectId } from 'mongodb';
import {
  REQUIREMENTS_SYSTEM_PROMPT,
  MATCH_SYSTEM_PROMPT,
  PROPOSALS_SYSTEM_PROMPT,
  buildMatchText,
  normalizeProposals,
  normalizeRequirements,
} from '../src/web/artworkCritiqueRules.js';
import { composeStartFramePrompt } from '../src/web/startFramePrompt.js';

const set = { kind: 'set', id: new ObjectId(), name: 'Theatre lot', doc: { name: 'Theatre lot' } };

describe('artwork critique', () => {
  it('the prompts ask for, match and brief a prop plate', () => {
    expect(REQUIREMENTS_SYSTEM_PROMPT).toContain('# Props');
    expect(REQUIREMENTS_SYSTEM_PROMPT).toContain('PROP PLATE');
    expect(MATCH_SYSTEM_PROMPT).toContain('[PROP PLATE]');
    expect(PROPOSALS_SYSTEM_PROMPT).toContain('a requirement of category prop is a PROP PLATE');
  });

  it('nothing is dropped: every requirement and every prop plate is kept', () => {
    const row = (category, i) => ({ subject_id: String(set.id), subject_kind: 'set', category, summary: `${category} ${i}`, detail: '', quote: '', importance: 'essential' });
    const raw = { requirements: [...Array.from({ length: 30 }, (_, i) => row('view', i)), ...Array.from({ length: 20 }, (_, i) => row('prop', i))], unlinked_mentions: [] };
    const { requirements, warnings } = normalizeRequirements(raw, [set]);
    expect(requirements).toHaveLength(50);
    expect(requirements.map((r) => r.id)).toEqual(Array.from({ length: 50 }, (_, i) => `set:${set.id}:${i + 1}`));
    expect(warnings).toEqual([]);
  });

  it('the matcher is told which pieces are prop plates', () => {
    const text = buildMatchText({
      beat: { order: 2, name: 'Cold open' },
      subject: set,
      requirements: [{ id: 'set:x:1', category: 'prop', summary: 'crocheted hacky sack', detail: 'plum-sized', importance: 'essential' }],
      artworks: [
        { name: 'Hacky sack plate', description: 'a crocheted ball on grey', prop: 'crocheted hacky sack' },
        { name: 'Lot at dusk', description: 'the parking lot' },
      ],
    });
    expect(text).toContain('1. [PROP PLATE: crocheted hacky sack] "Hacky sack plate"');
    expect(text).toContain('2. "Lot at dusk"');
  });

  it('a proposal for a prop requirement carries the object name; a view proposal does not', () => {
    const requirements = [
      { id: 'set:x:1', category: 'prop', summary: 'crocheted hacky sack' },
      { id: 'set:x:2', category: 'view', summary: 'The lot from the curb' },
    ];
    const { proposals } = normalizeProposals({
      proposals: [
        { requirement_ids: ['set:x:1'], name: 'Hacky sack — prop plate', prompt: 'a crocheted ball', reference_indexes: [], rationale: '' },
        { requirement_ids: ['set:x:2'], name: 'Curb view', prompt: 'the lot', reference_indexes: [], rationale: '' },
      ],
    }, { subject: set, requirements, catalog: [] });
    expect(proposals[0].prop).toBe('crocheted hacky sack');
    expect(proposals[1]).not.toHaveProperty('prop');
  });
});

describe('frame binding', () => {
  it('a prop reference is bound as the object, numbered by its listed position', () => {
    const refs = [
      { label: 'Young Keys', role: 'identity' },
      { label: 'crocheted hacky sack', role: 'prop' },
      { label: 'the set "Theatre lot"', role: 'look' },
    ];
    const prompt = composeStartFramePrompt('A ball in mid-air.', refs);
    expect(prompt).toContain('Image 2 is a prop plate of the crocheted hacky sack');
    expect(prompt).toContain('Take nothing else from it');
    expect(prompt).not.toContain('Image 2 shows');
  });
});
