// Client-side price computation for the playground. The heavy lifting —
// parsing fal's pricing markdown — happened at catalog build time
// (scripts/lib/playgroundPricing.js); rows carry a structured `pricing`
// object and this module just applies the user's selections to it.
// Kept out of the React component so vitest can exercise it directly.

// fal's standard image_size enum → pixel dimensions.
const IMAGE_SIZE_DIMS = {
  square_hd: [1024, 1024],
  square: [512, 512],
  portrait_4_3: [768, 1024],
  portrait_16_9: [576, 1024],
  landscape_4_3: [1024, 768],
  landscape_16_9: [1024, 576],
};

// Resolution tags → 16:9 dimensions (aspect_ratio shifts totals slightly;
// good enough for a cost estimate).
const RES_DIMS = {
  '360p': [640, 360], '480p': [854, 480], '540p': [960, 540], '580p': [1024, 580],
  '720p': [1280, 720], '768p': [1366, 768], '1024p': [1820, 1024],
  '1080p': [1920, 1080], '1440p': [2560, 1440], '2160p': [3840, 2160], '4k': [3840, 2160],
};

export function formatUsd(v) {
  if (!Number.isFinite(v)) return null;
  if (v >= 0.995) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(v >= 0.001 ? 3 : 4)}`;
}

function durationFromSelections(selections = {}) {
  for (const name of ['duration', 'duration_seconds', 'video_duration']) {
    const raw = selections[name];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = parseFloat(String(raw).replace(/s$/i, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function megapixelsFromSelections(selections = {}) {
  const size = IMAGE_SIZE_DIMS[selections.image_size]
    || RES_DIMS[String(selections.resolution || '').toLowerCase()]
    || null;
  if (!size) return null;
  return (size[0] * size[1]) / 1e6;
}

function tierRate(pricing, selections = {}) {
  const wanted = String(selections.resolution || '').toLowerCase();
  const hit = (pricing.rates || []).find((r) => r.when?.resolution?.toLowerCase() === wanted);
  if (hit) return { rate: hit.perSecondUsd, matched: true };
  const min = Math.min(...(pricing.rates || []).map((r) => r.perSecondUsd));
  return Number.isFinite(min) ? { rate: min, matched: false } : null;
}

/**
 * → { totalUsd|null, exact, label, basis } or null when the row has no
 * structured pricing at all. totalUsd null = we know the rate but not the
 * quantity; label still carries the rate.
 */
export function estimatePlaygroundCost(model, { selections = {}, promptLength = 0 } = {}) {
  const pricing = model?.pricing;
  if (!pricing) return null;

  if (pricing.kind === 'per_image') {
    return {
      totalUsd: pricing.perImageUsd,
      exact: true,
      label: formatUsd(pricing.perImageUsd),
      basis: 'per image',
    };
  }

  if (pricing.kind === 'per_second' || pricing.kind === 'per_second_tiered') {
    const tiered = pricing.kind === 'per_second_tiered';
    const picked = tiered ? tierRate(pricing, selections) : { rate: pricing.perSecondUsd, matched: true };
    if (!picked) return null;
    const duration = durationFromSelections(selections);
    if (duration != null) {
      return {
        totalUsd: picked.rate * duration,
        exact: picked.matched,
        label: `${formatUsd(picked.rate * duration)} (${duration}s × ${formatUsd(picked.rate)}/s)`,
        basis: tiered ? 'per second, resolution tier' : 'per second',
      };
    }
    return {
      totalUsd: null,
      exact: false,
      label: `${formatUsd(picked.rate)}/s`,
      basis: 'per second (duration unknown)',
    };
  }

  if (pricing.kind === 'per_megapixel') {
    const mp = model?.output?.kind === 'image' ? megapixelsFromSelections(selections) : null;
    if (mp != null) {
      return {
        totalUsd: pricing.perMpUsd * mp,
        exact: false,
        label: `${formatUsd(pricing.perMpUsd * mp)} (~${mp.toFixed(2)} MP)`,
        basis: 'per megapixel',
      };
    }
    return { totalUsd: null, exact: false, label: `${formatUsd(pricing.perMpUsd)}/MP`, basis: 'per megapixel' };
  }

  if (pricing.kind === 'per_1k_chars') {
    const chars = Math.max(0, promptLength);
    return {
      totalUsd: (chars / 1000) * pricing.per1kCharsUsd,
      exact: true,
      label: `${formatUsd((chars / 1000) * pricing.per1kCharsUsd)} (${chars} chars)`,
      basis: 'per 1000 characters of prompt',
    };
  }

  if (pricing.kind === 'per_minute') {
    const duration = durationFromSelections(selections);
    if (duration != null) {
      const total = (duration / 60) * pricing.perMinuteUsd;
      return { totalUsd: total, exact: false, label: formatUsd(total), basis: 'per minute' };
    }
    return { totalUsd: null, exact: false, label: `${formatUsd(pricing.perMinuteUsd)}/min`, basis: 'per minute' };
  }

  if (pricing.kind === 'per_unit') {
    return {
      totalUsd: null,
      exact: false,
      label: `$${pricing.unitPriceUsd}/${pricing.unit}`,
      basis: pricing.basis || `per ${pricing.unit}`,
    };
  }

  if (pricing.kind === 'per_audio_second') {
    return {
      totalUsd: null,
      exact: false,
      label: `${formatUsd(pricing.perAudioSecondUsd)}/audio-s`,
      basis: 'per second of generated audio',
    };
  }

  if (pricing.kind === 'flat_per_clip') {
    return { totalUsd: pricing.flatUsd, exact: false, label: `~${formatUsd(pricing.flatUsd)}`, basis: 'flat (best-effort)' };
  }

  return null;
}

// The cheapest configuration the model offers: shortest duration option and
// smallest output size. Used to price list rows as "from $X".
export function minimalSelections(model) {
  const sel = {};
  for (const c of model?.controls || []) {
    if (['duration', 'duration_seconds', 'video_duration'].includes(c.name)) {
      if (c.type === 'enum') {
        const nums = c.options
          .map((o) => parseFloat(String(o).replace(/s$/i, '')))
          .filter((n) => Number.isFinite(n) && n > 0);
        if (nums.length) sel[c.name] = Math.min(...nums);
      } else if (c.type === 'int' && c.min != null) {
        sel[c.name] = c.min;
      } else if (c.type === 'int' && c.default != null) {
        sel[c.name] = c.default;
      }
    } else if (c.name === 'image_size' && c.type === 'enum') {
      const sized = c.options.filter((o) => IMAGE_SIZE_DIMS[o]);
      if (sized.length) {
        sel.image_size = sized.reduce((a, b) =>
          (IMAGE_SIZE_DIMS[a][0] * IMAGE_SIZE_DIMS[a][1] <= IMAGE_SIZE_DIMS[b][0] * IMAGE_SIZE_DIMS[b][1] ? a : b));
      }
    } else if (c.name === 'resolution' && c.type === 'enum') {
      const sized = c.options.filter((o) => RES_DIMS[String(o).toLowerCase()]);
      if (sized.length) {
        sel.resolution = sized.reduce((a, b) => {
          const da = RES_DIMS[String(a).toLowerCase()];
          const db = RES_DIMS[String(b).toLowerCase()];
          return da[0] * da[1] <= db[0] * db[1] ? a : b;
        });
      }
    }
  }
  return sel;
}

// Compact price for a model-list row: a computed smallest-configuration
// total ("from $0.42") when the pricing depends on size/duration and the
// model's controls tell us the minimum, otherwise a per-unit rate.
export function rowPriceLabel(model) {
  const pricing = model?.pricing;
  if (pricing) {
    // Size/duration-dependent kinds: try the cheapest configuration first.
    if (['per_second', 'per_second_tiered', 'per_megapixel', 'per_minute'].includes(pricing.kind)) {
      const est = estimatePlaygroundCost(model, { selections: minimalSelections(model) });
      if (est?.totalUsd != null) return `from ${formatUsd(est.totalUsd)}`;
    }
    switch (pricing.kind) {
      case 'per_image': return `${formatUsd(pricing.perImageUsd)}/image`;
      case 'per_second': return `${formatUsd(pricing.perSecondUsd)}/s`;
      case 'per_second_tiered': {
        const rates = (pricing.rates || []).map((r) => r.perSecondUsd);
        const lo = Math.min(...rates);
        const hi = Math.max(...rates);
        return lo === hi ? `${formatUsd(lo)}/s` : `${formatUsd(lo)}–${formatUsd(hi)}/s`;
      }
      case 'per_1k_chars': return `${formatUsd(pricing.per1kCharsUsd)}/1k chars`;
      case 'per_audio_second': return `${formatUsd(pricing.perAudioSecondUsd)}/audio-s`;
      case 'per_minute': return `${formatUsd(pricing.perMinuteUsd)}/min`;
      case 'per_megapixel': return `$${pricing.perMpUsd}/MP`;
      case 'per_unit': return `$${pricing.unitPriceUsd}/${pricing.unit}`;
      case 'flat_per_clip': return `~${formatUsd(pricing.flatUsd)}`;
      default: break;
    }
  }
  if (Number.isFinite(model?.price_min_usd)) return `from ${formatUsd(model.price_min_usd)}`;
  return 'pricing varies';
}
