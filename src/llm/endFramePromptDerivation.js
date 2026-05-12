// Derives a camera-aware end_prompt from a rendered start frame.
//
// The storyboard planner emits start_prompt + end_prompt pairs that, by
// design, describe the same composition with only pose progression — which
// is great for narrative continuity but causes the rendered start and end
// frames to look near-identical. This helper post-processes each frame
// after the start frame is rendered and captioned: it takes the planner's
// pair plus the start frame's auto-generated description and returns a new
// end_prompt that explicitly varies camera position / angle / distance,
// while keeping characters, lighting, palette, and location locked.
//
// Failures collapse to null so callers can fall back to the planner's
// original end_prompt — the pipeline never blocks on a derivation miss.

import { config } from '../config.js';
import { getAnthropic } from '../anthropic/client.js';
import { logger } from '../log.js';

// Storyboard pipeline calls this with model='claude-opus-4-7' for top-tier
// rewrites. The default below is the same Opus model — there is no other
// caller and we want this derivation to be primo by default.
const DEFAULT_MODEL = 'claude-opus-4-7';

const SYSTEM_PROMPT = [
  'You rewrite cinematic storyboard END-frame prompts so the camera meaningfully moves between the start and end of the shot.',
  '',
  'You are given:',
  '- start_prompt: the planner\'s description of the START frame (the moment the shot begins).',
  '- end_prompt: the planner\'s ORIGINAL description of the END frame. It usually says the same composition with a tiny pose change — that is the problem you are fixing.',
  '- start_description: an auto-generated caption of the actual rendered start frame (richer than the prompt, since it reflects what the image generator produced).',
  '- shot_type: one of establishing | cinematic_wide | insert | medium | close_up | reaction | two_shot | over_the_shoulder. Drives how much camera motion is appropriate.',
  '',
  'Your job: produce a new end_prompt that keeps the same narrative beat (the action progression the original end_prompt described) but explicitly moves the camera. The end frame should look like a different framing of the same scene, captured a few seconds after the start.',
  '',
  'Camera-motion vocabulary you should pick from, scaled to shot_type:',
  '- cinematic_wide / establishing: crane up or down, dolly in / pull back, pan, large angle change. Big moves are encouraged.',
  '- medium / two_shot / over_the_shoulder: push in, ease back, slight angle shift, rack focus, small dolly.',
  '- close_up / reaction / insert: small reframe, tilt, rack focus, subtle push in. Do NOT crane or dolly far.',
  '',
  'When the start frame already implies a camera high or low (crane / boom / overhead / dutch / low angle), describe the camera ARRIVING at a meaningfully different position by the end (e.g. start = crane down looking at booth → end = camera at eye level across the booth).',
  '',
  'Constraints:',
  '- Keep the location, set dressing, palette, lighting direction and temperature, and character identity consistent — these are LOCKED.',
  '- Keep the same character(s) on screen unless the planner\'s end_prompt explicitly drops or adds someone.',
  '- ~2 sentences, ≤ 60 words. Concrete and visual. No camera-jargon dump — one clear camera direction is enough.',
  '- Do NOT re-describe a character\'s face, body, wardrobe, or the location — reference images carry that.',
  '',
  'Output rules:',
  '- Respond with EXACTLY one line of compact JSON: {"end_prompt": "<your rewritten end_prompt>"}.',
  '- No markdown, no code fences, no commentary outside the JSON.',
  '- The value must be a single paragraph (no line breaks inside the string).',
].join('\n');

function safeParse(text) {
  if (typeof text !== 'string') return null;
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const obj = JSON.parse(stripped);
    if (!obj || typeof obj !== 'object') return null;
    const v = typeof obj.end_prompt === 'string' ? obj.end_prompt.trim() : '';
    return v || null;
  } catch {
    return null;
  }
}

export async function deriveEndPrompt({
  startPrompt,
  endPrompt,
  startDescription,
  shotType = null,
  model = null,
} = {}) {
  if (!config.anthropic?.apiKey) return null;
  if (typeof startPrompt !== 'string' || !startPrompt.trim()) return null;
  if (typeof startDescription !== 'string' || !startDescription.trim()) return null;
  const original = typeof endPrompt === 'string' ? endPrompt.trim() : '';

  const userText = [
    `shot_type: ${shotType || '(unspecified)'}`,
    '',
    'start_prompt:',
    startPrompt.trim(),
    '',
    'end_prompt (original — usually too similar to the start, this is what you are fixing):',
    original || '(none — invent a sensible action progression)',
    '',
    'start_description (auto-caption of the rendered start frame):',
    startDescription.trim(),
    '',
    'Rewrite end_prompt so the camera moves meaningfully while everything else stays locked. Return JSON only.',
  ].join('\n');

  const t0 = Date.now();
  try {
    const client = getAnthropic();
    const resp = await client.messages.create({
      model: model || DEFAULT_MODEL,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    });
    const text = (resp.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const parsed = safeParse(text);
    if (!parsed) {
      logger.warn(`deriveEndPrompt: parse failed (${Date.now() - t0}ms)`);
      return null;
    }
    logger.info(
      `deriveEndPrompt[${shotType || 'na'}]: ${parsed.length}c in ${Date.now() - t0}ms`,
    );
    return parsed;
  } catch (e) {
    logger.warn(`deriveEndPrompt: ${e.message} (${Date.now() - t0}ms)`);
    return null;
  }
}
