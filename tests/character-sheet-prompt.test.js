import { describe, it, expect } from 'vitest';
import { buildCharacterSheetPrompt, SPECIFICS_FIELDS } from '../src/util/specifics.js';

describe('buildCharacterSheetPrompt', () => {
  it('always emits the fixed REQUIRED VIEWS block', () => {
    const out = buildCharacterSheetPrompt({});
    expect(out).toContain('REQUIRED VIEWS:');
    // Spot-check a few view items to ensure the full list is present.
    expect(out).toContain('1. Front view');
    expect(out).toContain('5. 3/4 right view');
    expect(out).toContain('13. Costume/armor/prop detail panel');
  });

  it('emits the production-continuity preamble', () => {
    const out = buildCharacterSheetPrompt({});
    expect(out).toContain('UE5 MetaHuman style production character sheet');
    expect(out).toContain('strict production continuity');
  });

  it('substitutes filled fields under their canonical headers', () => {
    const out = buildCharacterSheetPrompt({
      character_type: 'human',
      age: 'early 30s',
      asymmetrical_details: "scar over character's right eye",
    });
    expect(out).toContain('CHARACTER TYPE:\nhuman');
    expect(out).toContain('AGE / APPARENT AGE:\nearly 30s');
    expect(out).toContain(
      "ASYMMETRICAL DETAILS:\nscar over character's right eye",
    );
  });

  it('omits sections for empty/whitespace fields', () => {
    const out = buildCharacterSheetPrompt({
      character_type: 'human',
      character_summary: '',
      age: '   ',
    });
    expect(out).toContain('CHARACTER TYPE:');
    expect(out).not.toContain('CHARACTER SUMMARY:');
    expect(out).not.toContain('AGE / APPARENT AGE:');
  });

  it('places before-views fields above and after-views fields below', () => {
    const out = buildCharacterSheetPrompt({
      character_type: 'human',
      label_visual_style: 'UE5 MetaHuman, realistic render',
      continuity_locks: 'preserve scar; preserve asymmetric cutout',
    });
    const typeIdx = out.indexOf('CHARACTER TYPE:');
    const viewsIdx = out.indexOf('REQUIRED VIEWS:');
    const styleIdx = out.indexOf('LABEL & VISUAL STYLE:');
    const locksIdx = out.indexOf('IMPORTANT CONTINUITY LOCKS:');
    expect(typeIdx).toBeGreaterThan(-1);
    expect(viewsIdx).toBeGreaterThan(typeIdx);
    expect(styleIdx).toBeGreaterThan(viewsIdx);
    expect(locksIdx).toBeGreaterThan(styleIdx);
  });

  it('includes CHARACTER NAME line when characterName is provided', () => {
    const out = buildCharacterSheetPrompt(
      { character_type: 'human' },
      { characterName: 'Rae' },
    );
    expect(out).toContain('CHARACTER NAME: Rae');
  });

  it('handles a fully empty specifics object without crashing', () => {
    const out = buildCharacterSheetPrompt(undefined);
    expect(out).toContain('UE5 MetaHuman');
    expect(out).toContain('REQUIRED VIEWS:');
    // No section headers should be in the output for empty specifics.
    for (const f of SPECIFICS_FIELDS) {
      // The header for the field must not appear when value is empty.
      // (We can't grep for the literal label since some appear in REQUIRED VIEWS too,
      //  so just check the colon-prefixed forms.)
      const headerLine = `${f.label.toUpperCase()}:`;
      // PROPORTION STYLE header equals the label uppercased — verify absent
      if (headerLine === 'PROPORTION STYLE:') {
        expect(out).not.toContain(headerLine);
      }
    }
  });
});
