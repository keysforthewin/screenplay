import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Bytes = await import('../src/mongo/attachmentBytes.js');
const Bucket = await import('../src/mongo/attachments.js');

beforeEach(() => {
  fakeDb.reset();
});

const TEXT_BYTES = Buffer.from('hello world', 'utf8');
function bufToAB(buf) {
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  return ab;
}

describe('fetchAttachmentFromUrl', () => {
  let fetchSpy;
  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('rejects non-HTTP(S) URLs', async () => {
    await expect(Bytes.fetchAttachmentFromUrl('ftp://example.com/x.txt')).rejects.toThrow(
      /Unsupported URL scheme/,
    );
  });

  it('rejects malformed URLs', async () => {
    await expect(Bytes.fetchAttachmentFromUrl('not a url')).rejects.toThrow(/Invalid URL/);
  });

  it('returns buffer + sniffed content_type from the response', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {
        get: (k) => (k.toLowerCase() === 'content-type' ? 'audio/ogg; codecs=vorbis' : null),
      },
      arrayBuffer: async () => bufToAB(TEXT_BYTES),
    });
    const { buffer, contentType, size } = await Bytes.fetchAttachmentFromUrl(
      'https://cdn.example.com/clip.ogg',
    );
    expect(buffer.equals(TEXT_BYTES)).toBe(true);
    expect(contentType).toBe('audio/ogg');
    expect(size).toBe(TEXT_BYTES.length);
  });

  it('honors a hinted content type when provided (overrides response header)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'application/octet-stream' },
      arrayBuffer: async () => bufToAB(TEXT_BYTES),
    });
    const { contentType } = await Bytes.fetchAttachmentFromUrl(
      'https://cdn.example.com/clip.ogg',
      'audio/ogg',
    );
    expect(contentType).toBe('audio/ogg');
  });

  it('falls back to application/octet-stream when no content-type is provided', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      arrayBuffer: async () => bufToAB(TEXT_BYTES),
    });
    const { contentType } = await Bytes.fetchAttachmentFromUrl('https://cdn.example.com/x');
    expect(contentType).toBe('application/octet-stream');
  });

  it('rejects empty (0-byte) downloads', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'audio/ogg' },
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(
      Bytes.fetchAttachmentFromUrl('https://cdn.example.com/empty.ogg'),
    ).rejects.toThrow(/empty/i);
  });

  it('rejects bytes larger than MAX_ATTACHMENT_BYTES', async () => {
    const huge = Buffer.alloc(Bytes.MAX_ATTACHMENT_BYTES + 1);
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'video/mp4' },
      arrayBuffer: async () => bufToAB(huge),
    });
    await expect(
      Bytes.fetchAttachmentFromUrl('https://cdn.example.com/huge.mp4'),
    ).rejects.toThrow(/too large/);
  });

  it('surfaces non-OK responses', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(
      Bytes.fetchAttachmentFromUrl('https://cdn.example.com/missing.ogg'),
    ).rejects.toThrow(/404/);
  });
});

describe('deriveAttachmentFilename', () => {
  it('uses the URL basename when it has an extension', () => {
    expect(
      Bytes.deriveAttachmentFilename('https://cdn.discord.com/u/123/recording.ogg', 'audio/ogg'),
    ).toBe('recording.ogg');
  });

  it('falls back to attachment.<subtype> when URL has no usable basename', () => {
    expect(Bytes.deriveAttachmentFilename('https://cdn.discord.com/', 'audio/ogg')).toBe(
      'attachment.ogg',
    );
  });

  it('falls back to attachment.bin for unknown content type', () => {
    expect(Bytes.deriveAttachmentFilename('https://cdn.discord.com/', null)).toBe(
      'attachment.bin',
    );
  });
});

function seedFile({ id, ownerType = null, ownerId = null, contentType = 'audio/ogg' }) {
  const doc = {
    _id: id || new ObjectId(),
    filename: 'clip.ogg',
    contentType,
    length: 100,
    uploadDate: new Date(),
    metadata: {
      owner_type: ownerType,
      owner_id: ownerId,
      source: 'upload',
      content_type: contentType,
    },
  };
  fakeDb.collection('attachments.files')._docs.push(doc);
  return doc;
}

describe('attachments bucket helpers', () => {
  it('listAttachmentsForBeat filters by owner_type and owner_id', async () => {
    const beatA = new ObjectId();
    const beatB = new ObjectId();
    seedFile({ ownerType: 'beat', ownerId: beatA });
    seedFile({ ownerType: 'beat', ownerId: beatA });
    seedFile({ ownerType: 'beat', ownerId: beatB });

    const aFiles = await Bucket.listAttachmentsForBeat(beatA);
    expect(aFiles).toHaveLength(2);
    for (const f of aFiles) expect(f.metadata.owner_id.equals(beatA)).toBe(true);
  });

  it('listAttachmentsForCharacter filters by character ownership', async () => {
    const charA = new ObjectId();
    const charB = new ObjectId();
    seedFile({ ownerType: 'character', ownerId: charA });
    seedFile({ ownerType: 'character', ownerId: charB });

    const aFiles = await Bucket.listAttachmentsForCharacter(charA);
    expect(aFiles).toHaveLength(1);
    expect(aFiles[0].metadata.owner_id.equals(charA)).toBe(true);
  });

  it('setAttachmentOwner moves ownership', async () => {
    const file = seedFile({ ownerType: null, ownerId: null });
    const beatId = new ObjectId();

    await Bucket.setAttachmentOwner(file._id, { ownerType: 'beat', ownerId: beatId });
    const after = await Bucket.findAttachmentFile(file._id);
    expect(after.metadata.owner_type).toBe('beat');
    expect(after.metadata.owner_id.equals(beatId)).toBe(true);
  });

  it('attachmentFileToMeta extracts the right fields', () => {
    const file = {
      _id: new ObjectId(),
      filename: 'recording.ogg',
      contentType: 'audio/ogg',
      length: 5432,
      uploadDate: new Date('2026-01-01'),
      metadata: { owner_type: 'beat', owner_id: new ObjectId(), source: 'upload' },
    };
    const meta = Bucket.attachmentFileToMeta(file);
    expect(meta.filename).toBe('recording.ogg');
    expect(meta.content_type).toBe('audio/ogg');
    expect(meta.size).toBe(5432);
    expect(meta.source).toBe('upload');
  });
});

describe('docToLlmMessage attachment placeholders', () => {
  it('renders [user attached file: ...] for non-image attachments', async () => {
    const { docToLlmMessage } = await import('../src/mongo/messages.js');
    const out = docToLlmMessage({
      role: 'user',
      content: 'use this',
      attachments: [
        { url: 'a', filename: 'recording.ogg', content_type: 'audio/ogg', size: 5432 },
      ],
    });
    expect(out.role).toBe('user');
    expect(out.content).toEqual([
      { type: 'text', text: '[user attached file: recording.ogg (audio/ogg)]' },
      { type: 'text', text: 'use this' },
    ]);
  });

  it('mixed image + file attachments produce both placeholder shapes', async () => {
    const { docToLlmMessage } = await import('../src/mongo/messages.js');
    const out = docToLlmMessage({
      role: 'user',
      content: 'mixed',
      attachments: [
        { url: 'a', filename: 'a.png', content_type: 'image/png', size: 1 },
        { url: 'b', filename: 'b.ogg', content_type: 'audio/ogg', size: 2 },
      ],
    });
    expect(out.content).toEqual([
      { type: 'text', text: '[user attached image]' },
      { type: 'text', text: '[user attached file: b.ogg (audio/ogg)]' },
      { type: 'text', text: 'mixed' },
    ]);
  });
});

// ----- Handler-level tests (Attachments module mocked) -----

vi.mock('../src/mongo/attachments.js', async () => {
  const actual = await vi.importActual('../src/mongo/attachments.js');
  return {
    ...actual,
    uploadAttachmentFromUrl: vi.fn(),
    deleteAttachment: vi.fn(),
    attachToCharacter: vi.fn(),
    listCharacterAttachments: vi.fn(),
    removeCharacterAttachment: vi.fn(),
  };
});

const Attachments = await import('../src/mongo/attachments.js');
const { HANDLERS } = await import('../src/agent/handlers.js');
const Plots = await import('../src/mongo/plots.js');

async function seedBeat() {
  const beat = await Plots.createBeat({ name: 'Diner Scene', desc: 'They meet at the diner.' });
  return beat;
}

describe('beat attachment handlers', () => {
  beforeEach(() => {
    Attachments.uploadAttachmentFromUrl.mockReset();
    Attachments.deleteAttachment.mockReset();
  });

  it('add_beat_attachment uploads, attaches to the beat, and returns metadata', async () => {
    const beat = await seedBeat();
    const fakeId = new ObjectId();
    Attachments.uploadAttachmentFromUrl.mockResolvedValue({
      _id: fakeId,
      filename: 'recording.ogg',
      content_type: 'audio/ogg',
      size: 5432,
      uploaded_at: new Date(),
    });
    const out = await HANDLERS.add_beat_attachment({
      beat: beat._id.toString(),
      source_url: 'https://cdn.discord.com/x/recording.ogg',
      caption: 'use at PAULY IS FULL DEEP',
    });
    expect(Attachments.uploadAttachmentFromUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceUrl: 'https://cdn.discord.com/x/recording.ogg',
        ownerType: 'beat',
      }),
    );
    expect(out).toMatch(/Added attachment to beat "Diner Scene"/);
    expect(out).toContain('recording.ogg');
    expect(out).toContain('use at PAULY IS FULL DEEP');

    const after = await Plots.getBeat(beat._id.toString());
    expect(after.attachments).toHaveLength(1);
    expect(after.attachments[0].filename).toBe('recording.ogg');
    expect(after.attachments[0].caption).toBe('use at PAULY IS FULL DEEP');
  });

  it('list_beat_attachments returns attachments on the beat', async () => {
    const beat = await seedBeat();
    const fakeId = new ObjectId();
    Attachments.uploadAttachmentFromUrl.mockResolvedValue({
      _id: fakeId,
      filename: 'a.ogg',
      content_type: 'audio/ogg',
      size: 1,
      uploaded_at: new Date(),
    });
    await HANDLERS.add_beat_attachment({
      beat: beat._id.toString(),
      source_url: 'https://x.test/a.ogg',
    });
    const raw = await HANDLERS.list_beat_attachments({ beat: beat._id.toString() });
    const out = JSON.parse(raw.replace(/\nEdit in browser:.*$/s, ''));
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments[0].filename).toBe('a.ogg');
    expect(raw).toMatch(/Edit in browser: http:\/\/localhost:3000\/beat\/\d+/);
  });

  it('remove_beat_attachment pulls from beat and calls deleteAttachment', async () => {
    const beat = await seedBeat();
    const fakeId = new ObjectId();
    Attachments.uploadAttachmentFromUrl.mockResolvedValue({
      _id: fakeId,
      filename: 'a.ogg',
      content_type: 'audio/ogg',
      size: 1,
      uploaded_at: new Date(),
    });
    await HANDLERS.add_beat_attachment({
      beat: beat._id.toString(),
      source_url: 'https://x.test/a.ogg',
    });
    const out = await HANDLERS.remove_beat_attachment({
      beat: beat._id.toString(),
      attachment_id: fakeId.toString(),
    });
    expect(out).toMatch(/Removed attachment/);
    expect(Attachments.deleteAttachment).toHaveBeenCalledTimes(1);
    const after = await Plots.getBeat(beat._id.toString());
    expect(after.attachments).toHaveLength(0);
  });

  it('propagates upload errors so dispatchTool can wrap them', async () => {
    const beat = await seedBeat();
    Attachments.uploadAttachmentFromUrl.mockRejectedValue(new Error('File too large: ...'));
    await expect(
      HANDLERS.add_beat_attachment({
        beat: beat._id.toString(),
        source_url: 'https://x.test/huge.bin',
      }),
    ).rejects.toThrow(/File too large/);
  });
});

describe('character attachment handlers', () => {
  beforeEach(() => {
    Attachments.attachToCharacter.mockReset();
    Attachments.listCharacterAttachments.mockReset();
    Attachments.removeCharacterAttachment.mockReset();
  });

  it('add_character_attachment delegates to Attachments.attachToCharacter', async () => {
    const fakeId = new ObjectId();
    Attachments.attachToCharacter.mockResolvedValue({
      character: 'Pauly',
      _id: fakeId,
      filename: 'pauly.ogg',
      content_type: 'audio/ogg',
      size: 1234,
      caption: 'voice clip',
      uploaded_at: new Date(),
    });
    const out = await HANDLERS.add_character_attachment({
      character: 'Pauly',
      source_url: 'https://x.test/pauly.ogg',
      caption: 'voice clip',
    });
    expect(Attachments.attachToCharacter).toHaveBeenCalledWith({
      character: 'Pauly',
      sourceUrl: 'https://x.test/pauly.ogg',
      filename: undefined,
      caption: 'voice clip',
    });
    expect(out).toMatch(/Added attachment to Pauly/);
    expect(out).toContain('pauly.ogg');
  });

  it('list_character_attachments delegates to Attachments.listCharacterAttachments', async () => {
    const charId = new ObjectId();
    const attId = new ObjectId();
    Attachments.listCharacterAttachments.mockResolvedValue({
      character: 'Pauly',
      _id: charId,
      attachments: [
        {
          _id: attId,
          filename: 'pauly.ogg',
          content_type: 'audio/ogg',
          size: 1234,
          caption: null,
          uploaded_at: new Date(),
        },
      ],
    });
    const raw = await HANDLERS.list_character_attachments({ character: 'Pauly' });
    const out = JSON.parse(raw.replace(/\nEdit in browser:.*$/s, ''));
    expect(out.character.name).toBe('Pauly');
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments[0].filename).toBe('pauly.ogg');
    expect(raw).toMatch(/Edit in browser: http:\/\/localhost:3000\/character\/Pauly/);
  });

  it('remove_character_attachment delegates and reports removal', async () => {
    const removed = new ObjectId();
    Attachments.removeCharacterAttachment.mockResolvedValue({
      character: 'Pauly',
      removed,
    });
    const out = await HANDLERS.remove_character_attachment({
      character: 'Pauly',
      attachment_id: removed.toString(),
    });
    expect(Attachments.removeCharacterAttachment).toHaveBeenCalledWith({
      character: 'Pauly',
      attachmentId: removed.toString(),
    });
    expect(out).toMatch(/Removed attachment/);
    expect(out).toMatch(/Pauly/);
  });
});
