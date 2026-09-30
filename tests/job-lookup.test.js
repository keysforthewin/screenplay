import { describe, it, expect } from 'vitest';
import { latestJobForBeat } from '../src/web/jobLookup.js';

const ago = (ms) => new Date(Date.now() - ms);

describe('latestJobForBeat', () => {
  it('prefers the newest running job, then a recently finished one, else null', () => {
    const jobs = new Map([
      ['a', { job_id: 'a', beat_id: 'b1', status: 'done', started_at: ago(90_000), finished_at: ago(60_000) }],
      ['b', { job_id: 'b', beat_id: 'b1', status: 'running', started_at: ago(30_000), finished_at: null }],
      ['c', { job_id: 'c', beat_id: 'b2', status: 'error', started_at: ago(3_600_000), finished_at: ago(3_000_000) }],
      ['d', { job_id: 'd', beat_id: 'b3', status: 'done', started_at: ago(50_000), finished_at: ago(40_000), scene_id: 's' }],
    ]);
    expect(latestJobForBeat(jobs, 'b1').job_id).toBe('b');
    jobs.get('b').status = 'done';
    jobs.get('b').finished_at = ago(1_000);
    expect(latestJobForBeat(jobs, 'b1').job_id).toBe('b');
    expect(latestJobForBeat(jobs, 'b2')).toBeNull(); // finished too long ago
    expect(latestJobForBeat(jobs, 'b3', { filter: (j) => !j.scene_id })).toBeNull();
    expect(latestJobForBeat(jobs, 'nope')).toBeNull();
    expect(latestJobForBeat(jobs, '')).toBeNull();
  });
});
