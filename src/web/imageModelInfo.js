// Single source of truth for image-generation model metadata. The per-endpoint
// reference caps are imported from the fal client so they cannot drift; the
// rest (resolution, input formats, speed) is curated copy for the model picker.
// Consumed by GET /api/image-models (SPA display) and by the bulk frame
// reference auto-fill clamp (src/web/frameReferences.js).

import {
  FLUX_2_PRO_EDIT_MAX_INPUTS,
  NANO_BANANA_PRO_EDIT_MAX_INPUTS,
  GEMINI_25_FLASH_EDIT_MAX_INPUTS,
  NANO_BANANA_2_EDIT_MAX_INPUTS,
  FLUX_2_KLEIN_EDIT_MAX_INPUTS,
} from '../fal/imageCaps.js';

// OpenAI gpt-image-2 edit accepts multiple input images (image[] array); the
// practical edit maximum is 16. Defined here since it isn't a fal endpoint.
const OPENAI_EDIT_MAX_INPUTS = 16;

// Flux Pro Kontext single-image endpoint takes 1 ref; the /multi endpoint takes
// several. We advertise the higher number the pipeline can actually drive.
const FLUX_KONTEXT_MAX_INPUTS = 4;

const PNG_JPEG_WEBP = ['PNG', 'JPEG', 'WebP'];

export const DEFAULT_MAX_REFERENCE_IMAGES = 6;

// Order here defines display order in the picker and the API response.
export const IMAGE_MODEL_INFO = {
  'nano-banana-pro': {
    id: 'nano-banana-pro',
    label: 'Nano Banana Pro (Gemini 3 Pro)',
    family: 'Gemini 3 Pro Image',
    maxReferenceImages: NANO_BANANA_PRO_EDIT_MAX_INPUTS,
    resolution: 'up to 4K, aspect-driven (16:9 ≈ 2048×1152)',
    inputFormats: PNG_JPEG_WEBP,
    speed: 'standard',
  },
  'flux-2-pro': {
    id: 'flux-2-pro',
    label: 'Flux 2 Pro',
    family: 'FLUX.2 Pro',
    maxReferenceImages: FLUX_2_PRO_EDIT_MAX_INPUTS,
    resolution: 'aspect-driven (16:9 ≈ 2048×1152)',
    inputFormats: PNG_JPEG_WEBP,
    speed: 'standard',
  },
  'flux-pro-kontext': {
    id: 'flux-pro-kontext',
    label: 'Flux Pro Kontext',
    family: 'FLUX.1 Kontext',
    maxReferenceImages: FLUX_KONTEXT_MAX_INPUTS,
    resolution: 'aspect-driven (16:9 ≈ 2048×1152)',
    inputFormats: PNG_JPEG_WEBP,
    speed: 'standard',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI (gpt-image-2)',
    family: 'gpt-image-2',
    maxReferenceImages: OPENAI_EDIT_MAX_INPUTS,
    resolution: 'up to 3840×2160 (auto-selected)',
    inputFormats: PNG_JPEG_WEBP,
    speed: 'standard',
  },
  'gemini-25-flash': {
    id: 'gemini-25-flash',
    label: 'Gemini 2.5 Flash (fast)',
    family: 'Gemini 2.5 Flash Image',
    maxReferenceImages: GEMINI_25_FLASH_EDIT_MAX_INPUTS,
    resolution: 'aspect-driven (16:9 ≈ 2048×1152)',
    inputFormats: PNG_JPEG_WEBP,
    speed: 'fast',
  },
  'nano-banana-2': {
    id: 'nano-banana-2',
    label: 'Nano Banana 2 (Gemini 3.1 Flash)',
    family: 'Gemini 3.1 Flash Image',
    maxReferenceImages: NANO_BANANA_2_EDIT_MAX_INPUTS,
    resolution: 'aspect-driven (16:9 ≈ 2048×1152)',
    inputFormats: PNG_JPEG_WEBP,
    speed: 'fast',
  },
  'flux-2-klein': {
    id: 'flux-2-klein',
    label: 'Flux 2 Klein (fast)',
    family: 'FLUX.2 [klein] 9B',
    maxReferenceImages: FLUX_2_KLEIN_EDIT_MAX_INPUTS,
    resolution: '2048×1152 (16:9), explicit pixel size',
    inputFormats: PNG_JPEG_WEBP,
    speed: 'fast (distilled 4-step)',
  },
};

export function listImageModelInfo() {
  return Object.values(IMAGE_MODEL_INFO);
}

export function maxReferenceImagesFor(modelId) {
  const info = IMAGE_MODEL_INFO[modelId];
  return info ? info.maxReferenceImages : DEFAULT_MAX_REFERENCE_IMAGES;
}
