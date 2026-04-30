import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { HANDLERS } = await import('../src/agent/handlers.js');
const Characters = await import('../src/mongo/characters.js');
const Plots = await import('../src/mongo/plots.js');

const CSV_PREFIX = '__CSV_PATH__:';

function parseSentinel(out) {
  expect(out.startsWith(CSV_PREFIX)).toBe(true);
  const rest = out.slice(CSV_PREFIX.length);
  const sep = rest.indexOf('|');
  return {
    filepath: sep >= 0 ? rest.slice(0, sep) : rest,
    note: sep >= 0 ? rest.slice(sep + 1) : '',
  };
}

async function readCsv(out) {
  const { filepath } = parseSentinel(out);
  const text = await fs.readFile(filepath, 'utf8');
  await fs.unlink(filepath).catch(() => {});
  return text;
}

function csvRows(text) {
  // Tests construct only simple cells (no embedded commas/quotes/newlines unless
  // the test explicitly sets them up — those tests verify the raw text directly).
  return text
    .trim()
    .split('\n')
    .map((line) => line.split(','));
}

beforeEach(() => {
  fakeDb.reset();
});

async function seedCharacters() {
  await Characters.createCharacter({
    name: 'Alice',
    plays_self: true,
    own_voice: true,
    fields: { age: 30, background_story: 'Detective from Boston.' },
  });
  await Characters.createCharacter({
    name: 'Bob',
    plays_self: false,
    hollywood_actor: 'Tom Hardy',
    own_voice: false,
    fields: { age: 45, background_story: 'Reformed villain.' },
  });
  await Characters.createCharacter({
    name: 'Carol',
    plays_self: true,
    own_voice: true,
    fields: { age: 22 },
  });
}

async function seedBeats() {
  await Plots.createBeat({
    name: 'Opening',
    desc: 'The opening scene.',
    body: 'Alice walks into the diner alone',
    characters: ['Alice'],
  });
  await Plots.createBeat({
    name: 'Confrontation',
    desc: 'Alice meets Bob.',
    body: 'Alice and Bob argue about the case for many minutes back and forth',
    characters: ['Alice', 'Bob'],
  });
  await Plots.createBeat({
    name: 'Resolution',
    desc: 'They reconcile.',
    body: 'Carol arrives and changes everything completely',
    characters: ['Alice', 'Carol'],
  });
}

describe('export_csv — validation and entity dispatch', () => {
  it('rejects an unknown entity', async () => {
    const out = await HANDLERS.export_csv({ entity: 'monkeys', columns: [{ field: 'name' }] });
    expect(out).toMatch(/^Tool error \(export_csv\): unknown entity/);
  });

  it('rejects empty columns', async () => {
    const out = await HANDLERS.export_csv({ entity: 'characters', columns: [] });
    expect(out).toMatch(/at least one column is required/);
  });

  it('rejects a column missing from group_by without an aggregate', async () => {
    await seedCharacters();
    const out = await HANDLERS.export_csv({
      entity: 'characters',
      columns: [
        { field: 'plays_self' },
        { field: 'name' }, // not in group_by, not aggregated
      ],
      group_by: ['plays_self'],
    });
    expect(out).toMatch(/column "name" must be in group_by or have a non-none aggregate/);
  });

  it('rejects a non-aggregated column when other columns are aggregated and there is no group_by', async () => {
    await seedCharacters();
    const out = await HANDLERS.export_csv({
      entity: 'characters',
      columns: [
        { field: 'name' }, // raw column alongside an aggregate is invalid
        { field: 'fields.age', aggregate: 'avg' },
      ],
    });
    expect(out).toMatch(/column "name" must be in group_by or have a non-none aggregate/);
  });
});

describe('export_csv — raw row export', () => {
  it('exports characters with selected columns', async () => {
    await seedCharacters();
    const out = await HANDLERS.export_csv({
      entity: 'characters',
      columns: [{ field: 'name' }, { field: 'plays_self' }, { field: 'fields.age' }],
    });
    const text = await readCsv(out);
    const rows = csvRows(text);
    expect(rows[0]).toEqual(['name', 'plays_self', 'fields.age']);
    expect(rows.slice(1)).toEqual([
      ['Alice', 'true', '30'],
      ['Bob', 'false', '45'],
      ['Carol', 'true', '22'],
    ]);
  });

  it('exports beats with selected columns sorted by Plots.listBeats order', async () => {
    await seedBeats();
    const out = await HANDLERS.export_csv({
      entity: 'beats',
      columns: [{ field: 'order' }, { field: 'name' }],
    });
    const text = await readCsv(out);
    const rows = csvRows(text);
    expect(rows[0]).toEqual(['order', 'name']);
    expect(rows.slice(1)).toEqual([
      ['1', 'Opening'],
      ['2', 'Confrontation'],
      ['3', 'Resolution'],
    ]);
  });

  it('honors a custom header label per column', async () => {
    await seedCharacters();
    const out = await HANDLERS.export_csv({
      entity: 'characters',
      columns: [
        { field: 'name', header: 'Character' },
        { field: 'fields.age', header: 'Age' },
      ],
    });
    const text = await readCsv(out);
    expect(text.split('\n')[0]).toBe('Character,Age');
  });

  it('returns the sentinel and writes the file under os.tmpdir()', async () => {
    await seedCharacters();
    const out = await HANDLERS.export_csv({
      entity: 'characters',
      columns: [{ field: 'name' }],
    });
    const { filepath, note } = parseSentinel(out);
    expect(path.dirname(filepath)).toBe(os.tmpdir());
    expect(note).toMatch(/Exported 3 characters row\(s\)\./);
    const stat = await fs.stat(filepath);
    expect(stat.isFile()).toBe(true);
    await fs.unlink(filepath);
  });

  it('uses entity-YYYY-MM-DD.csv as the default filename', async () => {
    await seedBeats();
    const today = new Date().toISOString().slice(0, 10);
    const out = await HANDLERS.export_csv({
      entity: 'beats',
      columns: [{ field: 'name' }],
    });
    const { filepath } = parseSentinel(out);
    expect(path.basename(filepath)).toBe(`beats-${today}.csv`);
    await fs.unlink(filepath);
  });
});

describe('export_csv — filter operators', () => {
  it('eq filter on a top-level boolean', async () => {
    await seedCharacters();
    const out = await HANDLERS.export_csv({
      entity: 'characters',
      columns: [{ field: 'name' }],
      filter: [{ field: 'plays_self', op: 'eq', value: true }],
    });
    const rows = csvRows(await readCsv(out));
    expect(rows.slice(1)).toEqual([['Alice'], ['Carol']]);
  });

  it('ne filter is the inverse of eq', async () => {
    await seedCharacters();
    const out = await HANDLERS.export_csv({
      entity: 'characters',
      columns: [{ field: 'name' }],
      filter: [{ field: 'plays_self', op: 'ne', value: true }],
    });
    const rows = csvRows(await readCsv(out));
    expect(rows.slice(1)).toEqual([['Bob']]);
  });

  it('gt and gte on a numeric custom field', async () => {
    await seedCharacters();
    const gt = await HANDLERS.export_csv({
      entity: 'characters',
      columns: [{ field: 'name' }],
      filter: [{ field: 'fields.age', op: 'gt', value: 25 }],
    });
    expect(csvRows(await readCsv(gt)).slice(1)).toEqual([['Alice'], ['Bob']]);

    const gte = await HANDLERS.export_csv({
      entity: 'characters',
      columns: [{ field: 'name' }],
      filter: [{ field: 'fields.age', op: 'gte', value: 30 }],
    });
    expect(csvRows(await readCsv(gte)).slice(1)).toEqual([['Alice'], ['Bob']]);
  });

  it('lt and lte on a numeric custom field', async () => {
    await seedCharacters();
    const lt = await HANDLERS.export_csv({
      entity: 'characters',
      columns: [{ field: 'name' }],
      filter: [{ field: 'fields.age', op: 'lt', value: 30 }],
    });
    expect(csvRows(await readCsv(lt)).slice(1)).toEqual([['Carol']]);

    const lte = await HANDLERS.export_csv({
      entity: 'characters',
      columns: [{ field: 'name' }],
      filter: [{ field: 'fields.age', op: 'lte', value: 30 }],
    });
    expect(csvRows(await readCsv(lte)).slice(1)).toEqual([['Alice'], ['Carol']]);
  });

  it('contains operator does case-insensitive substring match on string fields', async () => {
    await seedCharacters();
    const out = await HANDLERS.export_csv({
      entity: 'characters',
      columns: [{ field: 'name' }],
      filter: [{ field: 'fields.background_story', op: 'contains', value: 'BOSTON' }],
    });
    expect(csvRows(await readCsv(out)).slice(1)).toEqual([['Alice']]);
  });

  it('contains operator works against array fields (beats.characters)', async () => {
    await seedBeats();
    const out = await HANDLERS.export_csv({
      entity: 'beats',
      columns: [{ field: 'name' }],
      filter: [{ field: 'characters', op: 'contains', value: 'Bob' }],
    });
    expect(csvRows(await readCsv(out)).slice(1)).toEqual([['Confrontation']]);
  });

  it('exists:true keeps rows where the field is set; exists:false keeps rows where it is missing', async () => {
    await seedCharacters();
    const truthy = await HANDLERS.export_csv({
      entity: 'characters',
      columns: [{ field: 'name' }],
      filter: [{ field: 'hollywood_actor', op: 'exists', value: true }],
    });
    expect(csvRows(await readCsv(truthy)).slice(1)).toEqual([['Bob']]);

    const falsy = await HANDLERS.export_csv({
      entity: 'characters',
      columns: [{ field: 'name' }],
      filter: [{ field: 'hollywood_actor', op: 'exists', value: false }],
    });
    expect(csvRows(await readCsv(falsy)).slice(1)).toEqual([['Alice'], ['Carol']]);
  });

  it('AND-combines multiple filter conditions', async () => {
    await seedCharacters();
    const out = await HANDLERS.export_csv({
      entity: 'characters',
      columns: [{ field: 'name' }],
      filter: [
        { field: 'plays_self', op: 'eq', value: true },
        { field: 'fields.age', op: 'gte', value: 30 },
      ],
    });
    expect(csvRows(await readCsv(out)).slice(1)).toEqual([['Alice']]);
  });
});

describe('export_csv — aggregation', () => {
  it('produces a single summary row when aggregates are used without group_by', async () => {
    await seedCharacters();
    const out = await HANDLERS.export_csv({
      entity: 'characters',
      columns: [
        { field: 'fields.age', aggregate: 'avg' },
        { field: 'name', aggregate: 'count' },
      ],
    });
    const rows = csvRows(await readCsv(out));
    expect(rows[0]).toEqual(['avg(fields.age)', 'count(name)']);
    expect(rows).toHaveLength(2);
    // (30 + 45 + 22) / 3 = 32.333…
    expect(Number(rows[1][0])).toBeCloseTo(32.3333, 3);
    expect(rows[1][1]).toBe('3');
  });

  it('group_by produces one row per distinct value with per-group aggregates', async () => {
    await seedCharacters();
    const out = await HANDLERS.export_csv({
      entity: 'characters',
      columns: [
        { field: 'plays_self' },
        { field: 'name', aggregate: 'count' },
        { field: 'fields.age', aggregate: 'avg' },
      ],
      group_by: ['plays_self'],
      sort: [{ field: 'plays_self', direction: 'desc' }],
    });
    const rows = csvRows(await readCsv(out));
    expect(rows[0]).toEqual(['plays_self', 'count(name)', 'avg(fields.age)']);
    expect(rows[1][0]).toBe('true');
    expect(rows[1][1]).toBe('2');
    expect(Number(rows[1][2])).toBeCloseTo(26, 3); // (30 + 22) / 2
    expect(rows[2][0]).toBe('false');
    expect(rows[2][1]).toBe('1');
    expect(Number(rows[2][2])).toBeCloseTo(45, 3);
  });

  it('sum/min/max aggregate operators', async () => {
    await seedCharacters();
    const out = await HANDLERS.export_csv({
      entity: 'characters',
      columns: [
        { field: 'fields.age', aggregate: 'sum' },
        { field: 'fields.age', aggregate: 'min', header: 'youngest' },
        { field: 'fields.age', aggregate: 'max', header: 'oldest' },
      ],
    });
    const rows = csvRows(await readCsv(out));
    expect(rows[0]).toEqual(['sum(fields.age)', 'youngest', 'oldest']);
    expect(rows[1]).toEqual(['97', '22', '45']);
  });
});

describe('export_csv — computed columns', () => {
  it('beat word_count and char_count and image_count', async () => {
    await seedBeats();
    const out = await HANDLERS.export_csv({
      entity: 'beats',
      columns: [
        { field: 'name' },
        { field: 'word_count' },
        { field: 'char_count' },
        { field: 'image_count' },
        { field: 'character_count' },
      ],
    });
    const rows = csvRows(await readCsv(out));
    expect(rows[0]).toEqual(['name', 'word_count', 'char_count', 'image_count', 'character_count']);
    // Body: "Alice walks into the diner alone" → 6 words.
    expect(rows[1]).toEqual([
      'Opening',
      '6',
      String('Alice walks into the diner alone'.length),
      '0',
      '1',
    ]);
    // Confrontation: 13 words; 2 characters.
    expect(rows[2][1]).toBe('13');
    expect(rows[2][4]).toBe('2');
  });

  it('beat aggregate over word_count returns the average', async () => {
    await seedBeats();
    const out = await HANDLERS.export_csv({
      entity: 'beats',
      columns: [{ field: 'word_count', aggregate: 'avg' }],
    });
    const rows = csvRows(await readCsv(out));
    // word counts: 6, 13, 6 → avg 25/3 ≈ 8.333
    expect(Number(rows[1][0])).toBeCloseTo(25 / 3, 3);
  });

  it('character appears_in_beats joins against the beats collection', async () => {
    await seedCharacters();
    await seedBeats();
    const out = await HANDLERS.export_csv({
      entity: 'characters',
      columns: [{ field: 'name' }, { field: 'appears_in_beats' }],
    });
    const rows = csvRows(await readCsv(out));
    // Alice in 3 beats; Bob in 1; Carol in 1.
    expect(rows.slice(1)).toEqual([
      ['Alice', '3'],
      ['Bob', '1'],
      ['Carol', '1'],
    ]);
  });
});

describe('export_csv — sort and limit', () => {
  it('sort desc on a numeric field; limit truncates after sort', async () => {
    await seedCharacters();
    const out = await HANDLERS.export_csv({
      entity: 'characters',
      columns: [{ field: 'name' }, { field: 'fields.age' }],
      sort: [{ field: 'fields.age', direction: 'desc' }],
      limit: 2,
    });
    const rows = csvRows(await readCsv(out));
    expect(rows.slice(1)).toEqual([
      ['Bob', '45'],
      ['Alice', '30'],
    ]);
  });
});

describe('export_csv — CSV escaping', () => {
  it('escapes commas, quotes, and newlines per RFC 4180', async () => {
    await Characters.createCharacter({
      name: 'Smith, John "Johnny"',
      plays_self: true,
      own_voice: true,
      fields: { background_story: 'Line one\nLine two' },
    });
    const out = await HANDLERS.export_csv({
      entity: 'characters',
      columns: [{ field: 'name' }, { field: 'fields.background_story' }],
    });
    const { filepath } = parseSentinel(out);
    const text = await fs.readFile(filepath, 'utf8');
    await fs.unlink(filepath);
    // Comma + double quote in name → wrapped in quotes; internal " doubled.
    expect(text).toContain('"Smith, John ""Johnny"""');
    // Newline in body → wrapped in quotes; the literal newline survives inside the quoted cell.
    expect(text).toContain('"Line one\nLine two"');
  });
});

describe('export_csv — filename sanitization', () => {
  it('strips path traversal and forces a .csv extension', async () => {
    await seedCharacters();
    const out = await HANDLERS.export_csv({
      entity: 'characters',
      columns: [{ field: 'name' }],
      filename: '../../etc/passwd',
    });
    const { filepath } = parseSentinel(out);
    expect(path.dirname(filepath)).toBe(os.tmpdir());
    expect(path.basename(filepath)).toMatch(/\.csv$/);
    expect(path.basename(filepath)).not.toContain('..');
    expect(path.basename(filepath)).not.toContain('/');
    await fs.unlink(filepath);
  });

  it('appends .csv when missing', async () => {
    await seedCharacters();
    const out = await HANDLERS.export_csv({
      entity: 'characters',
      columns: [{ field: 'name' }],
      filename: 'cast_list',
    });
    const { filepath } = parseSentinel(out);
    expect(path.basename(filepath)).toBe('cast_list.csv');
    await fs.unlink(filepath);
  });
});
