/**
 * Build-time parse of fal's pricing markdown into a structured object stored
 * per catalog row, so the SPA can compute an accurate price from the user's
 * actual selections (size, duration, prompt length) with plain arithmetic.
 *
 * Image/audio-specific patterns are matched first; everything else delegates
 * to the video pipeline's shared parser (per_second, per_second_tiered,
 * per_megapixel, flat_per_clip).
 */
import { parseCatalogPriceText } from '../../src/fal/videoPricing.js';

export function parsePlaygroundPricing(priceText) {
  if (typeof priceText !== 'string' || !priceText) return null;
  const t = priceText;

  // "$X per image" / "$X per generated image" / "each image costs $X".
  // \**: fal wraps prices in markdown bold ("**$0.08** per image").
  const perImage = /\$(\d+(?:\.\d+)?)\**\s*(?:\/|per)\s*(?:generated\s+)?image\b/i.exec(t)
    || /image\s+costs?\s*\**\$(\d+(?:\.\d+)?)/i.exec(t);
  if (perImage) {
    return { kind: 'per_image', perImageUsd: parseFloat(perImage[1]), basis: 'per image (parsed)' };
  }

  // "For $1.00, you can generate 25 images" → derive the unit price.
  const bulk = /for\s*\**\$(\d+(?:\.\d+)?)\**[,.]?\s*you\s+can\s+generate\s+(\d+)\s+images/i.exec(t);
  if (bulk) {
    const total = parseFloat(bulk[1]);
    const count = parseInt(bulk[2], 10);
    if (count > 0) {
      return { kind: 'per_image', perImageUsd: total / count, basis: `derived from ${count} images per $${total}` };
    }
  }

  // TTS: "$X per 1000 characters" (also "1,000").
  const perChars = /\$(\d+(?:\.\d+)?)\**\s*(?:\/|per)\s*1[,.]?000\s*characters/i.exec(t);
  if (perChars) {
    return { kind: 'per_1k_chars', per1kCharsUsd: parseFloat(perChars[1]), basis: 'per 1000 characters (parsed)' };
  }

  // Audio/music: "$X per minute".
  const perMinute = /\$(\d+(?:\.\d+)?)\**\s*(?:\/|per)\s*minute\b/i.exec(t);
  if (perMinute) {
    return { kind: 'per_minute', perMinuteUsd: parseFloat(perMinute[1]), basis: 'per minute (parsed)' };
  }

  // "$X per audio second" / "**0.002** per generated **audio seconds**" —
  // output-audio duration isn't known up front, so this is a rate, not a
  // total. Currency sign is optional/misplaced in several fal texts.
  const perAudioSecond = /\$?(\d+(?:\.\d+)?)\s*\$?\**\s*(?:\/|per)\s*(?:generated\s+)?\**audio\s+seconds?\b/i.exec(t);
  if (perAudioSecond) {
    return {
      kind: 'per_audio_second',
      perAudioSecondUsd: parseFloat(perAudioSecond[1]),
      basis: 'per second of generated audio (parsed)',
    };
  }

  // Currency-after-number per-second: "0.1$ per output video second".
  const perSecondAfter = /(\d+(?:\.\d+)?)\s*\$\**\s*(?:\/|per)\s*(?:output\s+)?(?:video\s+)?second\b/i.exec(t);
  if (perSecondAfter) {
    return {
      kind: 'per_second',
      perSecondUsd: parseFloat(perSecondAfter[1]),
      basis: 'per second (parsed, trailing currency)',
      exact: false,
    };
  }

  // "$X per video" — a flat clip price.
  const perVideo = /\$?(\d+(?:\.\d+)?)\s*\$?\**\s*(?:\/|per)\s*video\b(?!\s*second)/i.exec(t);
  if (perVideo) {
    return {
      kind: 'flat_per_clip',
      flatUsd: parseFloat(perVideo[1]),
      basis: 'per video (parsed)',
      exact: false,
    };
  }

  return parseCatalogPriceText(t);
}

/**
 * Map a machine-pricing row from GET https://api.fal.ai/v1/models/pricing
 * ({ endpoint_id, unit_price, unit, currency }) onto the same structured
 * kinds the text parser emits. Machine prices are authoritative, so exact
 * quantity units get `exact: true`. Opaque units (compute seconds, tokens,
 * credits) become a rate-only `per_unit` — honest, but not totalable.
 */
export function pricingFromMachine(row) {
  const price = Number(row?.unit_price);
  if (!Number.isFinite(price) || price <= 0) return null;
  const unit = String(row.unit || '').toLowerCase().trim();
  const basis = `fal machine pricing (per ${unit})`;

  if (unit === 'megapixels' || unit === 'processed megapixels') {
    return { kind: 'per_megapixel', perMpUsd: price, basis, exact: true };
  }
  if (unit === 'images' || unit === 'image') {
    return { kind: 'per_image', perImageUsd: price, basis, exact: true };
  }
  if (unit === 'seconds' || unit === 'second') {
    return { kind: 'per_second', perSecondUsd: price, basis, exact: true };
  }
  const nSeconds = /^(\d+)\s*seconds$/.exec(unit);
  if (nSeconds) {
    return { kind: 'per_second', perSecondUsd: price / parseInt(nSeconds[1], 10), basis, exact: true };
  }
  if (unit === 'minutes' || unit === 'minute') {
    return { kind: 'per_minute', perMinuteUsd: price, basis, exact: true };
  }
  if (unit === '1000 characters') {
    return { kind: 'per_1k_chars', per1kCharsUsd: price, basis, exact: true };
  }
  if (unit === 'videos' || unit === 'video' || unit === 'generations' || unit === 'generation' || unit === '1') {
    return { kind: 'flat_per_clip', flatUsd: price, basis, exact: true };
  }

  const UNIT_LABELS = {
    'compute seconds': 'compute-s',
    '1000 tokens': '1k tokens',
    '1m tokens': '1M tokens',
    credits: 'credit',
    units: 'unit',
  };
  return { kind: 'per_unit', unitPriceUsd: price, unit: UNIT_LABELS[unit] || unit, basis };
}

/**
 * Combine text-parsed and machine pricing. Machine numbers win (they're
 * billing-system truth), except a text-parsed tier table is richer than a
 * single machine rate and keeps resolution awareness.
 */
export function mergePricing(textPricing, machinePricing) {
  if (textPricing?.kind === 'per_second_tiered') return textPricing;
  return machinePricing || textPricing || null;
}
