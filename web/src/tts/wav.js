// Float32 PCM chunks → one 16-bit mono WAV Blob (the "single file" a finished
// read-through is saved as).

export function encodeWav(chunks, sampleRate) {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const ascii = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++, offset += 2) {
      const v = Math.max(-1, Math.min(1, chunk[i] || 0));
      view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
