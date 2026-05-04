import { describe, it, expect, vi, beforeEach } from 'vitest';

const messagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor() {
      this.messages = { create: messagesCreate };
    }
  },
}));

const warnSpy = vi.fn();
vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: warnSpy, debug: () => {}, error: () => {} },
}));

let enhanceEnabled = true;
vi.mock('../src/config.js', () => ({
  config: {
    anthropic: {
      apiKey: 'test-key',
      model: 'claude-opus-4-7',
      enhancerModel: 'claude-haiku-4-5-20251001',
      maxTokens: 16000,
    },
    get enhance() {
      return {
        enabled: enhanceEnabled,
        maxNotesChars: 1500,
        maxSummaryChars: 200,
      };
    },
  },
}));

const { enhancePrompt } = await import('../src/agent/promptEnhance.js');

beforeEach(() => {
  messagesCreate.mockReset();
  warnSpy.mockReset();
  enhanceEnabled = true;
});

function mockReply(jsonText, usage = { input_tokens: 50, output_tokens: 20 }) {
  messagesCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text: jsonText }],
    usage,
  });
}

describe('enhancePrompt', () => {
  it('returns notes + summary for a cinematic prompt', async () => {
    mockReply(
      JSON.stringify({
        notes:
          "'liam from the A team' likely refers to Liam Neeson playing Hannibal Smith in The A-Team (2010 film).",
        summary: 'Liam Neeson as Hannibal Smith (The A-Team)',
      }),
    );
    const out = await enhancePrompt({
      userText: 'cigar touting liam from the A team',
      characters: [],
      beats: [],
      synopsis: '',
    });
    expect(out.notes).toMatch(/Liam Neeson/);
    expect(out.summary).toBe('Liam Neeson as Hannibal Smith (The A-Team)');
    expect(out.usage).toEqual({ input_tokens: 50, output_tokens: 20 });
  });

  it('returns null notes/summary when the model abstains', async () => {
    mockReply(JSON.stringify({ notes: null, summary: null }));
    const out = await enhancePrompt({
      userText: 'list the characters',
      characters: [],
      beats: [],
      synopsis: '',
    });
    expect(out.notes).toBeNull();
    expect(out.summary).toBeNull();
  });

  it('swallows SDK errors and returns nulls + warns', async () => {
    messagesCreate.mockRejectedValueOnce(new Error('network down'));
    const out = await enhancePrompt({
      userText: 'something',
      characters: [],
      beats: [],
      synopsis: '',
    });
    expect(out.notes).toBeNull();
    expect(out.summary).toBeNull();
    expect(out.usage).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toMatch(/network down/);
  });

  it('returns nulls when model output is not valid JSON', async () => {
    mockReply('I am not JSON, sorry.');
    const out = await enhancePrompt({
      userText: 'something',
      characters: [],
      beats: [],
      synopsis: '',
    });
    expect(out.notes).toBeNull();
    expect(out.summary).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('skips the SDK call entirely when userText is empty', async () => {
    const out = await enhancePrompt({
      userText: '',
      characters: [],
      beats: [],
      synopsis: '',
    });
    expect(out).toEqual({ notes: null, summary: null, usage: null });
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('skips the SDK call when config.enhance.enabled is false', async () => {
    enhanceEnabled = false;
    const out = await enhancePrompt({
      userText: 'real cinematic stuff here',
      characters: [],
      beats: [],
      synopsis: '',
    });
    expect(out).toEqual({ notes: null, summary: null, usage: null });
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('embeds character names, beat titles, and synopsis in the prompt sent to the SDK', async () => {
    mockReply(JSON.stringify({ notes: null, summary: null }));
    await enhancePrompt({
      userText: 'Zodiac is the Raid leader of Barter town',
      characters: [{ name: 'Zodiac' }, { name: 'Liam' }],
      beats: [{ name: 'Barter Town brawl' }],
      synopsis: "A war for Barter Town's water rights.",
    });
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    const args = messagesCreate.mock.calls[0][0];
    const userContent = args.messages[0].content;
    expect(userContent).toContain('<world_context>');
    expect(userContent).toContain('<character_names>Zodiac, Liam</character_names>');
    expect(userContent).toContain('<beat_titles>Barter Town brawl</beat_titles>');
    expect(userContent).toContain(
      "<synopsis>A war for Barter Town's water rights.</synopsis>",
    );
    expect(userContent).toContain('<user_message>');
    expect(userContent).toContain('Zodiac is the Raid leader');
  });

  it('uses config.anthropic.enhancerModel, not the main model', async () => {
    mockReply(JSON.stringify({ notes: null, summary: null }));
    await enhancePrompt({
      userText: 'whatever',
      characters: [],
      beats: [],
      synopsis: '',
    });
    const args = messagesCreate.mock.calls[0][0];
    expect(args.model).toBe('claude-haiku-4-5-20251001');
    expect(args.model).not.toBe('claude-opus-4-7');
  });

  it('clamps overlong notes and summary fields', async () => {
    const longNotes = 'A'.repeat(2000);
    const longSummary = 'B'.repeat(400);
    mockReply(JSON.stringify({ notes: longNotes, summary: longSummary }));
    const out = await enhancePrompt({
      userText: 'something',
      characters: [],
      beats: [],
      synopsis: '',
    });
    expect(out.notes.length).toBeLessThanOrEqual(1500);
    expect(out.summary.length).toBeLessThanOrEqual(200);
    expect(out.notes.endsWith('…')).toBe(true);
    expect(out.summary.endsWith('…')).toBe(true);
  });

  it('strips markdown from character/beat names so they are clean in the world context', async () => {
    mockReply(JSON.stringify({ notes: null, summary: null }));
    await enhancePrompt({
      userText: 'whatever',
      characters: [{ name: '**Steve**' }],
      beats: [{ name: '*Beat one*' }],
      synopsis: '',
    });
    const userContent = messagesCreate.mock.calls[0][0].messages[0].content;
    expect(userContent).toContain('<character_names>Steve</character_names>');
    expect(userContent).toContain('<beat_titles>Beat one</beat_titles>');
  });
});
