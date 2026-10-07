import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { apiGet } from '../api.js';

// Frame renders as page-level state. A render is a background job on the
// server; the Scenes page keeps one snapshot per frame here (key
// `<cutId>:<start|end|kf:<id>>`) so the frame's panel shows "Rendering…" however the
// page is re-rendered, and a reopened page picks running jobs up again from
// GET /cuts/jobs. ScenesPanel owns the store (useCutFrameJobStore).

const POLL_MS = 1500;
const TERMINAL = new Set(['done', 'error']);

export const frameJobKey = (cutId, frame) => `${cutId}:${frame}`;

export function useCutFrameJobStore(beatId, onRefresh) {
  const [jobs, setJobs] = useState({}); // key → snapshot
  const timers = useRef(new Map()); // key → interval id
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  const stop = useCallback((key) => {
    const t = timers.current.get(key);
    if (t) clearInterval(t);
    timers.current.delete(key);
  }, []);

  // Switching beats (or leaving the page) drops every watcher; the jobs keep
  // running on the server.
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearInterval(t);
      map.clear();
      setJobs({});
    };
  }, [beatId]);

  const track = useCallback(
    (snap) => {
      if (!snap?.job_id || !snap.cut_id) return;
      const key = frameJobKey(snap.cut_id, snap.frame);
      setJobs((cur) => ({ ...cur, [key]: snap }));
      stop(key);
      if (TERMINAL.has(snap.status)) return;
      const timer = setInterval(async () => {
        let next;
        try {
          next = await apiGet(`/cuts/frames/job/${snap.job_id}`);
        } catch {
          next = { ...snap, status: 'error', error: 'Lost track of the render.' };
        }
        setJobs((cur) => ({ ...cur, [key]: next }));
        if (TERMINAL.has(next.status)) {
          stop(key);
          refreshRef.current?.();
        }
      }, POLL_MS);
      timers.current.set(key, timer);
    },
    [stop],
  );

  const hydrate = useCallback((list) => {
    for (const snap of Array.isArray(list) ? list : []) track(snap);
  }, [track]);

  const dismiss = useCallback((key) => {
    setJobs((cur) => {
      if (!cur[key] || !TERMINAL.has(cur[key].status)) return cur;
      const next = { ...cur };
      delete next[key];
      return next;
    });
  }, []);

  return useMemo(() => ({ jobs, track, hydrate, dismiss }), [jobs, track, hydrate, dismiss]);
}

const CutFrameJobsContext = createContext(null);

export function CutFrameJobsProvider({ store, children }) {
  return <CutFrameJobsContext.Provider value={store}>{children}</CutFrameJobsContext.Provider>;
}

export function useCutFrameJobs() {
  return useContext(CutFrameJobsContext);
}

export function isFrameJobActive(job) {
  return Boolean(job) && !TERMINAL.has(job.status);
}
