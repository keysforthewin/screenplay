// The coverage check, picture by picture: a strip of thumbnails of every
// artwork on the beat's sets and characters, each marked as its description
// is matched against the beat's requirements — ✓ relevant, ✕ not — with a
// progress meter. Data: the artwork-critique job snapshot (`images`,
// `images_done`, `images_total`), which arrives over the job's SSE stream.

import { useEffect, useRef } from 'react';
import { thumbUrl } from '../api.js';

const MARK = {
  relevant: { text: '✓', title: 'Relevant — answers something this beat needs' },
  irrelevant: { text: '✕', title: 'Not relevant to this beat' },
  skipped: { text: '–', title: 'Not checked — this beat asks nothing of its set or character' },
  error: { text: '!', title: 'The check failed for this picture' },
};

export default function CoverageCarousel({ job, running }) {
  const stripRef = useRef(null);
  const images = job?.images || [];
  const total = job?.images_total ?? images.length;
  const done = job?.images_done ?? 0;
  const firstChecking = images.findIndex((i) => i.status === 'checking');

  // Keep the pictures being checked in view.
  useEffect(() => {
    if (firstChecking < 0) return;
    const el = stripRef.current?.children?.[firstChecking];
    if (el && stripRef.current) stripRef.current.scrollTo({ left: Math.max(0, el.offsetLeft - 60), behavior: 'smooth' });
  }, [firstChecking]);

  if (!total) return null;
  const pct = Math.round((done / total) * 100);
  const relevant = images.filter((i) => i.status === 'relevant').length;
  const current = images.filter((i) => i.status === 'checking');
  const waiting = running && job?.phase === 'requirements';
  const status = job?.status === 'cancelled' && done < total ? `Cancelled — ${relevant} relevant so far`
    : waiting ? 'Reading the beat for what it needs — the pictures are checked next'
    : current.length ? `Checking ${current.length === 1 ? `“${current[0].name || 'untitled'}”` : `${current.length} pictures`} — ${current[0].subject_name}`
      : done >= total ? `${relevant} relevant, ${total - relevant} not`
        : job?.status === 'cancelled' ? 'Cancelled'
          : running ? 'Checking…' : 'Stopped';

  return (
    <div className="coverage-carousel" aria-live="polite">
      <div className="coverage-carousel-head">
        <span className="coverage-carousel-count">{done} / {total} images · {pct}%</span>
        <div className="coverage-carousel-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <div className="coverage-carousel-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="coverage-carousel-status">{status}</span>
      </div>
      <div className="coverage-carousel-strip" ref={stripRef}>
        {images.map((i) => {
          const mark = MARK[i.status];
          return (
            <div key={i.artwork_id} className={`coverage-thumb is-${i.status}`} title={`${i.subject_name} — ${i.name || 'untitled'}${mark ? `\n${mark.title}` : i.status === 'checking' ? '\nBeing checked now' : '\nWaiting'}`}>
              <img src={thumbUrl(i.image_id)} alt={i.name || 'artwork'} loading="lazy" />
              {mark ? <span className="coverage-thumb-mark">{mark.text}</span> : null}
              {i.status === 'checking' ? <span className="coverage-thumb-spin" /> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
