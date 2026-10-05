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

import { stripMarkdown, stripMarkdownLines } from '../util/markdown.js';
import { formatCharacterFull, formatSetFull } from './beatContext.js';
import { SCORING_RULES } from './critiqueScoring.js';

function txt(s) {
  return stripMarkdown(String(s || '')).trim();
}

// The formatters below are also what the rewrite passes (beatRewrite.js) use
// to show a writer the documents the critics score against.
export const plainText = txt;

function clip(s, max) {
  const v = txt(s);
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

// A beat body as the critics read it: markdown marks stripped, LINES KEPT.
// txt() flattens every newline to a space, which is right for a one-line
// field and wrong for a page — a critic shown the body as one run of text
// cannot see whether a slugline or a character cue has its own line, and
// marks a correctly laid-out beat down for it.
function pageText(s, max = Infinity) {
  const v = stripMarkdownLines(s);
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
    'Body (line breaks exactly as on the page):',
    pageText(beat?.body) || '(none)',
  ].join('\n');
}

export function neighborBlock(label, beat) {
  if (!beat) return `${label}: (none — this is an end beat)`;
  return [`${label} — Beat #${beat.order}: ${txt(beat.name) || 'Untitled'}`, pageText(beat.body, NEIGHBOUR_CAP) || '(no body)'].join('\n');
}

export function spineText(spine) {
  const lines = (spine || [])
    .map((b) => `${b.order}. ${txt(b.name) || 'Untitled'} — ${txt(b.desc) || '(no description)'}`);
  return lines.length ? lines.join('\n') : '(no beats)';
}

export function notesText(notes) {
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

// Profiles as the text critics and the rewrite passes read them: the wardrobe
// is the character's usual outfit, not a lock (formatCharacterFull).
export function charactersFullText(characters, beat = null) {
  const items = (characters || []).filter((c) => txt(c?.name)).map((c) => formatCharacterFull(c, { beat, wardrobe: 'default' }));
  return items.length ? items.join('\n') : '(no named characters in this beat)';
}

export function setsText(sets) {
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
    focus: 'You are a screenplay format editor. Judge LAYOUT ONLY: is what is on the page set out in standard screenplay form, per the style guide in the context. The body is shown with its line breaks exactly as on the page. You do not judge what is said or shown, how a scene is staged, where the story is set, how much camera direction there is, or whether a line is good — other critics own all of that, and a beat can be badly written and perfectly formatted. A beat reformatted by a competent typist should score 9 or 10 here.',
    criteria: [
      {
        key: 'sluglines',
        label: 'Sluglines & mini-slugs',
        optional: true,
        anchors: {
          3: 'A literal scene with no INT./EXT. heading, or headings written as prose.',
          6: 'Headings exist but one is malformed (missing time, lowercase, wrong dash) or a change of place or time has no heading.',
          9: 'Every scene opens with INT./EXT. LOCATION — TIME on its own line; a move within a scene is an ALL-CAPS mini-slug on its own line; nothing else is dressed as a heading. Report not applicable for a beat that is not a literal scene (a title crawl, a card, a montage of vistas).',
        },
      },
      {
        key: 'action_lines',
        label: 'Action line form',
        anchors: {
          3: 'Past tense, or novel-style paragraphs running on for many lines.',
          6: 'Present tense, but a paragraph runs past four lines, or paragraphs are not separated by a blank line.',
          9: 'Present tense, third person, short paragraphs of four lines or fewer with a blank line between them.',
        },
      },
      {
        key: 'dialogue_format',
        label: 'Dialogue layout',
        optional: true,
        anchors: {
          3: 'Speech inline in prose or in quotation marks.',
          6: 'CAPS cues present but a cue shares a line with its speech, a parenthetical is buried mid-line, cue names vary, or V.O./O.S. is missing where the speaker is off screen.',
          9: 'CAPS cue on its own line, any parenthetical on its own line beneath it, then the speech; consistent cue names; V.O./O.S./CONT\'D where they apply. Report not applicable when nobody speaks.',
        },
      },
      {
        key: 'screen_text',
        label: 'On-screen text & transitions',
        optional: true,
        anchors: {
          3: 'Titles, supers or crawl text run into the action so a reader cannot tell what is printed on screen from what is described.',
          6: 'Set apart, but inconsistently labelled or mixed into an action paragraph.',
          9: 'Every title, super, card and crawl is set off on its own lines and labelled (SUPER:, TITLE:, CRAWL:, or a quoted block); transitions (CUT TO:, FADE OUT.) sit on their own line. Report not applicable when the beat has none.',
        },
      },
    ],
    buildContext: (ctx) =>
      [
        '# Screenplay format guide (the standard to measure against)',
        ctx.styleGuide,
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
    focus: "You check whether the project's steering documents — the director's notes, any beat-level direction and the directorial voice — are visible as concrete choices in this text. Cite which notes are met and which are missing or contradicted.",
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
    focus: [
      'You are a script editor judging pacing and momentum within this beat and across its neighbours. Use the previous and next beats only to judge whether this beat enters and exits at the right tempo, and the spine to judge whether its length matches its weight.',
      'Pacing is rhythm, not brevity. A beat stripped to its essentials — every turn arriving the moment the last one ends, no build, no room for a moment to land — is RUSHED, and that is as much a pacing fault as a beat that drags. Shorter is never better in itself, and you never raise an issue whose only point is that the beat could be shorter.',
      'How to fix a stretch that feels slow: the default is to ADD, not to cut. Slow almost always means the time is not being used — nothing is wanted, resisted, discovered or changing. Give the time a job: a want with an obstacle in its way, a small complication or reversal, a piece of behaviour that reveals character, anticipation that tightens, a contrast of tempo against what comes next. Write the lines to add. An approach, an arrival or a set-up that builds anticipation for what follows IS pacing; do not recommend removing it to arrive sooner — recommend what would charge it.',
      'Recommend a cut ONLY when the passage is weak in itself: awkward or badly written, a moment played twice, an explanation of what was just shown, or text the scene is plainly better without. When you do, the problem says which of those it is, and the cut is the smallest one that removes the fault — never a whole sequence. Every fix and every to_raise in this facet either adds or reshapes; one that only removes must name the weakness of the removed text itself.',
      'When the beat is rushed or thin, say where it needs room and write what goes there.',
    ].join(' '),
    criteria: [
      {
        key: 'entry',
        label: 'Entry',
        anchors: {
          3: 'Opens inert: greeting, settling in, set-up with nothing wanted and nothing building.',
          6: 'A few lines before anything is wanted or at stake, or it starts so abruptly that the turn has no set-up to land against.',
          9: 'The opening is already charged — something is wanted, approaching or building from the first line, at any length — and it matches the previous beat\'s exit tempo.',
        },
      },
      {
        key: 'escalation',
        label: 'Escalation',
        anchors: {
          3: 'Flat — the same pressure from first line to last, or one jump with no build.',
          6: 'Rises, but with a slack middle, a moment played twice, or turns that arrive with no build between them.',
          9: 'Each unit raises the stakes or turns, each has the room to land before the next, and nothing is said twice.',
        },
      },
      {
        key: 'exit',
        label: 'Exit',
        anchors: {
          3: 'Lingers past the turn, wraps up, explains.',
          6: 'Ends on the right moment plus a trailing line, or cuts away before the turn has landed.',
          9: 'Cuts on the turn or the button and hands off cleanly to the next beat.',
        },
      },
      {
        key: 'proportion',
        label: 'Length vs. weight',
        anchors: {
          3: 'Wildly out of proportion to the beat\'s importance in the spine — a major beat reduced to a summary of itself, or a minor one sprawling.',
          6: 'Somewhat thin or somewhat padded for what it carries.',
          9: 'The beat has the room its weight deserves: it builds, breathes and lands, with no stretch of unused time.',
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
    focus: 'You judge whether the characters in this beat are consistent with their profiles and distinct from one another in how they act and speak. Name any character whose voice slips. Clothing: a profile\'s usual wardrobe is a default. A character dressed for the scene\'s weather, season, place or period is consistent, and so is the text not listing the outfit at all; raise clothing only when it contradicts a wardrobe set for this beat, or when it departs from the usual wardrobe and nothing in the scene accounts for it.',
    criteria: [
      {
        key: 'distinctness',
        label: 'Distinct voices',
        optional: true,
        anchors: {
          3: 'Swap the character cues and nothing changes.',
          6: 'Distinct in attitude but not in diction or rhythm.',
          9: 'Each character is identifiable from the line alone. Report not applicable when fewer than two characters speak or act.',
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
        charactersFullText(ctx.characters, ctx.beat),
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
    focus: 'You judge show-don\'t-tell: is this beat written as photographable action a camera can capture, in particular images a production designer could build, or as interior prose it cannot? Point to the most un-filmable lines and how to externalize them. Camera cues (CRANE DOWN, PUSH IN, HANDHELD) are the director\'s choice: how many there are is not a fault. Raise a cue only when it names a shot that cannot be made or that hides the action.',
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
      {
        // Was "Spatial geography" under Format. It is about following the
        // action inside ONE scene — never about where in the world (or off
        // it) the story goes — and it weighs half a criterion.
        key: 'staging',
        label: 'Staging within a scene',
        optional: true,
        weight: 0.5,
        anchors: {
          3: 'Within a scene, a reader cannot tell who is where, so the action cannot be followed.',
          6: 'People are placed when they enter, but a move the action depends on is left to guess.',
          9: 'Wherever the action depends on it, a reader can tell who and what is where, and follows every move. Judge only positions the action uses: do not ask for a side, a distance, a seat or a door the story does not turn on, and never raise more than a should_fix here unless the action is unreadable. Report not applicable for a beat with no staged scene (a title crawl, a card, vistas, open space).',
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
    focus: 'You are a dialogue editor judging the SPOKEN lines in this beat. Flag the weakest lines and what subtext they should be playing. On-screen text — a title crawl, a super, a sign, a card — is not dialogue and is not judged here. The body carries only a few anchor lines (the full dialogue is written separately), so having few lines is not a fault. When nobody speaks, report every criterion as not applicable.',
    criteria: [
      {
        key: 'subtext',
        label: 'Subtext',
        optional: true,
        anchors: {
          3: 'Characters say exactly what they mean and feel.',
          6: 'Some lines are indirect.',
          9: 'Wants are pursued obliquely; the audience infers.',
        },
      },
      {
        key: 'exposition',
        label: 'Exposition handling',
        optional: true,
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
        optional: true,
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
          3: 'Contradicts the synopsis, the spine or the neighbours: an established fact, what a character knows, or where someone was last left.',
          6: 'A minor inconsistency.',
          9: 'Consistent with everything around it. A jump to another place, planet or time between beats is how this story moves and is consistent.',
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
    'Return only the JSON object the schema describes: one entry per criterion (quote the beat verbatim in every evidence.quote, and say in to_raise how to fix that criterion), the ranked issues (each quoting the beat), the strengths, and a short summary a screenwriter can act on.',
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
