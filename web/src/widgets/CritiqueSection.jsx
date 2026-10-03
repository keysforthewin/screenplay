// One collapsible section of the Critique tab (Writing / Artwork). A native
// <details> so the open state survives re-renders without any wiring.
export function CritiqueSection({ title, meta, defaultOpen = true, children }) {
  return (
    <details className="critique-section" open={defaultOpen}>
      <summary>
        <span className="critique-section-title">{title}</span>
        {meta ? <span className="critique-section-meta">{meta}</span> : null}
      </summary>
      <div className="critique-section-body">{children}</div>
    </details>
  );
}
