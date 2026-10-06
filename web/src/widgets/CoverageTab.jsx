import { ArtworkCritiqueSection } from './ArtworkCritiqueSection.jsx';

// The beat page's Coverage tab: the artwork critique on its own, beside the
// writing critique's Critique tab.
export function CoverageTab({ beatId }) {
  return (
    <div className="critique-panel">
      <p className="tab-intro">
        Does the artwork on file cover this beat? <b>Check coverage</b> reads the beat, lists the set views, props and character looks it needs
        and matches them against the sets' and characters' artwork libraries by description, then drafts the missing pieces for generation.
        <b> Check quality</b> looks at the matched pictures and scores each one; <b>Climb</b> renders and edits until a quality target is reached.
      </p>
      <ArtworkCritiqueSection beatId={beatId} />
    </div>
  );
}
