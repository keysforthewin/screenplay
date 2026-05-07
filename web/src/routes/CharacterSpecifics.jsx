import { SPECIFICS_FIELDS } from '../specifics.js';
import { SpecificsTab } from '../widgets/SpecificsTab.jsx';

export function CharacterSpecifics({ character, onRefresh }) {
  const cid = character._id;
  const safeName = (character.name || 'character')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 80);
  return (
    <SpecificsTab
      fields={SPECIFICS_FIELDS}
      imageId={character.character_sheet_image_id || null}
      autofillUrl={`/character/${cid}/specifics/autofill`}
      generateUrl={`/character/${cid}/character-sheet`}
      entityLabel="character"
      downloadFilename={`${safeName}-character-sheet.png`}
      imageAltText={`${character.name || 'character'} sheet`}
      emptyText={`No character sheet generated yet. Fill in the fields above and click "Generate character sheet".`}
      onRefresh={onRefresh}
    />
  );
}
