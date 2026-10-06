// ElevenLabs voices on characters and dialogue: the audio-tag policy (voiced
// speakers get Eleven v4 tags, everyone else plain lines), the tag helpers,
// and the "Generate all voices" batch.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/web/dialogAudioProbe.js', () => ({
  probeDialogAudioDuration: vi.fn(async () => 2.5),
}));

const elevenMock = vi.hoisted(() => ({
  isConfigured: vi.fn(() => true),
  textToSpeech: vi.fn(),
  listAccountVoices: vi.fn(),
}));
vi.mock('../src/eleven/client.js', () => elevenMock);

vi.mock('../src/mongo/attachments.js', async () => {
  const actual = await vi.importActual('../src/mongo/attachments.js');
  return {
    ...actual,
    uploadAttachmentBuffer: vi.fn(async (_pid, { filename, contentType }) => ({
      _id: new ObjectId(),
      filename,
      content_type: contentType,
      size: 3,
    })),
  };
});

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Dialogs = await import('../src/mongo/dialogs.js');
const Characters = await import('../src/mongo/characters.js');
const Attachments = await import('../src/mongo/attachments.js');
const Gateway = await import('../src/web/gateway.js');
const BeatLocks = await import('../src/web/beatLocks.js');
const Tags = await import('../src/eleven/dialogTags.js');
const Voices = await import('../src/web/dialogVoices.js');
const VoiceJob = await import('../src/web/dialogVoiceGenerate.js');
const Generate = await import('../src/web/dialogGenerate.js');
const { estimateLineSeconds } = await import('../src/web/shotTiming.js');
const { _setAnthropicClientForTests, _resetAnthropicClientForTests } =
  await import('../src/anthropic/client.js');

let projectId;
let beat;

const VOICE = { voice_id: 'voice-alice', name: 'Alice Voice', preview_url: 'https://x/p.mp3', category: 'cloned' };

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  BeatLocks._clearBeatLocksForTests();
  VoiceJob._resetDialogVoiceJobsForTests();
  _resetAnthropicClientForTests();
  elevenMock.isConfigured.mockReturnValue(true);
  elevenMock.textToSpeech.mockReset();
  elevenMock.textToSpeech.mockResolvedValue({ buffer: Buffer.from('mp3'), contentType: 'audio/mpeg' });
  Attachments.uploadAttachmentBuffer.mockClear();
  beat = await Plots.createBeat({ projectId, name: 'Diner', desc: 'A diner scene.' });
  await Characters.createCharacter({ projectId, name: '**Alice**' });
  await Characters.createCharacter({ projectId, name: 'Bob' });
  await Gateway.setCharacterElevenVoiceViaGateway({ projectId, character: 'Alice', voice: VOICE });
});

async function waitForJob() {
  for (let i = 0; i < 300; i++) {
    const job = VoiceJob.getDialogVoiceJobForBeat(beat._id);
    if (job && job.status !== 'running') return VoiceJob.serializeDialogVoiceJob(job);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job never completed');
}

describe('audio tag helpers', () => {
  it('strips plain and markdown-escaped tags but not links', () => {
    expect(Tags.stripAudioTags('[low, threatening] You came. [long pause] \\[exhales\\] Sit.')).toBe('You came. Sit.');
    expect(Tags.stripAudioTags('See [the menu](http://x) first.')).toBe('See [the menu](http://x) first.');
    expect(Tags.hasAudioTags('a [sighs] b')).toBe(true);
    expect(Tags.hasAudioTags('nothing here')).toBe(false);
  });

  it('dialogSpeechText keeps tags, drops markdown and escapes', () => {
    expect(Tags.dialogSpeechText('\\[whispering\\] **Hello** there.')).toBe('[whispering] Hello there.');
  });

  it('speech-length estimates do not count tags as words', () => {
    expect(estimateLineSeconds({ body: '[voice breaking, barely audible] No.' }))
      .toBe(estimateLineSeconds({ body: 'No.' }));
  });
});

describe('character voice + tag policy', () => {
  it('stores the voice on the character and clears it', async () => {
    const c = await Characters.getCharacter(projectId, 'Alice');
    expect(c.eleven_voice).toEqual(VOICE);
    await Gateway.setCharacterElevenVoiceViaGateway({ projectId, character: 'Alice', voice: null });
    expect((await Characters.getCharacter(projectId, 'Alice')).eleven_voice).toBe(null);
  });

  it('the cast resolves speakers by stripped name; unvoiced lines lose their tags', async () => {
    const cast = await Voices.loadVoiceCast(projectId);
    expect(Voices.voiceForSpeaker(cast, 'alice').voice_id).toBe('voice-alice');
    expect(Voices.voiceForSpeaker(cast, 'Bob')).toBe(null);
    expect(Voices.applyVoiceTagPolicy(cast, 'Alice', '[dry] Sure.')).toBe('[dry] Sure.');
    expect(Voices.applyVoiceTagPolicy(cast, 'Bob', '[dry] Sure.')).toBe('Sure.');
    expect(Voices.applyVoiceTagPolicy(cast, 'RADIO', '[static] Stay tuned.')).toBe('Stay tuned.');
    expect(Voices.audioTagPromptSection(cast)).toContain('VOICED speakers (write audio tags into their lines): Alice');
    expect(Voices.audioTagPromptSection(new Map())).toBe('');
  });

  it('dialogue generation asks for tags for voiced speakers and strips them from the rest', async () => {
    const create = vi.fn(async () => ({
      content: [{
        type: 'tool_use',
        name: 'populate_dialog',
        input: { entries: [
          { character: 'Alice', body: '[too casual] Where is Bob?' },
          { character: 'Bob', body: '[nervous] Right here.' },
        ] },
      }],
    }));
    _setAnthropicClientForTests({ messages: { create } });
    const jobId = await Generate.startDialogGenerationJob({ projectId, beatId: beat._id.toString() });
    for (let i = 0; i < 300; i++) {
      const j = Generate.getDialogGenerationJob(jobId);
      if (j.status === 'done' || j.status === 'error') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const prompt = create.mock.calls[0][0].messages[0].content[0].text;
    expect(prompt).toContain('# Voice performance — ElevenLabs audio tags');
    expect(prompt).toContain('VOICED speakers (write audio tags into their lines): Alice');
    const lines = await Dialogs.listDialogs({ beatId: beat._id });
    expect(lines.map((d) => d.body)).toEqual(['[too casual] Where is Bob?', 'Right here.']);
  });

  it('with no voiced character the prompt has no tag section', async () => {
    await Gateway.setCharacterElevenVoiceViaGateway({ projectId, character: 'Alice', voice: null });
    const create = vi.fn(async () => ({
      content: [{ type: 'tool_use', name: 'populate_dialog', input: { entries: [{ character: 'Alice', body: '[sighs] Hi.' }] } }],
    }));
    _setAnthropicClientForTests({ messages: { create } });
    const jobId = await Generate.startDialogGenerationJob({ projectId, beatId: beat._id.toString() });
    for (let i = 0; i < 300; i++) {
      const j = Generate.getDialogGenerationJob(jobId);
      if (j.status === 'done' || j.status === 'error') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(create.mock.calls[0][0].messages[0].content[0].text).not.toContain('Voice performance');
    expect((await Dialogs.listDialogs({ beatId: beat._id }))[0].body).toBe('Hi.');
  });
});

describe('generate all voices', () => {
  async function line(character, body) {
    return Gateway.createDialogViaGateway({ projectId, beatId: beat._id, character, body });
  }

  it('voices every line with a voice using eleven_v4 and leaves the rest', async () => {
    const a = await line('Alice', '\\[whispering\\] **Where** is Bob?');
    const b = await line('Bob', 'Right here.');
    const empty = await line('Alice', '[sighs]');

    const preview = await VoiceJob.previewDialogVoices({ projectId, beatId: beat._id });
    expect(preview).toMatchObject({ ready: 1, no_voice: 1, empty: 1, with_audio: 0, unvoiced_speakers: ['Bob'], model: 'eleven_v4' });

    await VoiceJob.startDialogVoiceJob({ projectId, beatId: beat._id.toString() });
    const job = await waitForJob();
    expect(job.status).toBe('done');
    expect(job.counts).toMatchObject({ done: 1, skipped: 2, error: 0 });
    expect(elevenMock.textToSpeech).toHaveBeenCalledTimes(1);
    expect(elevenMock.textToSpeech).toHaveBeenCalledWith({
      voiceId: 'voice-alice',
      text: '[whispering] Where is Bob?',
      modelId: 'eleven_v4',
    });
    expect(Attachments.uploadAttachmentBuffer.mock.calls[0][1]).toMatchObject({
      ownerType: 'dialog',
      generatedBy: 'elevenlabs/eleven_v4',
    });
    const after = await Dialogs.getDialog(projectId, a._id);
    expect(after.audio_file_id).toBeTruthy();
    expect(after.audio_duration_seconds).toBe(2.5);
    expect((await Dialogs.getDialog(projectId, b._id)).audio_file_id).toBe(null);
    expect((await Dialogs.getDialog(projectId, empty._id)).audio_file_id).toBe(null);
    const reasons = Object.fromEntries(job.items.map((it) => [it.dialog_id, it.reason]));
    expect(reasons[b._id.toString()]).toBe('no ElevenLabs voice assigned');
    expect(reasons[empty._id.toString()]).toBe('empty line');
  });

  it('a line\'s own voice outranks the character\'s and voices a line with no character', async () => {
    const OWN = { voice_id: 'voice-radio', name: 'Radio Voice', preview_url: null, category: 'premade' };
    const a = await line('Alice', 'Mine.');
    const radio = await line('RADIO', '[static] Stay tuned.');
    const bob = await line('Bob', 'Plain.');
    await Gateway.setDialogElevenVoiceViaGateway({ projectId, dialogId: a._id, voice: OWN });
    const stored = await Gateway.setDialogElevenVoiceViaGateway({ projectId, dialogId: radio._id, voice: OWN });
    expect(stored.eleven_voice).toEqual(OWN);

    const cast = await Voices.loadVoiceCast(projectId);
    expect(Voices.voiceForDialog(cast, stored)).toMatchObject({ voice_id: 'voice-radio', line_voice: true });
    expect(Voices.voiceForDialog(cast, bob)).toBe(null);
    expect(Voices.applyVoiceTagPolicy(cast, 'RADIO', '[static] Hi.', stored)).toBe('[static] Hi.');
    expect(Voices.hasOwnVoiceOutsideCast(cast, stored)).toBe(true);
    expect(Voices.hasOwnVoiceOutsideCast(cast, await Dialogs.getDialog(projectId, a._id))).toBe(false);
    expect(Voices.audioTagPromptSection(new Map(), { voicedLines: true })).toContain('(VOICED LINE)');

    const preview = await VoiceJob.previewDialogVoices({ projectId, beatId: beat._id });
    expect(preview).toMatchObject({ ready: 2, no_voice: 1, unvoiced_speakers: ['Bob'] });

    await VoiceJob.startDialogVoiceJob({ projectId, beatId: beat._id.toString() });
    const job = await waitForJob();
    expect(job.counts).toMatchObject({ done: 2, skipped: 1 });
    const calls = elevenMock.textToSpeech.mock.calls.map((c) => [c[0].voiceId, c[0].text]).sort();
    expect(calls).toEqual([['voice-radio', 'Mine.'], ['voice-radio', '[static] Stay tuned.']]);

    // Clearing the line's voice goes back to the character's.
    const cleared = await Gateway.setDialogElevenVoiceViaGateway({ projectId, dialogId: a._id, voice: null });
    expect(cleared.eleven_voice).toBe(null);
    expect(Voices.voiceForDialog(cast, cleared).voice_id).toBe('voice-alice');
  });

  it('keeps existing audio unless overwrite is set', async () => {
    const a = await line('Alice', 'One.');
    const recorded = new ObjectId();
    await Gateway.setDialogAudioViaGateway({ projectId, dialogId: a._id, audioFileId: recorded });

    await expect(VoiceJob.startDialogVoiceJob({ projectId, beatId: beat._id.toString() }))
      .rejects.toMatchObject({ code: 'NOTHING_TO_GENERATE', status: 400 });
    expect(elevenMock.textToSpeech).not.toHaveBeenCalled();

    await VoiceJob.startDialogVoiceJob({ projectId, beatId: beat._id.toString(), overwrite: true });
    const job = await waitForJob();
    expect(job.counts.done).toBe(1);
    expect((await Dialogs.getDialog(projectId, a._id)).audio_file_id.toString()).not.toBe(recorded.toString());
  });

  it('a failed line is recorded and the batch carries on', async () => {
    await line('Alice', 'One.');
    const two = await line('Alice', 'Two.');
    elevenMock.textToSpeech.mockImplementation(async ({ text }) => {
      if (text === 'One.') throw new Error('quota exceeded');
      return { buffer: Buffer.from('mp3'), contentType: 'audio/mpeg' };
    });
    await VoiceJob.startDialogVoiceJob({ projectId, beatId: beat._id.toString() });
    const job = await waitForJob();
    expect(job.status).toBe('done');
    expect(job.counts).toMatchObject({ done: 1, error: 1 });
    expect(job.items.find((it) => it.status === 'error').error).toBe('quota exceeded');
    expect((await Dialogs.getDialog(projectId, two._id)).audio_file_id).toBeTruthy();
  });

  it('refuses when unconfigured, when nobody has a voice, and while the beat is busy', async () => {
    await line('Bob', 'Hello.');
    await expect(VoiceJob.startDialogVoiceJob({ projectId, beatId: beat._id.toString() }))
      .rejects.toMatchObject({ code: 'NOTHING_TO_GENERATE' });

    elevenMock.isConfigured.mockReturnValue(false);
    await expect(VoiceJob.startDialogVoiceJob({ projectId, beatId: beat._id.toString() }))
      .rejects.toMatchObject({ code: 'ELEVEN_NOT_CONFIGURED', status: 503 });
    elevenMock.isConfigured.mockReturnValue(true);

    await line('Alice', 'Hi.');
    let release;
    BeatLocks.withBeatLock(beat._id, () => new Promise((r) => { release = r; }));
    await expect(VoiceJob.startDialogVoiceJob({ projectId, beatId: beat._id.toString() }))
      .rejects.toMatchObject({ code: 'BEAT_BUSY', status: 409 });
    release();
  });

  it('cancel stops before the lines still waiting', async () => {
    for (let i = 0; i < 5; i++) await line('Alice', `Line ${i}.`);
    let unblock;
    const gate = new Promise((r) => { unblock = r; });
    elevenMock.textToSpeech.mockImplementation(async () => {
      await gate;
      return { buffer: Buffer.from('mp3'), contentType: 'audio/mpeg' };
    });
    await VoiceJob.startDialogVoiceJob({ projectId, beatId: beat._id.toString() });
    await new Promise((r) => setTimeout(r, 30));
    expect(VoiceJob.cancelDialogVoiceJob(beat._id)).toBeTruthy();
    unblock();
    const job = await waitForJob();
    expect(job.status).toBe('cancelled');
    expect(job.counts.done).toBe(2);
    expect(job.counts.cancelled).toBe(3);
  });
});
