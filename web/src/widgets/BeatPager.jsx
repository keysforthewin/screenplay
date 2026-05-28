import { Link } from 'react-router-dom';

export function beatNeighbors(beats, currentId) {
  if (!Array.isArray(beats) || beats.length === 0 || !currentId) {
    return { prev: null, next: null };
  }
  const target = String(currentId);
  const i = beats.findIndex((b) => String(b?._id) === target);
  if (i < 0) return { prev: null, next: null };
  return {
    prev: i > 0 ? beats[i - 1] : null,
    next: i < beats.length - 1 ? beats[i + 1] : null,
  };
}

function beatLabel(b) {
  const name = (b?.plain_name || '').trim();
  return name ? `Beat ${b.order} · ${name}` : `Beat ${b.order}`;
}

export function BeatPager({ beats, currentId, basePath }) {
  const { prev, next } = beatNeighbors(beats, currentId);
  if (!prev && !next) return null;

  return (
    <nav className="beat-pager" aria-label="Beat navigation">
      {prev && (
        <Link
          to={`${basePath}/${prev.order}`}
          className="beat-pager-link is-prev"
          title={beatLabel(prev)}
        >
          <span className="beat-pager-arrow" aria-hidden="true">←</span>
          <span className="beat-pager-label">{beatLabel(prev)}</span>
        </Link>
      )}
      {next && (
        <Link
          to={`${basePath}/${next.order}`}
          className="beat-pager-link is-next"
          title={beatLabel(next)}
        >
          <span className="beat-pager-label">{beatLabel(next)}</span>
          <span className="beat-pager-arrow" aria-hidden="true">→</span>
        </Link>
      )}
    </nav>
  );
}
