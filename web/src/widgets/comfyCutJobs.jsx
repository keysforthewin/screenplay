import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { apiPostJson, apiSseUrl } from '../api.js';

// ComfyUI cut renders as page-level state. A render is a background job on
// the server (one GPU, strictly first-in first-out); the Scenes page keeps
// one live snapshot per cut here so the cut's button can show "Queued #2" /
// "Rendering…" and reopening its dialog shows the live progress, however
// often the dialog is closed. ScenesPanel owns the store (useComfyCutJobStore),
// feeds it the reattach list from GET /cuts/jobs, and provides it to the cuts.

const TERMINAL = new Set(['done', 'error']);

export function isComfyJobActive(job) {
  return Boolean(job) && !TERMINAL.has(job.status);
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function useComfyCutJobStore(beatId, onRefresh) {
  const [jobs, setJobs] = useState({}); // cutId → snapshot
  const streams = useRef(new Map()); // cutId → { jobId, es }
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  const closeStream = useCallback((cutId) => {
    const s = streams.current.get(cutId);
    if (s) {
      s.es.close();
      streams.current.delete(cutId);
    }
  }, []);

  // Switching beats (or leaving the page) drops every watcher; the jobs keep
  // running on the server and are picked up again by the next reattach.
  useEffect(() => {
    const map = streams.current;
    return () => {
      for (const s of map.values()) s.es.close();
      map.clear();
      setJobs({});
    };
  }, [beatId]);

  const setSnap = useCallback((cutId, snap) => {
    if (!snap) return;
    setJobs((cur) => ({ ...cur, [cutId]: snap }));
  }, []);

  const track = useCallback(
    (cutId, jobId, initial = null) => {
      if (initial) setSnap(cutId, initial);
      else setJobs((cur) => ({ ...cur, [cutId]: { job_id: jobId, owner_id: cutId, status: 'queued', step: 'Queued', started_at: new Date().toISOString() } }));
      const existing = streams.current.get(cutId);
      if (existing?.jobId === jobId) return;
      closeStream(cutId);
      const es = new EventSource(apiSseUrl(`/cut/${cutId}/video-job/${jobId}/events`));
      streams.current.set(cutId, { jobId, es });
      const finish = () => {
        closeStream(cutId);
        refreshRef.current?.();
      };
      es.addEventListener('snapshot', (ev) => setSnap(cutId, safeParse(ev.data)));
      es.addEventListener('update', (ev) => setSnap(cutId, safeParse(ev.data)));
      es.addEventListener('done', (ev) => {
        setSnap(cutId, safeParse(ev.data));
        finish();
      });
      es.addEventListener('error', (ev) => {
        const snap = ev?.data ? safeParse(ev.data) : null;
        if (snap) setSnap(cutId, snap);
        else setJobs((cur) => {
          const j = cur[cutId];
          if (!j || TERMINAL.has(j.status)) return cur;
          return { ...cur, [cutId]: { ...j, status: 'error', error: j.error || 'Lost the connection to the render.' } };
        });
        finish();
      });
    },
    [closeStream, setSnap],
  );

  // Snapshots from GET /cuts/jobs: show them, and watch the ones still going.
  const hydrate = useCallback(
    (list) => {
      for (const snap of Array.isArray(list) ? list : []) {
        const cutId = snap?.owner_id;
        if (!cutId || !snap.job_id) continue;
        if (isComfyJobActive(snap)) track(cutId, snap.job_id, snap);
        else setJobs((cur) => (cur[cutId] ? cur : { ...cur, [cutId]: snap }));
      }
    },
    [track],
  );

  const cancel = useCallback(
    async (cutId) => {
      const job = jobs[cutId];
      if (!job?.job_id) return;
      const r = await apiPostJson(`/cut/${cutId}/video/job/${job.job_id}/cancel`, {});
      if (r?.job) setSnap(cutId, r.job);
      closeStream(cutId);
    },
    [jobs, setSnap, closeStream],
  );

  const dismiss = useCallback((cutId) => {
    setJobs((cur) => {
      if (!cur[cutId] || isComfyJobActive(cur[cutId])) return cur;
      const next = { ...cur };
      delete next[cutId];
      return next;
    });
  }, []);

  return useMemo(() => ({ jobs, track, hydrate, cancel, dismiss }), [jobs, track, hydrate, cancel, dismiss]);
}

const ComfyCutJobsContext = createContext(null);

export function ComfyCutJobsProvider({ store, children }) {
  return <ComfyCutJobsContext.Provider value={store}>{children}</ComfyCutJobsContext.Provider>;
}

export function useComfyCutJobs() {
  return useContext(ComfyCutJobsContext);
}

export function comfyQueueSummary(jobs) {
  let running = 0;
  let queued = 0;
  for (const j of Object.values(jobs || {})) {
    if (j.status === 'queued') queued += 1;
    else if (isComfyJobActive(j)) running += 1;
  }
  return { running, queued };
}
