// Discord project-grant select menu (src/discord/grantMenu.js).
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

const { GRANT_RE, buildGrantComponents, postGrantMenu, handleGrantSelect } = await import(
  '../src/discord/grantMenu.js'
);
const Users = await import('../src/mongo/users.js');
const Projects = await import('../src/mongo/projects.js');

beforeEach(() => fakeDb.reset());

function menuJson(components) {
  return components[0].toJSON().components[0];
}

describe('buildGrantComponents', () => {
  it('builds a multi-select with the user grants pre-selected', async () => {
    const a = await Projects.createProject('A');
    const b = await Projects.createProject('B');
    const user = await Users.findOrCreateUserByName('Steve');
    await Users.setUserProjects(user._id.toString(), [a._id.toString()]);
    const fresh = await Users.findUserByName('Steve');

    const menu = menuJson(buildGrantComponents({ user: fresh, projects: [a, b] }));
    expect(menu.custom_id).toBe(`perm:grant:${user._id.toString()}`);
    expect(menu.custom_id).toMatch(GRANT_RE);
    expect(menu.min_values).toBe(0);
    expect(menu.max_values).toBe(2);
    expect(menu.options).toEqual([
      expect.objectContaining({ label: 'A', value: a._id.toString(), default: true }),
      expect.objectContaining({ label: 'B', value: b._id.toString(), default: false }),
    ]);
  });

  it('caps at 25 options and truncates long labels', async () => {
    const user = await Users.findOrCreateUserByName('Steve');
    const projects = Array.from({ length: 30 }, (_, i) => ({
      _id: new ObjectId(),
      title: `${'x'.repeat(120)}${i}`,
    }));
    const menu = menuJson(buildGrantComponents({ user, projects }));
    expect(menu.options).toHaveLength(25);
    expect(menu.max_values).toBe(25);
    for (const opt of menu.options) expect(opt.label.length).toBeLessThanOrEqual(100);
  });
});

describe('postGrantMenu', () => {
  it('follows up with the menu, skips when there are no projects', async () => {
    const user = await Users.findOrCreateUserByName('Steve');
    const followUp = vi.fn();
    await postGrantMenu({ interaction: { followUp }, user });
    expect(followUp).not.toHaveBeenCalled();

    await Projects.createProject('A');
    await postGrantMenu({ interaction: { followUp }, user });
    expect(followUp).toHaveBeenCalledOnce();
    const payload = followUp.mock.calls[0][0];
    expect(payload.content).toContain('**Steve**');
    expect(menuJson(payload.components).custom_id).toBe(`perm:grant:${user._id.toString()}`);
  });
});

describe('handleGrantSelect', () => {
  function fakeInteraction({ customId, values }) {
    return {
      customId,
      values,
      user: { tag: 'pal#0001' },
      update: vi.fn(),
      reply: vi.fn(),
      replied: false,
      deferred: false,
    };
  }

  it('sets exactly the selected set and re-renders the menu with new defaults', async () => {
    const a = await Projects.createProject('A');
    const b = await Projects.createProject('B');
    const user = await Users.findOrCreateUserByName('Steve');
    await Users.setUserProjects(user._id.toString(), [a._id.toString()]);

    const interaction = fakeInteraction({
      customId: `perm:grant:${user._id.toString()}`,
      values: [b._id.toString()],
    });
    await handleGrantSelect(interaction);

    expect((await Users.findUserByName('Steve')).project_ids).toEqual([b._id.toString()]);
    expect((await Users.findUserByName('Steve')).last_granted_by).toBe('pal#0001');
    expect(interaction.update).toHaveBeenCalledOnce();
    const payload = interaction.update.mock.calls[0][0];
    expect(payload.content).toContain('**B**');
    expect(payload.content).toContain('pal#0001');
    const menu = menuJson(payload.components);
    expect(menu.options.find((o) => o.value === b._id.toString()).default).toBe(true);
    expect(menu.options.find((o) => o.value === a._id.toString()).default).toBe(false);
  });

  it('an empty selection revokes everything', async () => {
    const a = await Projects.createProject('A');
    const user = await Users.findOrCreateUserByName('Steve');
    await Users.setUserProjects(user._id.toString(), [a._id.toString()]);

    const interaction = fakeInteraction({
      customId: `perm:grant:${user._id.toString()}`,
      values: [],
    });
    await handleGrantSelect(interaction);
    expect((await Users.findUserByName('Steve')).project_ids).toEqual([]);
    expect(interaction.update.mock.calls[0][0].content).toContain('none');
  });

  it('silently drops stale project ids from deleted projects', async () => {
    const a = await Projects.createProject('A');
    const user = await Users.findOrCreateUserByName('Steve');
    const interaction = fakeInteraction({
      customId: `perm:grant:${user._id.toString()}`,
      values: [a._id.toString(), new ObjectId().toString()],
    });
    await handleGrantSelect(interaction);
    expect((await Users.findUserByName('Steve')).project_ids).toEqual([a._id.toString()]);
  });

  it('acks unknown users ephemerally without throwing, ignores foreign custom_ids', async () => {
    await Projects.createProject('A');
    const unknown = fakeInteraction({
      customId: `perm:grant:${new ObjectId().toString()}`,
      values: [],
    });
    await handleGrantSelect(unknown);
    expect(unknown.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(unknown.update).not.toHaveBeenCalled();

    const foreign = fakeInteraction({ customId: 'other:thing', values: [] });
    await handleGrantSelect(foreign);
    expect(foreign.reply).not.toHaveBeenCalled();
    expect(foreign.update).not.toHaveBeenCalled();
  });
});
