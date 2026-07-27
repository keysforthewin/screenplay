// The beat's dialogue reaches the storyboard planner as TURN ORDER and
// DELIVERY context — never as words to put in a prompt. Also guards the
// opt-in-ness of the parameter: buildBeatContextBlock is shared with the
// beat-sheet planner, which must not start seeing dialogue.
import { describe, it, expect } from 'vitest';
import {
  formatDialogLines,
  buildBeatContextBlock,
  buildScenePlanUserText,
} from '../src/web/storyboardGenerate.js';

const BEAT = { order: 3, name: 'The Argument', desc: 'They fight.', body: 'INT. KITCHEN — NIGHT', characters: [] };

const DIALOGS = [
  { order: 1, character: 'Sarah', body: "You said you'd be here.", direction: 'quiet, not accusing' },
  { order: 2, character: 'Tom', body: 'I was working.', direction: 'defensive, already turning away' },
];

describe('formatDialogLines', () => {
  it('returns null for an empty or missing list', () => {
    expect(formatDialogLines([])).toBeNull();
    expect(formatDialogLines(undefined)).toBeNull();
  });

  it('numbers the lines and surfaces speaker, words and direction', () => {
    const out = formatDialogLines(DIALOGS);
    expect(out).toContain('1. Sarah:');
    expect(out).toContain("You said you'd be here.");
    expect(out).toContain('direction: quiet, not accusing');
    expect(out).toContain('2. Tom:');
  });

  it('skips lines with no speaker and no body', () => {
    const out = formatDialogLines([...DIALOGS, { order: 3, character: '', body: '', direction: '' }]);
    expect(out.split('\n').filter((l) => /^\s*\d+\./.test(l))).toHaveLength(2);
  });

  it('strips markdown out of the speaker name', () => {
    expect(formatDialogLines([{ order: 1, character: '**Sarah**', body: 'Hi.', direction: '' }])).toContain('1. Sarah:');
  });
});

describe('buildBeatContextBlock dialogue block', () => {
  it('omits the dialogue block entirely when no dialogs are passed (beat-sheet planner path)', () => {
    const out = buildBeatContextBlock({ beat: BEAT, characters: [], direction: '', directorNotes: [] });
    expect(out).not.toContain('Dialogue in this beat');
  });

  it('includes the dialogue block with the no-words warning when dialogs are passed', () => {
    const out = buildBeatContextBlock({ beat: BEAT, characters: [], direction: '', directorNotes: [], dialogs: DIALOGS });
    expect(out).toContain('Dialogue in this beat');
    expect(out).toContain('TURN ORDER');
    expect(out).toContain('NEVER write these words');
    expect(out).toContain('1. Sarah:');
  });
});

describe('buildScenePlanUserText', () => {
  it('forwards dialogs into the Pass 1 user message', () => {
    const out = buildScenePlanUserText({
      beat: BEAT, characters: [], targetCount: 5, direction: '', directorNotes: [], dialogs: DIALOGS,
    });
    expect(out).toContain('Dialogue in this beat');
    expect(out).toContain('2. Tom:');
  });
});
