// Client-side video cost computation. Reads the structured `pricing`
// shape that /api/video-models attaches to each model row (see
// src/fal/videoPricing.js → describePricing). The dialog uses this so
// the estimate updates live as the user toggles duration/audio without
// a round-trip to the preview endpoint.
//
// Resolution → dimensions table. Kept in sync (manually — keep small)
// with the same map in src/fal/videoPricing.js (RES_TO_DIMS).
const RES_TO_DIMS = Object.freeze({
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

// Pick a matching `{ when, perSecondUsd }` entry from a structured
// pricing.rates array. Returns the FIRST match against `bundle` — for
// tiered pricing the caller passes the user-picked resolution so the
// right tier wins.
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

// Compute a cost estimate given a model row (with `pricing` attached)
// and a bundle of `{ duration, generateAudio, resolution, audioDuration }`.
// Returns `{ totalUsd, perSecondUsd?, durationSeconds, basis, exact }`
// or null when there isn't enough info.
export function computeVideoCost(model, bundle = {}) {
  const p = model?.pricing;
  if (!p) return null;
  const dur = Number(bundle.duration);
  const audioDur = Number(bundle.audioDuration);
  const lookup = {
    generateAudio: !!bundle.generateAudio,
    resolution: bundle.resolution || null,
  };

  if (p.kind === 'per_audio_second') {
    if (!Number.isFinite(audioDur) || audioDur <= 0) return null;
    const rate = p.per_second_usd;
    if (rate == null) {
      return {
        totalUsd: null,
        perSecondUsd: null,
        durationSeconds: audioDur,
        basis: 'audio length × (rate not published)',
        exact: false,
      };
    }
    return {
      totalUsd: rate * audioDur,
      perSecondUsd: rate,
      durationSeconds: audioDur,
      basis: `$${rate.toFixed(3)}/s × ${audioDur.toFixed(2)}s audio`,
      exact: !!p.exact,
    };
  }

  if (p.kind === 'flat_per_clip') {
    const flat = p.flat_usd ?? p.per_second_usd ?? null;
    if (flat == null) return null;
    return {
      totalUsd: flat,
      perSecondUsd: null,
      durationSeconds: null,
      basis: `$${flat.toFixed(2)} flat`,
      exact: !!p.exact,
    };
  }

  if (p.kind === 'per_megapixel') {
    const dims = resToDims(bundle.resolution);
    const f = Number(bundle.fps);
    if (!dims || !Number.isFinite(dur) || dur <= 0 || !Number.isFinite(f) || f <= 0) {
      // Surface the rate even when we can't total, so the tooltip stays
      // informative; CostEstimate uses totalUsd==null to render a hint
      // like "pick a resolution to see cost".
      return {
        totalUsd: null,
        perSecondUsd: null,
        durationSeconds: null,
        basis: `≈ $${p.per_mp_usd}/megapixel — needs resolution + fps + duration`,
        exact: false,
        perMpUsd: p.per_mp_usd,
        missing: [
          !dims ? 'resolution' : null,
          !Number.isFinite(dur) || dur <= 0 ? 'duration' : null,
          !Number.isFinite(f) || f <= 0 ? 'fps' : null,
        ].filter(Boolean),
      };
    }
    const frames = Math.max(1, Math.round(dur * f));
    const mp = (dims[0] * dims[1] * frames) / 1_000_000;
    return {
      totalUsd: mp * p.per_mp_usd,
      perSecondUsd: null,
      durationSeconds: dur,
      basis:
        `$${p.per_mp_usd.toFixed(4)}/MP × ${mp.toFixed(1)}MP ` +
        `(${bundle.resolution} ${f}fps × ${dur}s = ${frames} frames)`,
      exact: !!p.exact,
      perMpUsd: p.per_mp_usd,
    };
  }

  if (p.kind === 'per_second' || p.kind === 'per_second_tiered') {
    if (!Number.isFinite(dur) || dur <= 0) return null;
    const tieredLookup = { ...lookup };
    if (p.kind === 'per_second_tiered') {
      if (!tieredLookup.resolution || tieredLookup.resolution === 'auto') {
        tieredLookup.resolution = p.default_resolution || tieredLookup.resolution;
      }
      if (tieredLookup.resolution) {
        tieredLookup.resolution = String(tieredLookup.resolution).toLowerCase();
      }
    }
    // For tiered pricing, prefer the rate that matches the user's
    // resolution; if no rate matches, fall back to the lowest-priced
    // tier so we never silently overestimate.
    let rate = pickRate(p.rates, tieredLookup);
    if (!rate && p.kind === 'per_second_tiered') {
      rate = (p.rates || []).reduce(
        (best, r) => (best == null || r.perSecondUsd < best.perSecondUsd ? r : best),
        null,
      );
    }
    if (!rate) rate = pickRate(p.rates, {});
    if (!rate) return null;
    return {
      totalUsd: rate.perSecondUsd * dur,
      perSecondUsd: rate.perSecondUsd,
      durationSeconds: dur,
      basis:
        `$${rate.perSecondUsd.toFixed(3)}/s × ${dur}s` +
        (tieredLookup.resolution ? ` @ ${tieredLookup.resolution}` : ''),
      exact: !!p.exact,
    };
  }
  return null;
}

export function formatUsd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
}
