// Decides whether the Kokoro worker should even probe for WebGPU.
// onnxruntime-web's WebGPU backend is developed against Blink; on WebKit it
// hangs or dies silently mid-inference — and EVERY iOS browser is WebKit
// (Chrome-on-iOS is "CriOS", Firefox is "FxiOS"; neither carries "Chrome/").
// So: only genuine Blink UAs may try WebGPU; everything else gets wasm/q8,
// which is also a ~92MB download instead of fp32's ~310MB.
export function preferWebGpu(ua) {
  const s = ua || '';
  if (!/Chrome\//.test(s)) return false; // Safari, CriOS, FxiOS, Firefox, Gecko
  if (/iPhone|iPad|iPod/.test(s)) return false; // any iOS shell, belt-and-braces
  return true;
}
