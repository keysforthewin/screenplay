// Cost arithmetic for fal.ai video generations. Two entry points:
//
//   estimateRegisteredCost(modelId, bundle) — exact USD for the six
//     hand-wired models in src/fal/videoModels.js. Returns
//     { totalUsd, perSecondUsd?, basis, exact: true } or null when we
//     don't have enough info (e.g. lip-sync without an audio duration).
//
//   estimateCatalogCost(catalogRow, bundle) — best-effort regex over the
//     free-form price_text on the wider catalog. Returns the same shape
//     with exact: false, or null when no pattern matches.
//
// The structured PRICING table below is the single source of truth for
// the registered models. Update prices here when fal changes them; the
// SPA also reads this same shape (exposed via /api/video-models →
// model.pricing) so the dialog and the orchestrator always agree.

// Resolution → pixel dimensions table used by per-megapixel pricing.
// Values are 16:9 conventions; if a model advertises a different aspect
// ratio fal will internally scale, but the megapixel total fal bills is
// computed on these standard heights. Kept in sync with the same table
// in web/src/videoCost.js (small enough that duplication beats setting
// up a shared subpath).
export const RES_TO_DIMS = Object.freeze({
  '360p': [640, 360],
  '480p': [854, 480],
  '540p': [960, 540],
  '580p': [1024, 580],
  '720p': [1280, 720],
  '768p': [1366, 768],
  '1024p': [1820, 1024],
  '1080p': [1920, 1080],
  true_1080p: [1920, 1080],
  '1440p': [2560, 1440],
  '2160p': [3840, 2160],
  '4k': [3840, 2160],
});

function resToDims(resolution) {
  if (!resolution) return null;
  const key = String(resolution).toLowerCase();
  return RES_TO_DIMS[key] || RES_TO_DIMS[String(resolution)] || null;
}

// Map a `pricingId` (set on each VIDEO_MODELS entry) to a structured
// pricing record the dialog can render against. Rates verified against
// each model's published price_text on 2026-05-12.
//
// Shapes:
//   kind: 'per_second'      — rate depends on { generateAudio } only.
//   kind: 'per_second_tiered' — rate also depends on { resolution } and
//                              optionally { generateAudio }.
//   kind: 'per_megapixel'   — rate × (width × height × frames) / 1e6.
//   kind: 'per_audio_second' — duration = audio length; rate flat.
//   kind: 'flat_per_clip'   — fixed cost regardless of duration.
//   kind: 'unknown'         — fal does not publish a structured price;
//                              we surface metadata but no number.
export const PRICING = Object.freeze({
  'kling-3-pro': {
    kind: 'per_second',
    rates: [
      { when: { generateAudio: false }, perSecondUsd: 0.112 },
      { when: { generateAudio: true }, perSecondUsd: 0.168 },
    ],
    note:
      'Kling 3 Pro: $0.112/s audio-off, $0.168/s audio-on. (Voice control ' +
      '$0.196/s — not currently sent by this app.)',
  },
  'veo-3-1-flf': {
    kind: 'per_second_tiered',
    defaultResolution: '1080p',
    rates: [
      // 720p and 1080p share rates; denormalise so pickRate works
      // without needing array-valued `when` keys.
      { when: { resolution: '720p', generateAudio: false }, perSecondUsd: 0.20 },
      { when: { resolution: '720p', generateAudio: true }, perSecondUsd: 0.40 },
      { when: { resolution: '1080p', generateAudio: false }, perSecondUsd: 0.20 },
      { when: { resolution: '1080p', generateAudio: true }, perSecondUsd: 0.40 },
      { when: { resolution: '4k', generateAudio: false }, perSecondUsd: 0.40 },
      { when: { resolution: '4k', generateAudio: true }, perSecondUsd: 0.60 },
    ],
    note:
      'Veo 3.1 FLF: $0.20/s at 720p/1080p (without audio), $0.40/s with ' +
      'audio; 4k is $0.40/s no-audio, $0.60/s with audio.',
  },
  'kling-avatar-v2-pro': {
    kind: 'per_audio_second',
    // fal does not publish a structured price for this endpoint. We
    // still expose audio length so the UI can show a duration estimate;
    // perSecondUsd is null so the cost itself is left blank with a note.
    perSecondUsd: null,
    note:
      'Kling AI Avatar v2 Pro: fal does not publish a per-second rate. ' +
      'The duration shown matches the input audio length.',
  },
  flashhead: {
    kind: 'unknown',
    note: 'Flashhead: fal does not publish a price for this endpoint.',
  },
  'sora-2': {
    kind: 'per_second',
    rates: [{ when: {}, perSecondUsd: 0.10 }],
    note: 'Sora 2: $0.10/s flat.',
  },
  // Video-to-video models. Pricing for these endpoints isn't always
  // structured the way fal exposes it for i2v — we use 'unknown' when in
  // doubt and let the catalog's `price_text` carry the human-readable rate.
  'sora-2-v2v-remix': {
    kind: 'unknown',
    note:
      'Sora 2 Video Remix: priced like Sora 2 i2v (~$0.10/s) but billed per ' +
      "remix request — fal's structured pricing isn't published. See the " +
      'catalog price_text for the live string.',
  },
  'luma-ray-2-modify': {
    kind: 'unknown',
    note:
      'Luma Ray 2 Modify: fal does not publish a structured per-second rate ' +
      'for the modify endpoint; the catalog price_text carries the live ' +
      'string.',
  },
  'sync-lipsync-v2': {
    kind: 'per_audio_second',
    // Sync Lipsync bills by the duration of the input audio; rate varies
    // by `model` (lipsync-2 vs lipsync-2-pro). We default to lipsync-2.
    perSecondUsd: null,
    note:
      'Sync Lipsync v2: priced per second of input audio. lipsync-2-pro ' +
      'costs ~1.67× lipsync-2; see catalog price_text for current numbers.',
  },
  'decart-lucy-edit-pro': {
    kind: 'unknown',
    note:
      'Decart Lucy Edit Pro: fal does not publish a structured per-second ' +
      'rate; the catalog price_text carries the live string.',
  },
  'sora-2-pro': {
    kind: 'per_second_tiered',
    // Sora 2 Pro is resolution-tiered. We send `resolution: 'auto'`; on
    // Sora 2 Pro auto defaults to 720p, so 0.30/s is the price the user
    // will actually be billed. The full ladder is included in `rates`
    // so the dialog tooltip and the panel can explain why.
    defaultResolution: '720p',
    rates: [
      { when: { resolution: '720p' }, perSecondUsd: 0.30 },
      { when: { resolution: '1080p' }, perSecondUsd: 0.50 },
      { when: { resolution: 'true_1080p' }, perSecondUsd: 0.70 },
    ],
    note:
      'Sora 2 Pro: $0.30/s at 720p, $0.50/s at legacy 1080p, $0.70/s at ' +
      'true 1080p. With auto resolution the app sends 720p.',
  },
});

// Build the SPA-facing pricing descriptor for a given pricingId. The
// dialog reads this directly so the structured form ships once with the
// /video-models response and live cost re-computes happen client-side.
export function describePricing(pricingId) {
  const p = PRICING[pricingId];
  if (!p) return null;
  return {
    pricing_id: pricingId,
    kind: p.kind,
    rates: Array.isArray(p.rates) ? p.rates : null,
    per_second_usd: p.perSecondUsd ?? null,
    per_mp_usd: p.perMpUsd ?? null,
    flat_usd: p.flatUsd ?? null,
    default_resolution: p.defaultResolution || null,
    default_fps: p.defaultFps || null,
    requires_audio_duration: p.kind === 'per_audio_second',
    requires_resolution:
      p.kind === 'per_second_tiered' || p.kind === 'per_megapixel',
    requires_fps: p.kind === 'per_megapixel',
    exact: p.kind !== 'unknown',
    note: p.note || null,
  };
}

// Pick the matching rate from a `rates: [{ when, perSecondUsd }]` list.
// `when` keys must all match the bundle; the first matching entry wins
// (so put the most-specific tiers first — though for our models the
// keys are disjoint so order doesn't actually matter).
function pickRate(rates, bundle) {
  for (const r of rates || []) {
    let ok = true;
    for (const [k, v] of Object.entries(r.when || {})) {
      if (bundle[k] !== v) { ok = false; break; }
    }
    if (ok) return r;
  }
  return null;
}

// Compute the exact cost for a registered model. `bundle` is the same
// shape the model.buildInput() consumes, plus an `audioDurationSeconds`
// field for lip-sync models.
//
// Returns:
//   { totalUsd, perSecondUsd?, durationSeconds, basis, exact: true }
//   or null when we don't have enough info or pricing isn't published.
export function estimateRegisteredCost(pricingId, bundle = {}) {
  const p = PRICING[pricingId];
  if (!p) return null;
  if (p.kind === 'unknown') return null;

  if (p.kind === 'per_audio_second') {
    const dur = Number(bundle.audioDurationSeconds);
    const rate = p.perSecondUsd;
    if (!Number.isFinite(dur) || dur <= 0) return null;
    if (rate == null) {
      // We know the duration but not the rate. Useful for showing the
      // duration in the UI without a dollar amount.
      return {
        totalUsd: null,
        perSecondUsd: null,
        durationSeconds: dur,
        basis: 'audio length × (rate not published)',
        exact: false,
      };
    }
    return {
      totalUsd: rate * dur,
      perSecondUsd: rate,
      durationSeconds: dur,
      basis: `$${rate.toFixed(3)}/s × ${dur.toFixed(2)}s audio`,
      exact: true,
    };
  }

  if (p.kind === 'flat_per_clip') {
    return {
      totalUsd: p.flatUsd,
      perSecondUsd: null,
      durationSeconds: null,
      basis: `$${p.flatUsd.toFixed(2)} flat`,
      exact: true,
    };
  }

  if (p.kind === 'per_second' || p.kind === 'per_second_tiered') {
    const dur = Number(bundle.durationSeconds);
    if (!Number.isFinite(dur) || dur <= 0) return null;
    const lookup = { ...bundle };
    if (p.kind === 'per_second_tiered') {
      // 'auto' is sent to fal as a placeholder; the actual billed tier
      // is the model's documented default for `auto`.
      if (!lookup.resolution || lookup.resolution === 'auto') {
        lookup.resolution = p.defaultResolution;
      }
    }
    const rate = pickRate(p.rates, lookup);
    if (!rate) return null;
    return {
      totalUsd: rate.perSecondUsd * dur,
      perSecondUsd: rate.perSecondUsd,
      durationSeconds: dur,
      basis:
        `$${rate.perSecondUsd.toFixed(3)}/s × ${dur}s` +
        (lookup.resolution ? ` @ ${lookup.resolution}` : ''),
      exact: true,
    };
  }

  if (p.kind === 'per_megapixel') {
    const total = megapixelCost({
      perMpUsd: p.perMpUsd,
      resolution: bundle.resolution,
      fps: bundle.fps,
      durationSeconds: bundle.durationSeconds,
    });
    return total
      ? { ...total, exact: true }
      : null;
  }

  return null;
}

// Compute `(w × h × frames) / 1e6 × rate`. Returns null when any required
// input is missing so callers can surface a "pick a resolution to see
// cost" hint instead of a wrong number.
function megapixelCost({ perMpUsd, resolution, fps, durationSeconds }) {
  if (typeof perMpUsd !== 'number' || !(perMpUsd > 0)) return null;
  const dims = resToDims(resolution);
  const dur = Number(durationSeconds);
  const f = Number(fps);
  if (!dims || !Number.isFinite(dur) || dur <= 0 || !Number.isFinite(f) || f <= 0) {
    return null;
  }
  const frames = Math.max(1, Math.round(dur * f));
  const mp = (dims[0] * dims[1] * frames) / 1_000_000;
  const totalUsd = mp * perMpUsd;
  return {
    totalUsd,
    perSecondUsd: null,
    perMpUsd,
    durationSeconds: dur,
    basis:
      `$${perMpUsd.toFixed(4)}/MP × ${mp.toFixed(1)}MP ` +
      `(${resolution} ${f}fps × ${dur}s = ${frames} frames)`,
  };
}

// ---------------------------------------------------------------------------
// Catalog (best-effort) — improved regex over fal's free-form price_text.
// Handles the patterns the original SPA-side parser missed: per-megapixel,
// tiered (multiple "$X/s" prices for different resolutions), and the
// example-cost lines ("a 5 second video at 1080p with audio on will cost
// **$2.00**.").

// Match every "$X" amount in the text and return the smallest.
function pickMinPriceUsd(text) {
  const matches = [...String(text).matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1]));
  if (!matches.length) return null;
  return matches.reduce((a, b) => Math.min(a, b), matches[0]);
}

function pickMaxPriceUsd(text) {
  const matches = [...String(text).matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1]));
  if (!matches.length) return null;
  return matches.reduce((a, b) => Math.max(a, b), matches[0]);
}

// Public — also called from the SPA's fallback path via the registry
// response. Returns one of:
//   { kind: 'per_second', perSecondUsd, basis, exact: false }
//   { kind: 'per_megapixel', perMpUsd, basis, exact: false }
//   { kind: 'flat_per_clip', flatUsd, durationSeconds, basis, exact: false }
//   null
// Match resolution tags that commonly appear in fal price text.
const RES_TOKEN_RE = /\b(360p|480p|540p|580p|720p|768p|1024p|1080p|1440p|2160p|4k)\b/i;
const RES_ALTERNATION = '360p|480p|540p|580p|720p|768p|1024p|1080p|1440p|2160p|4k';

export function parseCatalogPriceText(priceText) {
  if (typeof priceText !== 'string' || !priceText) return null;
  const t = priceText;

  // 0. Tiered per-second: detect "<resolution>: $X/s" or "$X/s at <res>"
  //    patterns. Two or more matches → emit per_second_tiered so the
  //    dialog can pick the user's resolution instead of the conservative
  //    minimum.
  const tieredRates = collectTieredRates(t);
  if (tieredRates.length >= 2) {
    return {
      kind: 'per_second_tiered',
      rates: tieredRates,
      basis: `parsed ${tieredRates.length} tiered rates from price_text`,
      exact: false,
    };
  }

  // 1. Per-second variants. Try the simplest "$X per/per generated second"
  //    first; if that fails fall back to "every second costs $X" (Kling-
  //    style multi-tier text — pick the *minimum* tier since we surface
  //    a single number). Accepts both "/second" and the "/s" shorthand
  //    fal uses for Sora ("The pricing is $0.10/s").
  const perSecond = /\$(\d+(?:\.\d+)?)\s*(?:\/|per)\s*(?:generated\s+)?s(?:econd)?\b/i.exec(t);
  if (perSecond) {
    return {
      kind: 'per_second',
      perSecondUsd: parseFloat(perSecond[1]),
      basis: 'per second (parsed)',
      exact: false,
    };
  }
  const everyMatches = [...t.matchAll(/every\s+second\s+(?:costs|is|of\s+video\s+you\s+(?:generate|generated))\s*[^$]*\$(\d+(?:\.\d+)?)/gi)];
  if (everyMatches.length) {
    const rates = everyMatches.map((m) => parseFloat(m[1])).sort((a, b) => a - b);
    return {
      kind: 'per_second',
      perSecondUsd: rates[0],
      basis: rates.length > 1 ? `per second (lowest of ${rates.length} tiers)` : 'per second',
      exact: false,
    };
  }

  // 2. "$Y for a Ns clip" — derive per-second.
  const clipMatch = /\$(\d+(?:\.\d+)?)\s*for\s+(?:a\s+)?(\d+(?:\.\d+)?)\s*s(?:\s|econd|$)/i.exec(t);
  if (clipMatch) {
    const total = parseFloat(clipMatch[1]);
    const seconds = parseFloat(clipMatch[2]);
    if (seconds > 0) {
      return {
        kind: 'per_second',
        perSecondUsd: total / seconds,
        basis: `derived from ${seconds}s clip price`,
        exact: false,
      };
    }
  }

  // 3. Per-megapixel ("Your request will cost $X per megapixel of generated
  //    video data (width × height × frames)"). We can't compute without
  //    knowing the model's default frames/resolution, so report the rate
  //    but no total.
  const perMp = /\$(\d+(?:\.\d+)?)\s*per\s*(?:generated\s+)?megapixel/i.exec(t);
  if (perMp) {
    return {
      kind: 'per_megapixel',
      perMpUsd: parseFloat(perMp[1]),
      basis: 'per megapixel of video (width × height × frames)',
      exact: false,
    };
  }

  // 4. Flat-per-clip — a model that quotes a single example total with
  //    no per-second breakdown. Reported as a single number with no rate.
  const total = pickMinPriceUsd(t);
  if (total != null) {
    return {
      kind: 'flat_per_clip',
      flatUsd: total,
      basis: 'parsed flat clip price (best-effort)',
      exact: false,
    };
  }
  return null;
}

// Collect tiered "$X/s at <resolution>" rates from price text. Each
// match contributes a `{ when: { resolution }, perSecondUsd }` entry.
// Returns [] when fewer than two distinct resolutions are mentioned —
// caller falls through to the simpler single-rate parser.
function collectTieredRates(text) {
  // Pattern A: "<res>: $X/s" / "<res> $X/s" / "<res> - $X/s" — the
  //   resolution appears BEFORE the rate. Authoritative when present.
  // Pattern B: "$X/s for <res>" / "$X/s at <res>" — rate appears
  //   BEFORE the resolution. Only fills gaps pattern A missed
  //   (otherwise it can mis-attribute a price to a *following*
  //   resolution mentioned later in the same sentence).
  const rates = new Map();
  const rxA = new RegExp(
    `\\b(${RES_ALTERNATION})\\b[^$\\n]{0,30}?\\$(\\d+(?:\\.\\d+)?)\\s*(?:\\/|per)\\s*(?:generated\\s+)?s(?:econd)?\\b`,
    'gi',
  );
  for (const m of text.matchAll(rxA)) {
    const key = m[1].toLowerCase();
    if (!rates.has(key)) rates.set(key, parseFloat(m[2]));
  }
  const rxB = new RegExp(
    `\\$(\\d+(?:\\.\\d+)?)\\s*(?:\\/|per)\\s*(?:generated\\s+)?s(?:econd)?\\b[^$\\n]{0,30}?\\b(${RES_ALTERNATION})\\b`,
    'gi',
  );
  for (const m of text.matchAll(rxB)) {
    const key = m[2].toLowerCase();
    if (!rates.has(key)) rates.set(key, parseFloat(m[1]));
  }
  return [...rates.entries()].map(([resolution, perSecondUsd]) => ({
    when: { resolution },
    perSecondUsd,
  }));
}

// Compute a best-effort total for a catalog row given the same bundle
// shape. The dialog uses this when the row has no structured `pricing`
// (i.e. it's a Preview-only catalog entry). Returns null when we have
// no rate or insufficient info.
export function estimateCatalogCost(catalogRow, bundle = {}) {
  const parsed = parseCatalogPriceText(catalogRow?.price_text);
  if (!parsed) return null;
  const dur = Number(bundle.durationSeconds);
  if (parsed.kind === 'per_second' && Number.isFinite(dur) && dur > 0) {
    return {
      totalUsd: parsed.perSecondUsd * dur,
      perSecondUsd: parsed.perSecondUsd,
      durationSeconds: dur,
      basis: parsed.basis,
      exact: false,
    };
  }
  if (parsed.kind === 'per_second_tiered') {
    if (!Number.isFinite(dur) || dur <= 0) return null;
    const userRes = bundle.resolution ? String(bundle.resolution).toLowerCase() : null;
    let rate = userRes ? parsed.rates.find((r) => r.when.resolution === userRes) : null;
    if (!rate) {
      // Conservative default when the user hasn't picked: take the
      // lowest tier so we never *overestimate* by accident.
      rate = parsed.rates.reduce(
        (best, r) => (r.perSecondUsd < best.perSecondUsd ? r : best),
        parsed.rates[0],
      );
    }
    return {
      totalUsd: rate.perSecondUsd * dur,
      perSecondUsd: rate.perSecondUsd,
      durationSeconds: dur,
      basis: `${parsed.basis} — using ${rate.when.resolution}`,
      exact: false,
    };
  }
  if (parsed.kind === 'flat_per_clip') {
    return {
      totalUsd: parsed.flatUsd,
      perSecondUsd: null,
      durationSeconds: null,
      basis: parsed.basis,
      exact: false,
    };
  }
  if (parsed.kind === 'per_megapixel') {
    const mp = megapixelCost({
      perMpUsd: parsed.perMpUsd,
      resolution: bundle.resolution,
      fps: bundle.fps,
      durationSeconds: bundle.durationSeconds,
    });
    if (mp) return { ...mp, exact: false };
    // Rate but no total — UI can render the rate as a hint.
    return {
      totalUsd: null,
      perSecondUsd: null,
      durationSeconds: null,
      basis: parsed.basis,
      perMpUsd: parsed.perMpUsd,
      exact: false,
    };
  }
  return null;
}

// Format a USD amount for display. Same rules as the dialog's existing
// formatUsdAmount but centralised so backend and frontend agree.
export function formatUsd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
}

// Probe an audio buffer for its playback duration in seconds. Used to
// drive lip-sync cost estimates. Returns a positive number on success,
// null on any parser failure (unsupported format, corrupt headers, …).
export async function probeAudioDurationSeconds(buffer, mimeType) {
  if (!buffer || !buffer.length) return null;
  try {
    const mm = await import('music-metadata');
    const meta = await mm.parseBuffer(
      buffer,
      mimeType ? { mimeType } : undefined,
      { duration: true },
    );
    const dur = Number(meta?.format?.duration);
    return Number.isFinite(dur) && dur > 0 ? dur : null;
  } catch {
    return null;
  }
}
