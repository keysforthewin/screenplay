// Per-turn detection of "show me a plan first" intent on the user's message.
//
// When the user asks to review/preview/approve before changes are applied, the
// agent loop forces a "review-mode" turn: a system-prompt suffix tells the
// model to produce a compact plan with before/after snippets, and any mutation
// tool the model tries to call is intercepted before its handler runs.
//
// Trigger and override regexes are exported for tests and future tuning. The
// override set is checked AFTER triggers — overrides win on tie.

export const TRIGGER_REGEXES = [
  /\blet me review\b/i,
  /\bfor (my|our) review\b/i,
  /\blet me preview\b/i,
  /\bi(?:'?d| would) like to (?:see|review|preview) (?:the )?(?:plan|changes?|diff|edits?|updates?|proposals?)\b/i,
  /\b(?:can|could) (?:i|you|we) (?:see|review|preview) (?:the )?(?:plan|changes?|diff|edits?|updates?|proposals?)\b/i,
  /\bbefore (?:you )?(?:write|change|update|apply|run|edit|do|make)\b/i,
  /\bdry[- ]?run\b/i,
  /\bpropose (?:changes|edits|a plan|the changes)\b/i,
  /\bdraft (?:a |the )?plan\b/i,
  /\bshow me (?:the )?(?:plan|diff|proposed|change(?:s| you))\b/i,
  /\bwhat would you (?:change|edit|update|do|propose)\b/i,
  /\bdon'?t (?:write|apply|change|run|do|edit|make) (?:it|that|anything|any|the)?(?:\s\w+)? yet\b/i,
  /\bno changes? yet\b/i,
  /\bpreview (?:the )?(?:plan|changes?|diff|edits?|updates?)\b/i,
  /\bhold off\b/i,
];

export const OVERRIDE_REGEXES = [
  /\bdo it (?:now|anyway)?\b/i,
  /\bgo ahead\b/i,
  /\bjust do it\b/i,
  /\bproceed\b/i,
  /\bconfirmed\b/i,
  /\bapply (?:it|the changes?|now|the plan)\b/i,
  /\bexecute\b/i,
  /\bcommit\b/i,
  /\b(?:write|change|update|run|edit|make) it now\b/i,
  /\bskip review\b/i,
  /\bno (?:preview|review) needed\b/i,
  /\breview and apply\b/i,
];

export function detectReviewIntent(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  const triggered = TRIGGER_REGEXES.some((re) => re.test(text));
  if (!triggered) return false;
  const overridden = OVERRIDE_REGEXES.some((re) => re.test(text));
  return !overridden;
}

export const REVIEW_MODE_SUFFIX = `# Review-mode (this turn only)

The user has asked to review/preview before changes are applied. **Do not call mutation tools this turn.** Read whatever you need with read-only tools (\`get_*\`, \`list_*\`, \`search_*\`, \`screenplay_search\`, \`tool_search\`), then reply with a compact plan in this format:

## Proposed plan
**Target:** <entity, e.g. "beat 26 ('Diner Morning')">
**Scope:** <one-sentence description of what you'd change>

### Change 1: <field or section>
- Before: <≤2 short lines from current content, or "(empty)">
- After: <≤2 short lines as you'd rewrite it>

### Change 2: <field or section>
- Before: …
- After: …

(1–3 changes max. If there are more, append "+N more similar changes" rather than listing them all. Keep each before/after to one short paragraph — don't paste full bodies.)

---
**No changes will be made until you confirm. Reply "do it", "go ahead", or "apply" to execute — or tell me what to adjust.**

If the user confirms next turn, execute the plan you just proposed.`;

export function reviewInterceptText(toolName) {
  const name = typeof toolName === 'string' && toolName ? toolName : 'a mutation tool';
  return `Review mode is active for this turn. The call to \`${name}\` was NOT executed and no state was changed. Do not retry mutating tools. Finish the turn with the plan format described in the system prompt — 1–3 before/after snippets and the "No changes will be made until you confirm" line. Read-only tools (get_*, list_*, search_*) are still available if you need more context for the plan.`;
}
