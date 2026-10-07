// The default video renderer (Admin → Video renderer): one provider + model
// for every cut video rendered without an explicit choice. Every entry point
// that renders a cut's clip — the per-cut ComfyUI and fal routes, the
// whole-beat batch, the MCP `render_videos` tool — resolves its model here,
// so a caller that names nothing (a coding agent, a skill) renders with what
// the admin picked instead of the first model in a list.

import { getVideoDefaultSettings, setVideoDefaultSettings, VIDEO_DEFAULT_PROVIDERS } from '../mongo/appSettings.js';
import { getComfyVideoModel, listComfyVideoModels } from '../comfy/videoModels.js';

export class VideoDefaultError extends Error {
  constructor(message, { status = 400, code = 'VIDEO_DEFAULT' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const NO_VIDEO_DEFAULT_MESSAGE =
  'model_id required: no model was named and no default video renderer is set (Admin → Video renderer).';

// { provider, modelId, params, fromDefault } — the explicit choice when the
// caller made one, the admin default otherwise. `provider` may be omitted by
// the caller only when it falls back to the default (a bare model id is
// ambiguous between the two registries), except that a model id known to the
// ComfyUI registry is taken as ComfyUI.
export async function resolveVideoRenderer({ provider = null, modelId = null } = {}) {
  const id = typeof modelId === 'string' && modelId.trim() ? modelId.trim() : null;
  if (id) {
    let p = provider;
    if (!p) p = getComfyVideoModel(id) ? 'comfy' : 'fal';
    if (!VIDEO_DEFAULT_PROVIDERS.includes(p)) throw new VideoDefaultError('provider must be "comfy" or "fal"');
    return { provider: p, modelId: id, params: {}, fromDefault: false };
  }
  const d = await getVideoDefaultSettings();
  if (!d.model_id) throw new VideoDefaultError(NO_VIDEO_DEFAULT_MESSAGE, { code: 'NO_VIDEO_DEFAULT' });
  if (provider && provider !== d.provider) {
    throw new VideoDefaultError(
      `model_id required: the default video renderer is a ${d.provider} model (${d.model_id}), not ${provider}.`,
      { code: 'NO_VIDEO_DEFAULT' },
    );
  }
  return { provider: d.provider, modelId: d.model_id, params: { ...d.params }, fromDefault: true };
}

// What the Admin page shows and the Scenes tab reads: the stored default plus,
// for a ComfyUI default, whether that model is still in the registry and
// whether it bills Comfy credits (the batch then needs confirm_spend).
export async function describeVideoDefault() {
  const d = await getVideoDefaultSettings();
  let label = d.model_id;
  let known = d.model_id ? true : null;
  let spendsCredits = d.provider === 'fal' && !!d.model_id;
  if (d.provider === 'comfy' && d.model_id) {
    const m = getComfyVideoModel(d.model_id);
    known = !!m;
    if (m) label = m.label;
    spendsCredits = !!m?.spends_credits;
  }
  return { ...d, label, known, spends_credits: spendsCredits };
}

// Admin PUT: validate the model against its provider's registry, then store.
export async function updateVideoDefault(value, { updatedBy = null } = {}) {
  if (value && value.model_id) {
    if (value.provider === 'comfy' && !getComfyVideoModel(value.model_id)) {
      const ids = listComfyVideoModels().map((m) => m.id);
      throw new VideoDefaultError(`unknown ComfyUI model "${value.model_id}" (known: ${ids.join(', ')})`);
    }
    if (value.provider === 'fal') {
      const { resolveVideoModelByAnyId } = await import('../fal/videoModels.js');
      const m = await resolveVideoModelByAnyId(value.model_id).catch(() => null);
      if (!m) throw new VideoDefaultError(`unknown fal.ai video model "${value.model_id}"`);
      value = { ...value, model_id: m.id || value.model_id };
    }
  }
  try {
    await setVideoDefaultSettings(value, { updatedBy });
  } catch (e) {
    throw new VideoDefaultError(e.message);
  }
  return describeVideoDefault();
}
