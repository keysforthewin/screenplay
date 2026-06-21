// Beat-critique facet registry — the single source of truth for what facets
// exist and how each is prompted. Each facet runs one forced-tool Anthropic
// call (see critiqueGenerate.js) that returns { score: 1-10, comments }.
//
// scope: 'focused' = judge THIS beat (with prev/next as immediate context);
//        'story'   = judge how this beat fits the whole screenplay.
// required: always-run facets the user mandated (format + director's notes).

import { stripMarkdown } from '../util/markdown.js';

function txt(s) {
  return stripMarkdown(String(s || '')).trim();
}

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
  return [`${label} — Beat #${beat.order}: ${txt(beat.name) || 'Untitled'}`, txt(beat.body) || '(no body)'].join('\n');
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

export const FACETS = [
  {
    key: 'format',
    label: 'Screenplay format',
    scope: 'focused',
    required: true,
    systemPrompt: [
      'You are a screenplay format editor. Judge ONLY how well the beat body conforms to standard screenplay style — not its content quality.',
      'Score 10 = textbook screenplay format; 1 = novel prose ignoring all convention.',
      'Weigh: sluglines for literal scenes (INT./EXT. LOCATION — TIME), present-tense photographable action lines, sparing camera cues, and correctly-formatted dialogue (CAPS speaker cue, optional parenthetical, line).',
      'Also weigh SPATIAL GEOGRAPHY: does the body establish where characters and key props sit in the set (blocking), and use a mini-slug (e.g. BACK SEAT, AT THE WINDOW) to pin a sub-location when the action moves within a scene? Ambiguous placement a downstream image generator could get wrong — "in the minivan" when the beat means the back seat — is a format fault, not a content nitpick.',
      'In comments, name the top 2-3 concrete format fixes. Return your judgement via the critique_facet tool.',
    ].join('\n'),
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
    systemPrompt: [
      "You check whether the project's director's notes (and any beat-level direction) are actually reflected in this beat.",
      'Score 10 = every applicable note is clearly honored; 1 = the beat ignores or contradicts the notes.',
      'In comments, cite which notes are met and which are missing or violated, with a concrete fix. Return your judgement via the critique_facet tool.',
    ].join('\n'),
    buildContext: (ctx) =>
      [
        "# Director's notes (project-wide guidance)",
        notesText(ctx.directorNotes),
        '',
        '# Beat-level direction (dialog_notes)',
        txt(ctx.beat?.dialog_notes) || '(none)',
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
    systemPrompt: [
      'You are a script editor judging pacing and momentum within this beat and across its neighbors.',
      'Score 10 = taut, every moment earns its place, clean escalation; 1 = dead spots, rushed turns, or wrong scene length.',
      'Use the previous and next beats only to judge whether this beat enters and exits at the right tempo. Return your judgement via the critique_facet tool.',
    ].join('\n'),
    buildContext: (ctx) =>
      [
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
    systemPrompt: [
      'You judge whether the characters in this beat are consistent and distinct in how they act and speak.',
      'Score 10 = each character is unmistakably themselves; 1 = interchangeable or out-of-character.',
      'In comments, name any character whose voice slips, with a concrete fix. Return your judgement via the critique_facet tool.',
    ].join('\n'),
    buildContext: (ctx) =>
      [
        '# Characters present in this beat',
        charactersText(ctx.characters),
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
    systemPrompt: [
      'You judge show-don\'t-tell: is this beat written as photographable action a camera can capture, or as interior prose it cannot?',
      'Score 10 = every line is visible on screen; 1 = thoughts, backstory, and abstractions the camera cannot show.',
      'In comments, point to the most un-filmable lines and how to externalize them. Return your judgement via the critique_facet tool.',
    ].join('\n'),
    buildContext: (ctx) =>
      [
        '# Screenplay craft reference',
        ctx.styleGuide,
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
    systemPrompt: [
      'You are a dialogue editor judging the anchor lines in this beat.',
      'Score 10 = sharp, in-voice, carrying subtext; 1 = on-the-nose, wooden, or expository.',
      'In comments, flag the weakest lines and what subtext they should be playing. Return your judgement via the critique_facet tool.',
    ].join('\n'),
    buildContext: (ctx) =>
      ['# The beat to evaluate', beatBlock(ctx.beat)].join('\n'),
  },
  {
    key: 'story_fit',
    label: 'Story fit',
    scope: 'story',
    required: false,
    systemPrompt: [
      'You judge how this single beat fits into the whole screenplay: does it earn its place in the arc, avoid redundancy, and maintain continuity with the surrounding story?',
      'Score 10 = the beat is essential and well-placed; 1 = redundant, misplaced, or contradicts the larger story.',
      'Use the synopsis and the full beat spine to judge placement. In comments, say whether to keep, move, merge, or cut, and why. Return your judgement via the critique_facet tool.',
    ].join('\n'),
    buildContext: (ctx) =>
      [
        '# Story synopsis',
        txt(ctx.plot?.synopsis) || '(no synopsis)',
        '',
        '# Full beat spine (the whole screenplay in order)',
        spineText(ctx.spine),
        '',
        `# The beat to evaluate — currently at position #${ctx.beat?.order ?? '?'}`,
        beatBlock(ctx.beat),
      ].join('\n'),
  },
];

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
    status: 'pending',
    error_message: null,
  }));
}
