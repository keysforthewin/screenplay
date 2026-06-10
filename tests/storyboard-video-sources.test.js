// Tests for GET /api/storyboard/:id/video-source-storyboards — the data behind
// the "Storyboard" tab of the Add Video dialog. It must return one merged list
// of every reusable source video: generated clips on ALL shots (including the
// current one, flagged is_current_shot) plus video attachments uploaded to any
// beat or character. The current shot's own attached source must be excluded
// from the reference set (so it isn't a reference of itself).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/web/auth.js', () => ({
  requireSession: () => (_req, _res, next) => next(),
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/web/announceHelpers.js', () => ({
  announceBeatMedia: vi.fn(),
  announceCharacterMedia: vi.fn(),
  announceNoteMedia: vi.fn(),
  announceStoryboardMedia: vi.fn(),
  announceLibraryMedia: vi.fn(),
  announceBatchSummary: vi.fn(),
}));

const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter());
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  fakeDb.reset();
});

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, json: await res.json() };
}

function videoAtt(filename) {
  return {
    _id: new ObjectId(),
    filename,
    content_type: 'video/mp4',
    size: 1234,
    uploaded_at: new Date(),
  };
}

// Directly set the storyboard's video fields — these are normally written by
// the gateway helpers, but the fake collection lets us seed them in place.
async function setVideoFields(sbId, fields) {
  await fakeDb.collection('storyboards').updateOne({ _id: sbId }, { $set: fields });
}

describe('GET /api/storyboard/:id/video-source-storyboards', () => {
  it('merges generated videos (incl. current shot) with beat/character references', async () => {
    const beatA = await Plots.createBeat({ name: 'Diner' });
    const beatB = await Plots.createBeat({ name: 'Highway' });

    // The current shot: has its own generated video, plus an attached source
    // upload (attCurrentSource) that lives on beatA's attachments.
    const current = await Storyboards.createStoryboard({ beatId: beatA._id });
    const otherShot = await Storyboards.createStoryboard({ beatId: beatB._id });

    const genCurrent = new ObjectId();
    const genOther = new ObjectId();

    const attCurrentSource = videoAtt('current-source.mp4'); // excluded from refs
    const attBeatB = videoAtt('beatB-clip.mp4'); // should appear
    await Plots.pushBeatAttachment(undefined, beatA._id, attCurrentSource);
    await Plots.pushBeatAttachment(undefined, beatB._id, attBeatB);
    // A non-video attachment must be filtered out.
    await Plots.pushBeatAttachment(undefined, beatB._id, {
      _id: new ObjectId(),
      filename: 'poster.png',
      content_type: 'image/png',
      size: 10,
      uploaded_at: new Date(),
    });

    const char = await Characters.createCharacter({ name: 'Bronze Leopard' });
    const attChar = videoAtt('character-reel.mp4'); // should appear
    await Characters.pushCharacterAttachment(undefined, char._id, attChar);

    await setVideoFields(current._id, {
      video_file_id: genCurrent,
      video_upload_file_id: attCurrentSource._id,
      video_duration_seconds: 5,
      video_model_label: 'Kling 3 Pro',
    });
    await setVideoFields(otherShot._id, {
      video_file_id: genOther,
      video_duration_seconds: 8,
      video_model_label: 'Sora 2',
    });

    const { status, json } = await get(
      `/api/storyboard/${current._id}/video-source-storyboards`,
    );
    expect(status).toBe(200);
    const sources = json.sources;

    const generated = sources.filter((s) => s.kind === 'generated');
    const references = sources.filter((s) => s.kind === 'reference');

    // Both generated clips present; the current shot is flagged.
    const genIds = generated.map((s) => String(s.video_file_id));
    expect(genIds).toContain(String(genCurrent));
    expect(genIds).toContain(String(genOther));
    const cur = generated.find((s) => String(s.video_file_id) === String(genCurrent));
    expect(cur.is_current_shot).toBe(true);
    const oth = generated.find((s) => String(s.video_file_id) === String(genOther));
    expect(oth.is_current_shot).toBe(false);

    // Beat + character video references present; image and the current shot's
    // own attached source are excluded.
    const refIds = references.map((s) => String(s.video_file_id));
    expect(refIds).toContain(String(attBeatB._id));
    expect(refIds).toContain(String(attChar._id));
    expect(refIds).not.toContain(String(attCurrentSource._id));
    expect(references.every((s) => s.content_type.startsWith('video/'))).toBe(true);
  });

  it('returns 404 for a non-existent storyboard id', async () => {
    const { status } = await get(
      `/api/storyboard/${new ObjectId()}/video-source-storyboards`,
    );
    expect(status).toBe(404);
  });
});
