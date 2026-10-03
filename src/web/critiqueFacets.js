// Beat-critique facet registry — the single source of truth for what facets
// exist and how each is prompted. Each facet runs one structured-output
// Anthropic call (see critiqueGenerate.js) that scores 3-4 named CRITERIA
// against written anchors (what a 3, a 6 and a 9 look like), quotes the lines
// it judges, and ranks issues by severity. The facet score is derived in code
// from the criteria (src/web/critiqueScoring.js), never asked for directly.
//
// scope: 'focused' = judge THIS beat (with prev/next as immediate context);
//        'story'   = judge how this beat fits the whole screenplay.
// required: always-run facets the user mandated (format + director's notes);
//           they weigh 1.5 in the overall, every other facet 1.
// optional criteria: reported as applicable=false when their context is absent.

import { stripMarkdown } from '../util/markdown.js';
import { formatCharacterFull, formatSetFull } from './beatContext.js';
import { SCORING_RULES } from './critiqueScoring.js';

function txt(s) {
  return stripMarkdown(String(s || '')).trim();
}

function clip(s, max) {
  const v = txt(s);
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

const NEIGHBOUR_CAP = 2500;
const DIALOGUE_STYLE_CAP = 3000;
const VOICE_CAP = 2000;

function beatBlock(beat) {
  return [
    `Beat #${beat?.order ?? '?'}: ${txt(beat?.name) || 'Untitled'}`,
    '',
    'Description:',
    txt(beat?.desc) || '(none)',
    '',
    'Body:',
    txt(beat?.body) || '(none)',
  ].join('\n');
}

function neighborBlock(label, beat) {
  if (!beat) return `${label}: (none — this is an end beat)`;
  return [`${label} — Beat #${beat.order}: ${txt(beat.name) || 'Untitled'}`, clip(beat.body, NEIGHBOUR_CAP) || '(no body)'].join('\n');
}

function spineText(spine) {
  const lines = (spine || [])
    .map((b) => `${b.order}. ${txt(b.name) || 'Untitled'} — ${txt(b.desc) || '(no description)'}`);
  return lines.length ? lines.join('\n') : '(no beats)';
}

function notesText(notes) {
  const items = (notes || []).map((n) => txt(n?.text)).filter(Boolean);
  return items.length ? items.map((t) => `- ${t}`).join('\n') : "(no director's notes recorded)";
}

function charactersText(characters) {
  const items = (characters || [])
    .map((c) => {
      const name = txt(c?.name);
      if (!name) return null;
      const actor = txt(c?.hollywood_actor);
      const role = txt(c?.fields?.role);
      const suffix = actor ? ` — played by ${actor}` : role ? ` — ${role}` : '';
      return `- ${name}${suffix}`;
    })
    .filter(Boolean);
  return items.length ? items.join('\n') : '(no named characters in this beat)';
}

function charactersFullText(characters) {
  const items = (characters || []).filter((c) => txt(c?.name)).map(formatCharacterFull);
  return items.length ? items.join('\n') : '(no named characters in this beat)';
}

function setsText(sets) {
  const items = (sets || []).filter((s) => txt(s?.name)).map(formatSetFull);
  return items.length ? items.join('\n') : '(no sets linked to this beat)';
}

function optionalBlock(title, text, absent) {
  return [`# ${title}`, txt(text) || absent];
}

const ABSENT = '(none — report the matching criterion as not applicable)';

export const FACETS = [
  {
    key: 'format',
    label: 'Screenplay format',
    scope: 'focused',
    required: true,
    weight: 1.5,
    focus: 'You are a screenplay format editor. Judge ONLY how well the beat body conforms to standard screenplay style — never its content quality. The style guide in the context is the standard to measure against.',
    criteria: [
      {
        key: 'sluglines',
        label: 'Sluglines',
        anchors: {
          3: 'No INT./EXT. headings, or headings written as prose.',
          6: 'Headings exist but a location or time change goes unmarked, or the form drifts (missing time, lowercase, wrong dash).',
          9: 'Every literal location/time change has a correct INT./EXT. LOCATION — TIME heading and nothing else does.',
        },
      },
      {
        key: 'action_lines',
        label: 'Action lines',
        anchors: {
          3: 'Past tense, novel paragraphs, interior narration.',
          6: 'Present tense, but paragraphs run over four lines or carry asides the camera cannot see.',
          9: 'Present tense, one image per short paragraph, camera cues only where essential.',
        },
      },
      {
        key: 'geography',
        label: 'Spatial geography & mini-slugs',
        anchors: {
          3: 'A reader cannot say where characters or key props are in the set; moves within the scene are unmarked.',
          6: 'Positions are established on entry (blocking) but at least one move or prop placement a downstream image generator would have to guess — "in the minivan" when the beat means the back seat.',
          9: 'Every character and key prop is placed on entry and every move within the scene is pinned by a blocking line or a mini-slug (BACK SEAT, AT THE WINDOW).',
        },
      },
      {
        key: 'dialogue_format',
        label: 'Dialogue formatting',
        anchors: {
          3: 'Lines inline in prose or in quotation marks.',
          6: 'CAPS cues present but parentheticals on most lines, inconsistent cue names, or V.O./O.S. missing where needed.',
          9: 'CAPS cue, sparing parentheticals, consistent names, V.O./O.S./CONT\'D exactly where needed.',
        },
      },
    ],
    buildContext: (ctx) =>
      [
        '# Screenplay format guide (the standard to measure against)',
        ctx.styleGuide,
        '',
        '# Sets linked to this beat (check geography against them)',
        setsText(ctx.sets),
        '',
        '# The beat to evaluate',
        beatBlock(ctx.beat),
      ].join('\n'),
  },
  {
    key: 'direction',
    label: "Director's notes",
    scope: 'focused',
    required: true,
    weight: 1.5,
    focus: "You check whether the project's steering documents — the director's notes, any beat-level direction, the directorial voice and the beat's scene bible — are visible as concrete choices in this text. Cite which notes are met and which are missing or contradicted.",
    criteria: [
      {
        key: 'notes_honored',
        label: 'Project notes honored',
        anchors: {
          3: 'A director\'s note is contradicted.',
          6: 'Notes are acknowledged by a word or a gesture, not by a choice that shapes the beat.',
          9: 'Every applicable note shows up as a concrete choice in the text; you can name each note and where it lands.',
        },
      },
      {
        key: 'beat_direction',
        label: 'Beat-level direction',
        optional: true,
        anchors: {
          3: 'The beat-level direction is ignored or contradicted.',
          6: 'Partly reflected.',
          9: 'Fully executed.',
        },
      },
      {
        key: 'directorial_voice',
        label: 'Directorial voice',
        optional: true,
        anchors: {
          3: 'The beat reads in another register from the project\'s directorial voice.',
          6: 'The voice shows in places.',
          9: 'Blocking, pace and performance choices on the page read as this director\'s hand.',
        },
      },
      {
        key: 'scene_bible',
        label: 'Scene bible fidelity',
        optional: true,
        anchors: {
          3: 'Location, time, blocking or continuity anchors in the bible are contradicted.',
          6: 'Honored but not used — the bible\'s intention and turn are not what the text plays.',
          9: 'The bible\'s intention and turn are exactly what the text plays.',
        },
      },
    ],
    buildContext: (ctx) =>
      [
        "# Director's notes (project-wide guidance)",
        notesText(ctx.directorNotes),
        '',
        ...optionalBlock('Beat-level direction (dialog_notes)', ctx.beat?.dialog_notes, ABSENT),
        '',
        ...optionalBlock('Directorial voice (project-wide)', clip(ctx.directorialVoice, VOICE_CAP), ABSENT),
        '',
        ...optionalBlock('Scene bible for this beat', ctx.sceneBible, ABSENT),
        '',
        '# The beat to evaluate',
        beatBlock(ctx.beat),
      ].join('\n'),
  },
  {
    key: 'pacing',
    label: 'Pacing & momentum',
    scope: 'focused',
    required: false,
    weight: 1,
    focus: 'You are a script editor judging pacing and momentum within this beat and across its neighbours. Use the previous and next beats only to judge whether this beat enters and exits at the right tempo, and the spine to judge whether its length matches its weight.',
    criteria: [
      {
        key: 'entry',
        label: 'Entry',
        anchors: {
          3: 'Opens on arrival, greeting, settling in.',
          6: 'A few lines of throat-clearing before anything is at stake.',
          9: 'The first line is already in motion and matches the previous beat\'s exit tempo.',
        },
      },
      {
        key: 'escalation',
        label: 'Escalation',
        anchors: {
          3: 'Flat — the same pressure from first line to last, or one jump with no build.',
          6: 'Rises, but with a slack middle or a moment played twice.',
          9: 'Each unit raises the stakes or turns; nothing is said twice.',
        },
      },
      {
        key: 'exit',
        label: 'Exit',
        anchors: {
          3: 'Lingers past the turn, wraps up, explains.',
          6: 'Ends on the right moment plus a trailing line.',
          9: 'Cuts on the turn or the button and hands off cleanly to the next beat.',
        },
      },
      {
        key: 'proportion',
        label: 'Length vs. weight',
        anchors: {
          3: 'Length wildly out of proportion to the beat\'s importance in the spine.',
          6: 'Somewhat long or short for what it carries.',
          9: 'Length matches dramatic weight.',
        },
      },
    ],
    buildContext: (ctx) =>
      [
        '# Full beat spine (for proportion)',
        spineText(ctx.spine),
        '',
        neighborBlock('PREVIOUS beat', ctx.prevBeat),
        '',
        '# The beat to evaluate',
        beatBlock(ctx.beat),
        '',
        neighborBlock('NEXT beat', ctx.nextBeat),
      ].join('\n'),
  },
  {
    key: 'voice',
    label: 'Character voice',
    scope: 'focused',
    required: false,
    weight: 1,
    focus: 'You judge whether the characters in this beat are consistent with their profiles and distinct from one another in how they act and speak. Name any character whose voice slips.',
    criteria: [
      {
        key: 'distinctness',
        label: 'Distinct voices',
        anchors: {
          3: 'Swap the character cues and nothing changes.',
          6: 'Distinct in attitude but not in diction or rhythm.',
          9: 'Each character is identifiable from the line alone.',
        },
      },
      {
        key: 'consistency',
        label: 'Consistency with the profile',
        anchors: {
          3: 'Contradicts the character\'s profile, role or want.',
          6: 'Mostly consistent, with one slip.',
          9: 'Every line and action is this person; the actor likeness informs the register.',
        },
      },
      {
        key: 'behaviour',
        label: 'Behaviour in action lines',
        anchors: {
          3: 'Characters move as plot puppets.',
          6: 'Plausible but generic physical choices.',
          9: 'Physical choices reveal character.',
        },
      },
    ],
    buildContext: (ctx) =>
      [
        '# Characters present in this beat (full profiles)',
        charactersFullText(ctx.characters),
        '',
        '# The beat to evaluate',
        beatBlock(ctx.beat),
      ].join('\n'),
  },
  {
    key: 'cinematic',
    label: 'Cinematic craft',
    scope: 'focused',
    required: false,
    weight: 1,
    focus: 'You judge show-don\'t-tell: is this beat written as photographable action a camera can capture, in particular images a production designer could build, or as interior prose it cannot? Point to the most un-filmable lines and how to externalize them.',
    criteria: [
      {
        key: 'filmability',
        label: 'Photographable action',
        anchors: {
          3: 'Thoughts, feelings and backstory stated outright.',
          6: 'Mostly visual with a few "she feels" / "he remembers".',
          9: 'Every line is something a camera or a microphone records.',
        },
      },
      {
        key: 'image_specificity',
        label: 'Specific images',
        anchors: {
          3: 'Generic images ("the room is messy").',
          6: 'Some concrete detail.',
          9: 'Particular, telling details a production designer could build, consistent with the set descriptions.',
        },
      },
      {
        key: 'show_dont_tell',
        label: 'Visual storytelling',
        anchors: {
          3: 'Key information delivered by dialogue or narration that could be shown.',
          6: 'A mix — some turns land in image, others are explained in a line.',
          9: 'The turn lands in image or behaviour; dialogue carries only what image cannot.',
        },
      },
    ],
    buildContext: (ctx) =>
      [
        '# Screenplay craft reference',
        ctx.styleGuide,
        '',
        '# Sets linked to this beat',
        setsText(ctx.sets),
        '',
        ...optionalBlock('Directorial voice (project-wide)', clip(ctx.directorialVoice, VOICE_CAP), '(none)'),
        '',
        '# The beat to evaluate',
        beatBlock(ctx.beat),
      ].join('\n'),
  },
  {
    key: 'dialogue',
    label: 'Dialogue & subtext',
    scope: 'focused',
    required: false,
    weight: 1,
    focus: 'You are a dialogue editor judging the lines in this beat. Flag the weakest lines and what subtext they should be playing.',
    criteria: [
      {
        key: 'subtext',
        label: 'Subtext',
        anchors: {
          3: 'Characters say exactly what they mean and feel.',
          6: 'Some lines are indirect.',
          9: 'Wants are pursued obliquely; the audience infers.',
        },
      },
      {
        key: 'exposition',
        label: 'Exposition handling',
        anchors: {
          3: '"As you know" information dumps.',
          6: 'Exposition present but partly dramatized.',
          9: 'Needed information arrives under conflict, or not at all.',
        },
      },
      {
        key: 'style_match',
        label: 'Project dialogue style',
        optional: true,
        anchors: {
          3: 'Ignores the project\'s dialogue style and samples.',
          6: 'In the neighbourhood.',
          9: 'Rhythm and diction match the style.',
        },
      },
      {
        key: 'economy',
        label: 'Line economy',
        anchors: {
          3: 'Speeches, restatement, filler (names, "look", "well").',
          6: 'Some trimmable lines.',
          9: 'Every line pulls weight; any cut would hurt.',
        },
      },
    ],
    buildContext: (ctx) =>
      [
        ...optionalBlock('Project dialogue style', clip(ctx.plot?.dialogue_style, DIALOGUE_STYLE_CAP), ABSENT),
        '',
        '# Beat-level direction (dialog_notes)',
        txt(ctx.beat?.dialog_notes) || '(none)',
        '',
        '# Characters present in this beat',
        charactersText(ctx.characters),
        '',
        '# The beat to evaluate',
        beatBlock(ctx.beat),
      ].join('\n'),
  },
  {
    key: 'story_fit',
    label: 'Story fit',
    scope: 'story',
    required: false,
    weight: 1,
    focus: 'You judge how this single beat fits into the whole screenplay: does it earn its place in the arc, avoid redundancy, maintain continuity with the surrounding story, and deliver what its description promises? Say whether to keep, move, merge, or cut, and why.',
    criteria: [
      {
        key: 'necessity',
        label: 'Necessity',
        anchors: {
          3: 'Cut it and nothing downstream changes.',
          6: 'Contributes, but overlaps another beat.',
          9: 'Something changes here that later beats depend on.',
        },
      },
      {
        key: 'placement',
        label: 'Placement',
        anchors: {
          3: 'Out of order — knowledge or consequence before cause.',
          6: 'Works here but would be stronger elsewhere.',
          9: 'The only place it can go.',
        },
      },
      {
        key: 'continuity',
        label: 'Continuity',
        anchors: {
          3: 'Contradicts the synopsis, the spine or the neighbours (facts, knowledge, geography).',
          6: 'A minor inconsistency.',
          9: 'Consistent with everything around it.',
        },
      },
      {
        key: 'description_match',
        label: 'Matches its description',
        anchors: {
          3: 'The body does something other than the beat\'s description.',
          6: 'Covers it, with drift.',
          9: 'Delivers what the description promises and no more.',
        },
      },
    ],
    buildContext: (ctx) =>
      [
        '# Story synopsis',
        txt(ctx.plot?.synopsis) || '(no synopsis)',
        '',
        '# Full beat spine (the whole screenplay in order)',
        spineText(ctx.spine),
        '',
        neighborBlock('PREVIOUS beat', ctx.prevBeat),
        '',
        `# The beat to evaluate — currently at position #${ctx.beat?.order ?? '?'}`,
        beatBlock(ctx.beat),
        '',
        neighborBlock('NEXT beat', ctx.nextBeat),
      ].join('\n'),
  },
];

export function criteriaKeys(facet) {
  return (facet?.criteria || []).map((c) => c.key);
}

// The system prompt for one facet: the shared scoring rules, the facet's own
// focus, its criteria with anchors, and the output instruction.
export function buildFacetSystemPrompt(facet) {
  const table = (facet.criteria || []).map((c) =>
    [
      `### ${c.label} [${c.key}]${c.optional ? ' (optional — not applicable when its context is absent)' : ''}`,
      `3 = ${c.anchors[3]}`,
      `6 = ${c.anchors[6]}`,
      `9 = ${c.anchors[9]}`,
    ].join('\n'),
  );
  return [
    facet.focus,
    '',
    SCORING_RULES,
    '',
    `# Criteria for "${facet.label}"`,
    ...table,
    '',
    'Return only the JSON object the schema describes: one entry per criterion (quote the beat verbatim in every evidence.quote), the ranked issues (each quoting the beat), the strengths, and a short summary a screenwriter can act on.',
  ].join('\n');
}

for (const f of FACETS) f.systemPrompt = buildFacetSystemPrompt(f);

export function getFacet(key) {
  return FACETS.find((f) => f.key === key);
}

export function facetStubs() {
  return FACETS.map((f) => ({
    key: f.key,
    label: f.label,
    scope: f.scope,
    score: null,
    comments: '',
    summary: '',
    strengths: [],
    criteria: [],
    issues: [],
    status: 'pending',
    error_message: null,
  }));
}
