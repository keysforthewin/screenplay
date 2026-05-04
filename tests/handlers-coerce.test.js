import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

const Characters = await import('../src/mongo/characters.js');
const Plots = await import('../src/mongo/plots.js');
const { HANDLERS } = await import('../src/agent/handlers.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('update_character stringified-patch recovery', () => {
  it('recovers a plain stringified JSON object patch', async () => {
    await Characters.createCharacter({ name: 'Alice', fields: {} });
    const out = await HANDLERS.update_character({
      identifier: 'Alice',
      patch: '{"fields":{"role":"lead"}}',
    });
    expect(out).toMatch(/Updated Alice/);
    const fresh = await Characters.getCharacter('Alice');
    expect(fresh.fields.role).toBe('lead');
  });

  it('recovers a code-fenced JSON patch (```json ... ```)', async () => {
    await Characters.createCharacter({ name: 'Alice', fields: {} });
    const fenced = '```json\n{"fields":{"role":"lead"}}\n```';
    const out = await HANDLERS.update_character({
      identifier: 'Alice',
      patch: fenced,
    });
    expect(out).toMatch(/Updated Alice/);
    const fresh = await Characters.getCharacter('Alice');
    expect(fresh.fields.role).toBe('lead');
  });

  it('recovers an array-wrapped single-object patch', async () => {
    await Characters.createCharacter({ name: 'Alice', fields: {} });
    const out = await HANDLERS.update_character({
      identifier: 'Alice',
      patch: '[{"fields":{"role":"lead"}}]',
    });
    expect(out).toMatch(/Updated Alice/);
    const fresh = await Characters.getCharacter('Alice');
    expect(fresh.fields.role).toBe('lead');
  });

  it('falls through to canonical error on truly malformed string', async () => {
    await Characters.createCharacter({ name: 'Alice', fields: {} });
    await expect(
      HANDLERS.update_character({
        identifier: 'Alice',
        patch: '{not json',
      }),
    ).rejects.toThrow(/must be an object/);
  });

  it('recovers a stringified unset patch (deletion path)', async () => {
    await Characters.createCharacter({
      name: 'Alice',
      fields: { memes: 'doge', role: 'lead' },
    });
    const out = await HANDLERS.update_character({
      identifier: 'Alice',
      patch: '{"unset":["memes"]}',
    });
    expect(out).toMatch(/Updated Alice/);
    const fresh = await Characters.getCharacter('Alice');
    expect('memes' in fresh.fields).toBe(false);
    expect(fresh.fields.role).toBe('lead');
  });
});

describe('update_beat stringified-patch recovery', () => {
  it('recovers a plain stringified JSON object patch', async () => {
    await Plots.createBeat({ name: 'Opening', desc: 'opening scene', body: 'old body' });
    const out = await HANDLERS.update_beat({
      identifier: 'Opening',
      patch: '{"body":"new body"}',
    });
    expect(out).toMatch(/Updated beat "Opening"/);
    const fresh = await Plots.getBeat('Opening');
    expect(fresh.body).toBe('new body');
  });

  it('recovers a code-fenced JSON patch (```json ... ```)', async () => {
    await Plots.createBeat({ name: 'Opening', desc: 'opening scene', body: 'old body' });
    const fenced = '```json\n{"body":"fenced body"}\n```';
    const out = await HANDLERS.update_beat({
      identifier: 'Opening',
      patch: fenced,
    });
    expect(out).toMatch(/Updated beat "Opening"/);
    const fresh = await Plots.getBeat('Opening');
    expect(fresh.body).toBe('fenced body');
  });

  it('falls through to canonical error on truly malformed string', async () => {
    await Plots.createBeat({ name: 'Opening', desc: 'opening scene' });
    await expect(
      HANDLERS.update_beat({
        identifier: 'Opening',
        patch: 'this is not json at all',
      }),
    ).rejects.toThrow(/must be an object/);
  });

  it('recovers a patch wrapped in leading prose ("Patch: {...}")', async () => {
    await Plots.createBeat({ name: 'Opening', desc: 'opening scene', body: 'old' });
    const out = await HANDLERS.update_beat({
      identifier: 'Opening',
      patch: 'Here is the patch: {"body":"prose-wrapped body"}',
    });
    expect(out).toMatch(/Updated beat "Opening"/);
    const fresh = await Plots.getBeat('Opening');
    expect(fresh.body).toBe('prose-wrapped body');
  });

  it('recovers a patch followed by trailing prose', async () => {
    await Plots.createBeat({ name: 'Opening', desc: 'opening scene', body: 'old' });
    const out = await HANDLERS.update_beat({
      identifier: 'Opening',
      patch: '{"body":"trailing-prose body"} — done',
    });
    expect(out).toMatch(/Updated beat "Opening"/);
    const fresh = await Plots.getBeat('Opening');
    expect(fresh.body).toBe('trailing-prose body');
  });

  it('recovers a smart-quoted patch (curly “ ”)', async () => {
    await Plots.createBeat({ name: 'Opening', desc: 'opening scene', body: 'old' });
    const out = await HANDLERS.update_beat({
      identifier: 'Opening',
      patch: '{“body”:“smart-quoted body”}',
    });
    expect(out).toMatch(/Updated beat "Opening"/);
    const fresh = await Plots.getBeat('Opening');
    expect(fresh.body).toBe('smart-quoted body');
  });

  it('recovers an over-stringified patch ("\\"{...}\\"")', async () => {
    await Plots.createBeat({ name: 'Opening', desc: 'opening scene', body: 'old' });
    const overStringified = JSON.stringify(JSON.stringify({ body: 'over-stringified body' }));
    const out = await HANDLERS.update_beat({
      identifier: 'Opening',
      patch: overStringified,
    });
    expect(out).toMatch(/Updated beat "Opening"/);
    const fresh = await Plots.getBeat('Opening');
    expect(fresh.body).toBe('over-stringified body');
  });

  it('recovers a multi-paragraph body with literal (unescaped) newlines inside the JSON string value', async () => {
    // This mirrors a real production failure: the model emits a long body
    // field as JSON-looking text but forgets to escape the newlines, so a
    // strict JSON.parse rejects it.
    await Plots.createBeat({ name: 'Opening', desc: 'opening scene', body: 'old' });
    const body = '**OTTAWA. AUGUST 1ST, 2028. SUNDAY — STILL.**\n\nThe cold open transitions directly into this. Adult Keys is at work.\nSo is everyone else.\tIt\'s a Sunday.';
    const malformed = `{"body": "${body}"}`; // raw newlines/tabs land directly inside the value
    expect(() => JSON.parse(malformed)).toThrow();
    const out = await HANDLERS.update_beat({
      identifier: 'Opening',
      patch: malformed,
    });
    expect(out).toMatch(/Updated beat "Opening"/);
    const fresh = await Plots.getBeat('Opening');
    expect(fresh.body).toBe(body);
  });

  it('recovers a body that contains unescaped DIALOGUE quotes (the most common screenplay failure)', async () => {
    // Screenplay prose is full of dialogue. When the model writes a long body and
    // forgets to escape internal double-quotes, the in-string state tracking gets
    // thrown off and strict JSON.parse fails. The single-field-shape regex
    // extractor is the final fallback.
    await Plots.createBeat({ name: 'Opening', desc: 'opening scene', body: 'old' });
    const body = 'Keys looks up. "Wait, what?" he says.\n\nHis manager replies, "You heard me." Silence.';
    const malformed = `{"body":"${body}"}`; // unescaped " inside the value
    expect(() => JSON.parse(malformed)).toThrow();
    const out = await HANDLERS.update_beat({
      identifier: 'Opening',
      patch: malformed,
    });
    expect(out).toMatch(/Updated beat "Opening"/);
    const fresh = await Plots.getBeat('Opening');
    expect(fresh.body).toBe(body);
  });

  it('the extractor preserves valid JSON escape sequences inside the recovered value', async () => {
    // If the model partially escaped (some \n correctly, but unescaped quotes
    // forced us into the regex fallback), the standard escapes still get decoded.
    await Plots.createBeat({ name: 'Opening', desc: 'opening scene', body: 'old' });
    const malformed = '{"body":"Line one\\nLine "two"\\nLine three"}';
    expect(() => JSON.parse(malformed)).toThrow();
    const out = await HANDLERS.update_beat({
      identifier: 'Opening',
      patch: malformed,
    });
    expect(out).toMatch(/Updated beat "Opening"/);
    const fresh = await Plots.getBeat('Opening');
    expect(fresh.body).toBe('Line one\nLine "two"\nLine three');
  });

  it('the regex extractor does NOT swallow multi-field shapes (keeps existing parse behavior)', async () => {
    // {"name":"...","body":"..."} with internal quotes is harder than single-field;
    // for now we let it fall through to the canonical error rather than guess wrong.
    await Plots.createBeat({ name: 'Opening', desc: 'opening scene', body: 'old' });
    const malformed = '{"name":"X","body":"He said "hi"."}'; // unescaped + multi-field
    await expect(
      HANDLERS.update_beat({ identifier: 'Opening', patch: malformed }),
    ).rejects.toThrow(/must be an object/);
  });
});

describe('set_beat_body handler', () => {
  it('replaces the body and reports a length delta', async () => {
    await Plots.createBeat({ name: 'Opening', desc: 'd', body: 'first' });
    const out = await HANDLERS.set_beat_body({ beat: 'Opening', body: 'second draft body' });
    expect(out).toMatch(/Replaced body of beat "Opening"/);
    expect(out).toMatch(/Was 5 chars; now 17 chars/);
    const fresh = await Plots.getBeat('Opening');
    expect(fresh.body).toBe('second draft body');
  });

  it('accepts an empty body to clear the field', async () => {
    await Plots.createBeat({ name: 'Opening', desc: 'd', body: 'old body' });
    const out = await HANDLERS.set_beat_body({ beat: 'Opening', body: '' });
    expect(out).toMatch(/Replaced body of beat "Opening"/);
    const fresh = await Plots.getBeat('Opening');
    expect(fresh.body).toBe('');
  });

  it('returns a tool error when beat is missing', async () => {
    const out = await HANDLERS.set_beat_body({ body: 'x' });
    expect(out).toMatch(/Tool error \(set_beat_body\): `beat` is required/);
  });

  it('returns a tool error when body is not a string', async () => {
    await Plots.createBeat({ name: 'Opening', desc: 'd' });
    const out = await HANDLERS.set_beat_body({ beat: 'Opening', body: 42 });
    expect(out).toMatch(/Tool error \(set_beat_body\): `body` must be a string/);
  });

  it('defensively recovers when the entire input arrives as a stringified JSON', async () => {
    // Same model failure mode handled by update_beat — cheap insurance.
    await Plots.createBeat({ name: 'Opening', desc: 'd', body: 'x' });
    const out = await HANDLERS.set_beat_body('{"beat":"Opening","body":"recovered"}');
    expect(out).toMatch(/Replaced body of beat "Opening"/);
    const fresh = await Plots.getBeat('Opening');
    expect(fresh.body).toBe('recovered');
  });
});

describe('edit_beat_body handler', () => {
  it('applies a single edit and reports the body length transition', async () => {
    await Plots.createBeat({
      name: 'Opening', desc: 'd',
      body: 'Keys says "hello" to Bob.',
    });
    const out = await HANDLERS.edit_beat_body({
      beat: 'Opening',
      edits: [{ find: '"hello"', replace: '"good morning"' }],
    });
    expect(out).toMatch(/Applied 1 edit\(s\) to beat "Opening"/);
    expect(out).toMatch(/Body: 25 → 32 chars/);
    const fresh = await Plots.getBeat('Opening');
    expect(fresh.body).toBe('Keys says "good morning" to Bob.');
  });

  it('applies multiple edits in order and reports per-edit deltas', async () => {
    await Plots.createBeat({ name: 'Opening', desc: 'd', body: 'one two three' });
    const out = await HANDLERS.edit_beat_body({
      beat: 'Opening',
      edits: [
        { find: 'one', replace: 'ONE' },
        { find: 'three', replace: 'THREE' },
      ],
    });
    expect(out).toMatch(/Applied 2 edit\(s\)/);
    expect(out).toMatch(/1\. -3\/\+3 \(Δ\+0\)/);
    expect(out).toMatch(/2\. -5\/\+5 \(Δ\+0\)/);
  });

  it('surfaces the find snippet when no match is present', async () => {
    await Plots.createBeat({ name: 'Opening', desc: 'd', body: 'hello world' });
    // Handlers throw → dispatchTool wraps into "Tool error (...)" but here we
    // call the handler directly so the throw propagates.
    await expect(
      HANDLERS.edit_beat_body({
        beat: 'Opening',
        edits: [{ find: 'banana split sundae', replace: 'apple' }],
      }),
    ).rejects.toThrow(/not found.*banana split sundae/);
  });

  it('surfaces the match count when the find string is non-unique', async () => {
    await Plots.createBeat({ name: 'Opening', desc: 'd', body: 'one one one' });
    await expect(
      HANDLERS.edit_beat_body({
        beat: 'Opening',
        edits: [{ find: 'one', replace: 'two' }],
      }),
    ).rejects.toThrow(/matched 3 places/);
  });

  it('returns a tool error when beat is missing', async () => {
    const out = await HANDLERS.edit_beat_body({ edits: [{ find: 'x', replace: 'y' }] });
    expect(out).toMatch(/Tool error \(edit_beat_body\): `beat` is required/);
  });

  it('returns a tool error when edits is missing or empty', async () => {
    await Plots.createBeat({ name: 'Opening', desc: 'd' });
    const a = await HANDLERS.edit_beat_body({ beat: 'Opening' });
    expect(a).toMatch(/non-empty array/);
    const b = await HANDLERS.edit_beat_body({ beat: 'Opening', edits: [] });
    expect(b).toMatch(/non-empty array/);
  });
});

describe('update_plot wrapped-shape recovery', () => {
  it('accepts the canonical flat shape (regression)', async () => {
    const out = await HANDLERS.update_plot({ title: 'Direct Title' });
    expect(out).toMatch(/Plot updated/);
    const plot = await Plots.getPlot();
    expect(plot.title).toBe('Direct Title');
  });

  it('unwraps { patch: { title: "..." } } (the production bug)', async () => {
    const out = await HANDLERS.update_plot({ patch: { title: 'Wrapped Title' } });
    expect(out).toMatch(/Plot updated/);
    const plot = await Plots.getPlot();
    expect(plot.title).toBe('Wrapped Title');
  });

  it('unwraps { patch: { synopsis: "..." } } too (covers all recognized fields)', async () => {
    const out = await HANDLERS.update_plot({
      patch: { synopsis: 'wrapped synopsis', notes: 'wrapped notes' },
    });
    expect(out).toMatch(/Plot updated/);
    const plot = await Plots.getPlot();
    expect(plot.synopsis).toBe('wrapped synopsis');
    expect(plot.notes).toBe('wrapped notes');
  });

  it('unwraps { patch: "<stringified JSON>" }', async () => {
    const out = await HANDLERS.update_plot({ patch: '{"title":"Stringified Title"}' });
    expect(out).toMatch(/Plot updated/);
    const plot = await Plots.getPlot();
    expect(plot.title).toBe('Stringified Title');
  });

  it('recovers a fully stringified patch passed as a single string', async () => {
    const out = await HANDLERS.update_plot('{"title":"Whole Thing Stringified"}');
    expect(out).toMatch(/Plot updated/);
    const plot = await Plots.getPlot();
    expect(plot.title).toBe('Whole Thing Stringified');
  });

  it('does NOT unwrap when there are mixed top-level keys (treats as canonical input)', async () => {
    // {patch: ..., title: ...} — only single-key {patch:...} is treated as wrapper.
    // Falls through to Plots.updatePlot, which ignores `patch` and applies `title`.
    const out = await HANDLERS.update_plot({ title: 'Mixed', patch: 'should be ignored' });
    expect(out).toMatch(/Plot updated/);
    const plot = await Plots.getPlot();
    expect(plot.title).toBe('Mixed');
  });
});

describe('bulk_update_character_field stringified-value recovery', () => {
  it('coerces a stringified-object value for a custom field', async () => {
    await Characters.createCharacter({ name: 'Alice', fields: {} });
    const out = await HANDLERS.bulk_update_character_field({
      field_name: 'profile',
      updates: [{ character: 'Alice', value: '{"a":1,"b":"x"}' }],
    });
    expect(out).toMatch(/Updated field "profile" on 1\/1/);
    const fresh = await Characters.getCharacter('Alice');
    expect(fresh.fields.profile).toEqual({ a: 1, b: 'x' });
  });

  it('leaves a non-JSON string value alone (still writes the string)', async () => {
    await Characters.createCharacter({ name: 'Alice', fields: {} });
    const out = await HANDLERS.bulk_update_character_field({
      field_name: 'role',
      updates: [{ character: 'Alice', value: 'protagonist' }],
    });
    expect(out).toMatch(/1\/1/);
    const fresh = await Characters.getCharacter('Alice');
    expect(fresh.fields.role).toBe('protagonist');
  });

  it('does NOT coerce values for core fields (e.g. hollywood_actor)', async () => {
    await Characters.createCharacter({ name: 'Alice' });
    const out = await HANDLERS.bulk_update_character_field({
      field_name: 'hollywood_actor',
      updates: [{ character: 'Alice', value: '{"name":"someone"}' }],
    });
    expect(out).toMatch(/1\/1/);
    const fresh = await Characters.getCharacter('Alice');
    expect(fresh.hollywood_actor).toBe('{"name":"someone"}');
  });
});
