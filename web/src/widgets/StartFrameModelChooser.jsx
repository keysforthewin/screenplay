import { useState } from 'react';
import { ImageModelSelect } from './ImageModelSelect.jsx';
import { ComfyImageModelPicker } from './ComfyImageModelPicker.jsx';
import { readStoredCatalogModel, writeStoredImageModel } from './imageModels.js';

// Which model renders a cut's frame — shared by the start-frame and end-frame
// panels (CutFramePanel), so both remember the same choice. Two providers: fal.ai (the hosted catalog)
// or a local ComfyUI model that takes the cut's reference artwork (image
// model id `comfy:<id>`, with its own render parameters).

const MODEL_STORAGE_KEY = 'screenplay.cut.startFrameModel';
const PROVIDER_STORAGE_KEY = 'screenplay.cut.startFrameProvider';
const COMFY_MODEL_STORAGE_KEY = 'screenplay.cut.startFrameComfyModel';
const COMFY_PARAMS_STORAGE_KEY = 'screenplay.cut.startFrameComfyParams';

function readStored(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

// Per-model render parameters ({ 'comfy:<id>': { width, height, steps… } }),
// remembered so a tuned setup survives the next cut. The seed is not kept: a
// remembered seed would silently make every frame the same draw.
function readStoredComfyParams() {
  try {
    const v = JSON.parse(localStorage.getItem(COMFY_PARAMS_STORAGE_KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// State for the chooser. `requestFields()` is what a start-frame request
// carries ({image_model, comfy_params?}); `remember()` persists the choice
// once a render was actually started with it.
export function useStartFrameModel() {
  const [imageModel, setImageModel] = useState(() => readStoredCatalogModel(MODEL_STORAGE_KEY));
  const [provider, setProvider] = useState(() => (readStored(PROVIDER_STORAGE_KEY, 'fal') === 'comfy' ? 'comfy' : 'fal'));
  const [comfyModel, setComfyModel] = useState(() => readStored(COMFY_MODEL_STORAGE_KEY, ''));
  const [comfyParamsByModel, setComfyParamsByModel] = useState(readStoredComfyParams);
  const [comfyInfo, setComfyInfo] = useState(null); // { configured, reason, count }
  const useComfy = provider === 'comfy';
  const comfyParams = comfyParamsByModel[comfyModel] || {};
  return {
    provider, setProvider, useComfy,
    imageModel, setImageModel,
    comfyModel, setComfyModel,
    comfyParams,
    setComfyParams: (next) => setComfyParamsByModel((all) => ({ ...all, [comfyModel]: next })),
    setComfyInfo,
    ready: useComfy ? Boolean(comfyInfo?.configured && comfyModel) : Boolean(imageModel),
    requestFields() {
      return useComfy ? { image_model: comfyModel, comfy_params: comfyParams } : { image_model: imageModel || null };
    },
    remember() {
      try {
        localStorage.setItem(PROVIDER_STORAGE_KEY, provider);
        if (useComfy) {
          const { seed, ...kept } = comfyParams;
          localStorage.setItem(COMFY_MODEL_STORAGE_KEY, comfyModel);
          localStorage.setItem(COMFY_PARAMS_STORAGE_KEY, JSON.stringify({ ...comfyParamsByModel, [comfyModel]: kept }));
        }
      } catch {}
      if (!useComfy) writeStoredImageModel(MODEL_STORAGE_KEY, imageModel);
    },
  };
}

// The provider toggle and the model list under it. Fills its parent's height
// (the parent is a flex column); `referenceCount` and `mode` only inform the
// ComfyUI rows' notes and parameters.
export function StartFrameModelChooser({ state, disabled = false, referenceCount = 0, mode = 'generate', requireReferences = false }) {
  const { useComfy } = state;
  return (
    <>
      <div className="cut-sf-provider" role="tablist" aria-label="Image provider">
        <button type="button" role="tab" aria-selected={!useComfy} className={!useComfy ? 'is-active' : ''} disabled={disabled} onClick={() => state.setProvider('fal')}>
          fal.ai <span>hosted · paid per image</span>
        </button>
        <button type="button" role="tab" aria-selected={useComfy} className={useComfy ? 'is-active' : ''} disabled={disabled} onClick={() => state.setProvider('comfy')}>
          ComfyUI <span>local GPU · free</span>
        </button>
      </div>
      <div className="cut-sf-model">
        {useComfy ? (
          <ComfyImageModelPicker
            value={state.comfyModel}
            onChange={state.setComfyModel}
            params={state.comfyParams}
            onParamsChange={state.setComfyParams}
            referenceCount={referenceCount}
            mode={mode}
            disabled={disabled}
            onAvailability={state.setComfyInfo}
          />
        ) : (
          <ImageModelSelect value={state.imageModel} onChange={state.setImageModel} disabled={disabled} requireReferences={requireReferences} />
        )}
      </div>
    </>
  );
}
