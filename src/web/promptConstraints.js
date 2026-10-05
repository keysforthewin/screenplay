// src/web/promptConstraints.js
// Rule texts embedded in image prompts. Each export is a ready-to-embed block.

// Text is a POST-PRODUCTION layer. Every title, card, caption, credit, chyron
// and every piece of billed signage is composited over the finished picture in
// the edit, so nothing in this pipeline may bake wording into a plate. This
// supersedes the old framing of the same subject: "readable text warps to
// gibberish" treated lettering as a RISK to be dodged, which still allowed a
// prompt to letter a sign as long as it kept it small or soft. The rule is not
// risk-avoidance, it is the production order — the generated image is the clean
// plate the text lands on.
//
// Written POSITIVELY (blank, unlettered, smooth) rather than as a prohibition,
// per ANTI_SLOP_RULES: text conditioning moves probability TOWARD every concept
// it names, so "no text on the sign" summons a lettered sign.
//
// Embedded by the artwork critique's proposal prompts.
export const NO_TEXT_RULES = [
  'Text is added in POST-PRODUCTION — never render it. Every title, title card, caption, subtitle, credit, chyron, lower-third, label, and every piece of billed or lettered signage is composited over the finished picture later. What you generate is the clean plate that text lands on.',
  '- Never write WORDING into a prompt: no quoted words, no "the sign reads…", no "the marquee bills…", no spelled-out brand names, no captions, annotations, or watermarks. A prompt that hands the image model words to letter has already failed.',
  '- Write the surface as EMPTY, and write it positively: "a blank unlettered marquee letterboard", "a smooth empty sign panel", "a dark screen", "a plain unmarked banner". State the blankness as the thing that IS there — a bare prohibition plants the lettering it forbids.',
  '- A shot whose SUBJECT is text is not a shot. If the beat calls for a title card, a chyron, a newspaper headline, a phone screen of messages, or a page of copy, build the SET instead — the empty card background, the blank screen, the unlettered paper stock — and let post composite the words over it.',
  '- Nothing letters itself over the clip: no text appears, animates on, scrolls, or is revealed. A surface that carries text in the finished film stays blank for the whole shot.',
  '- TWO EXCEPTIONS, both narrow. (1) A reference image assigned to an EDIT is final: whatever text, signage, and logos it already carries stay exactly as they are — never repaint them blank, and never add to or alter their wording. (2) Printing a subject already wears — a garment graphic, a patch — stays as the reference shows it; never invent new wording on it, and never make it the legible focus of the frame.',
].join('\n');
