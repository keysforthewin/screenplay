import { describe, it, expect } from 'vitest';
import { preferWebGpu } from '../web/src/tts/ttsDevice.js';

const UA = {
  chromeLinux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.68',
  chromeIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
  safariIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  firefox:
    'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
};

describe('preferWebGpu', () => {
  it('allows real Blink browsers', () => {
    expect(preferWebGpu(UA.chromeLinux)).toBe(true);
    expect(preferWebGpu(UA.chromeAndroid)).toBe(true);
    expect(preferWebGpu(UA.edgeWindows)).toBe(true);
  });

  it('rejects every iOS browser — they are all WebKit shells', () => {
    expect(preferWebGpu(UA.chromeIos)).toBe(false);
    expect(preferWebGpu(UA.safariIos)).toBe(false);
  });

  it('rejects Safari and Firefox', () => {
    expect(preferWebGpu(UA.safariMac)).toBe(false);
    expect(preferWebGpu(UA.firefox)).toBe(false);
  });

  it('rejects an empty/missing UA', () => {
    expect(preferWebGpu('')).toBe(false);
    expect(preferWebGpu(undefined)).toBe(false);
  });
});
