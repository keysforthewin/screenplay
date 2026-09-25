// Deterministic dialogue-coverage audit over a beat's shot list. Pure: no
// I/O, no LLM. Adapted from PenShot's quality-auditor checks that a rule can
// decide (the judgement calls stay with the 5-lens LLM critique).
//
// Codes:
//   dialog_unassigned      warn  a line no shot covers (won't be lip-synced)
//   dialog_double_assigned warn  a line covered by two shots
//   dialog_out_of_order    warn  a later shot covers an earlier line
//   dialog_over_cap        warn  covered speech exceeds the shot_type duration cap
//   speaker_not_in_shot    warn  the line's speaker is not in characters_in_scene
//   dialog_audio_missing   info  a covered line has no recording (shot renders
//                                without lip-sync until one is attached)
//   prompt_missing         warn  the shot has no prompt to render from

import { stripMarkdown } from '../util/markdown.js';
import { durationCapFor } from '../mongo/storyboards.js';
import { estimateSpeechSeconds } from './shotTiming.js';

function idStr(v) {
  return v == null ? '' : String(v);
}

export function auditShotCoverage({ shots = [], dialogs = [] } = {}) {
  const checks = [];
  const push = (severity, code, message, storyboard_id = null, subject = null) =>
    checks.push({ severity, code, message, storyboard_id: storyboard_id ? String(storyboard_id) : null, subject });

  const orderedShots = [...(Array.isArray(shots) ? shots : [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  const lines = Array.isArray(dialogs) ? dialogs : [];
  const lineIndex = new Map(lines.map((d, i) => [idStr(d._id), i]));

  const coveredBy = new Map(); // dialog id -> [shot]
  let lastLineIdx = -1;
  for (const sb of orderedShots) {
    const ids = Array.isArray(sb.dialog_ids) ? sb.dialog_ids.map(idStr).filter(Boolean) : [];
    const covered = ids.map((id) => lines[lineIndex.get(id)]).filter(Boolean);

    if (!stripMarkdown(sb.text_prompt || '').trim()) {
      push('warn', 'prompt_missing', `Shot ${sb.order}: no prompt to render from.`, sb._id);
    }

    for (const id of ids) {
      if (!lineIndex.has(id)) continue; // foreign id: the gateway already rejects these
      if (!coveredBy.has(id)) coveredBy.set(id, []);
      coveredBy.get(id).push(sb);
    }

    // Order: every covered line index must be > the max index of earlier shots.
    const idxs = ids.map((id) => lineIndex.get(id)).filter((i) => Number.isInteger(i));
    if (idxs.length) {
      const minIdx = Math.min(...idxs);
      if (minIdx <= lastLineIdx) {
        push('warn', 'dialog_out_of_order', `Shot ${sb.order}: covers line ${minIdx + 1}, but an earlier shot already covers line ${lastLineIdx + 1}.`, sb._id);
      }
      lastLineIdx = Math.max(lastLineIdx, ...idxs);
    }

    // Speaker present.
    const cast = new Set((sb.characters_in_scene || []).map((n) => stripMarkdown(String(n)).trim().toLowerCase()).filter(Boolean));
    for (const d of covered) {
      const speaker = stripMarkdown(String(d.character || '')).trim();
      if (speaker && cast.size && !cast.has(speaker.toLowerCase())) {
        push('warn', 'speaker_not_in_shot', `Shot ${sb.order}: covers a line by ${speaker}, who is not in the shot's cast.`, sb._id, speaker);
      }
      if (!d.audio_file_id) {
        push('info', 'dialog_audio_missing', `Shot ${sb.order}: line ${lineIndex.get(idStr(d._id)) + 1} (${speaker || 'unknown'}) has no recording — the shot renders without lip-sync.`, sb._id, idStr(d._id));
      }
    }

    // Over cap.
    if (covered.length) {
      const speech = estimateSpeechSeconds(covered);
      const cap = durationCapFor(sb.shot_type);
      if (speech > cap) {
        push('warn', 'dialog_over_cap', `Shot ${sb.order}: ~${Math.ceil(speech)}s of speech exceeds the ${cap}s cap for ${sb.shot_type || 'this shot type'}.`, sb._id);
      }
    }
  }

  lines.forEach((d, i) => {
    const id = idStr(d._id);
    const shotsFor = coveredBy.get(id) || [];
    const speaker = stripMarkdown(String(d.character || '')).trim() || 'unknown';
    if (!shotsFor.length) {
      push('warn', 'dialog_unassigned', `Line ${i + 1} (${speaker}) is not covered by any shot.`, null, id);
    } else if (shotsFor.length > 1) {
      push('warn', 'dialog_double_assigned', `Line ${i + 1} (${speaker}) is covered by shots ${shotsFor.map((s) => s.order).join(', ')}.`, null, id);
    }
  });

  const counts = {
    warnings: checks.filter((c) => c.severity === 'warn').length,
    infos: checks.filter((c) => c.severity === 'info').length,
  };
  return { checks, counts, created_at: new Date() };
}
