// What Admin → Models offers for the coding-agent providers: whether they are
// enabled on this server, each provider's effort levels, and model
// suggestions (free text is always accepted). Codex suggestions come from the
// host's mounted ~/.codex/models_cache.json, which carries per-model efforts.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../../config.js';
import { HARNESS_PROVIDERS } from '../modelSlots.js';

async function codexCachedModels() {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(os.homedir(), '.codex', 'models_cache.json'), 'utf8'));
    return (Array.isArray(raw?.models) ? raw.models : [])
      .filter((m) => typeof m?.slug === 'string')
      .map((m) => ({
        id: m.slug,
        label: m.display_name || m.slug,
        efforts: Array.isArray(m.supported_reasoning_levels)
          ? m.supported_reasoning_levels.map((l) => l?.effort).filter(Boolean)
          : null,
        default_effort: m.default_reasoning_level || null,
      }));
  } catch {
    return [];
  }
}

export async function describeHarnessProviders() {
  const codexModels = await codexCachedModels();
  return {
    enabled: config.llmHarness.enabled,
    providers: HARNESS_PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      efforts: p.efforts,
      models: p.id === 'codex' ? codexModels : p.models.map((id) => ({ id, label: id, efforts: null })),
    })),
  };
}
