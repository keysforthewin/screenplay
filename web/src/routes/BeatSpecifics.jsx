import { BEAT_SPECIFICS_FIELDS } from '../beatSpecifics.js';
import { SpecificsTab } from '../widgets/SpecificsTab.jsx';

export function BeatSpecifics({ beat, onRefresh }) {
  const id = beat._id;
  const safeName = String(beat.name || `beat-${beat.order}`)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 80) || `beat-${beat.order}`;
  return (
    <SpecificsTab
      fields={BEAT_SPECIFICS_FIELDS}
      imageId={beat.scene_sheet_image_id || null}
      autofillUrl={`/beat/${id}/specifics/autofill`}
      generateUrl={`/beat/${id}/scene-sheet`}
      entityLabel="scene"
      downloadFilename={`${safeName}-scene-sheet.png`}
      imageAltText={`${beat.name || 'scene'} reference sheet`}
      emptyText={`No scene reference sheet generated yet. Fill in the fields above and click "Generate scene sheet".`}
      onRefresh={onRefresh}
    />
  );
}
