// Pure duration estimation from covered dialogue (PenShot-style speech rate,
// recorded audio as ground truth, clamped to the shot_type cap).
import { describe, it, expect } from 'vitest';
import {
  estimateLineSeconds,
  estimateSpeechSeconds,
  allLinesRecorded,
  WORDS_PER_SECOND,
  BREATH_PER_LINE_SECONDS,
  SENTENCE_PAUSE_SECONDS,
} from '../src/web/shotTiming.js';

describe('estimateLineSeconds', () => {
  it('uses the recorded duration when present', () => {
    expect(estimateLineSeconds({ body: 'anything at all here', audio_duration_seconds: 4.2 })).toBe(4.2);
  });

  it('estimates from word count, punctuation and a breath', () => {
    // 5 words, one period → 5/2.5 + 0.35 + 0.5
    const s = estimateLineSeconds({ body: 'One two three four five.' });
    expect(s).toBeCloseTo(5 / WORDS_PER_SECOND + SENTENCE_PAUSE_SECONDS + BREATH_PER_LINE_SECONDS, 5);
  });

  it('slows emotional delivery cues by 20%', () => {
    const plain = estimateLineSeconds({ body: 'I never wanted this', direction: 'flat' });
    const slow = estimateLineSeconds({ body: 'I never wanted this', direction: 'whispered, choking back tears' });
    expect(slow).toBeGreaterThan(plain);
    expect(slow - BREATH_PER_LINE_SECONDS).toBeCloseTo((plain - BREATH_PER_LINE_SECONDS) * 1.2, 5);
  });

  it('returns 0 for an empty line', () => {
    expect(estimateLineSeconds({ body: '   ' })).toBe(0);
    expect(estimateLineSeconds(null)).toBe(0);
  });
});

describe('allLinesRecorded', () => {
  it('allLinesRecorded is false for an empty list or any unrecorded line', () => {
    expect(allLinesRecorded([])).toBe(false);
    expect(allLinesRecorded([{ audio_duration_seconds: 1 }, { audio_duration_seconds: null }])).toBe(false);
    expect(allLinesRecorded([{ audio_duration_seconds: 1 }])).toBe(true);
    expect(estimateSpeechSeconds(null)).toBe(0);
  });
});
