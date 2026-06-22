// Per-endpoint maximum reference-image counts for fal image-edit endpoints.
// Kept in a dependency-free leaf module so consumers that only need the numbers
// (e.g. src/web/imageModelInfo.js) can read them without importing the fal SDK,
// and so test files that mock ../fal/imageClient.js don't have to redeclare them.
// imageClient.js re-exports these; this module is the single source of truth.
export const FLUX_2_PRO_EDIT_MAX_INPUTS = 9;
export const NANO_BANANA_PRO_EDIT_MAX_INPUTS = 14;
export const GEMINI_25_FLASH_EDIT_MAX_INPUTS = 10;
export const NANO_BANANA_2_EDIT_MAX_INPUTS = 10;
export const FLUX_2_KLEIN_EDIT_MAX_INPUTS = 4;
