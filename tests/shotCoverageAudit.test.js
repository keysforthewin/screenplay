// Deterministic dialogue-coverage audit: every line to exactly one shot, in
// order, on a shot that frames the speaker, within the duration cap.
import { describe, it, expect } from 'vitest';
import { ObjectId } from 'mongodb';
import { auditShotCoverage } from '../src/web/shotCoverageAudit.js';

const L = (n, character, body, extra = {}) => ({ _id: new ObjectId(), order: n, character, body, ...extra });
const S = (order, extra = {}) => ({ _id: new ObjectId(), order, text_prompt: 'p', shot_type: 'medium', characters_in_scene: [], dialog_ids: [], ...extra });

function codes(report) {
  return report.checks.map((c) => c.code);
}

describe('auditShotCoverage', () => {
  it('passes a clean plan with no checks', () => {
    const a = L(1, 'Sarah', 'Hi.', { audio_file_id: new ObjectId(), audio_duration_seconds: 1 });
    const b = L(2, 'Tom', 'Hey.', { audio_file_id: new ObjectId(), audio_duration_seconds: 1 });
    const shots = [
      S(1),
      S(2, { characters_in_scene: ['Sarah'], dialog_ids: [a._id] }),
      S(3, { characters_in_scene: ['Tom'], dialog_ids: [b._id] }),
    ];
    const r = auditShotCoverage({ shots, dialogs: [a, b] });
    expect(r.checks).toEqual([]);
    expect(r.counts).toEqual({ warnings: 0, infos: 0 });
  });

  it('flags unassigned and double-assigned lines', () => {
    const a = L(1, 'Sarah', 'Hi.');
    const b = L(2, 'Tom', 'Hey.');
    const shots = [S(1, { characters_in_scene: ['Sarah'], dialog_ids: [a._id] }), S(2, { characters_in_scene: ['Sarah'], dialog_ids: [a._id] })];
    const r = auditShotCoverage({ shots, dialogs: [a, b] });
    expect(codes(r)).toContain('dialog_double_assigned');
    expect(codes(r)).toContain('dialog_unassigned');
    expect(r.checks.find((c) => c.code === 'dialog_unassigned').subject).toBe(String(b._id));
  });

  it('flags out-of-order coverage', () => {
    const a = L(1, 'Sarah', 'Hi.');
    const b = L(2, 'Tom', 'Hey.');
    const shots = [S(1, { characters_in_scene: ['Tom'], dialog_ids: [b._id] }), S(2, { characters_in_scene: ['Sarah'], dialog_ids: [a._id] })];
    expect(codes(auditShotCoverage({ shots, dialogs: [a, b] }))).toContain('dialog_out_of_order');
  });

  it('flags a speaker missing from the covering shot, and a missing recording as info', () => {
    const a = L(1, 'Sarah', 'Hi.');
    const shots = [S(1, { characters_in_scene: ['Tom'], dialog_ids: [a._id] })];
    const r = auditShotCoverage({ shots, dialogs: [a] });
    expect(codes(r)).toContain('speaker_not_in_shot');
    const info = r.checks.find((c) => c.code === 'dialog_audio_missing');
    expect(info.severity).toBe('info');
    expect(r.counts.infos).toBe(1);
  });

  it('flags speech over the shot_type cap and a missing prompt', () => {
    const a = L(1, 'Sarah', 'word '.repeat(60).trim());
    const shots = [S(1, { shot_type: 'close_up', text_prompt: '', characters_in_scene: ['Sarah'], dialog_ids: [a._id] })];
    const r = auditShotCoverage({ shots, dialogs: [a] });
    expect(codes(r)).toContain('dialog_over_cap');
    expect(codes(r)).toContain('prompt_missing');
  });

  it('ignores ids that are not in the dialogs list', () => {
    const shots = [S(1, { dialog_ids: [new ObjectId()] })];
    expect(auditShotCoverage({ shots, dialogs: [] }).checks).toEqual([]);
  });
});
