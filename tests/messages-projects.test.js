import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Messages = await import('../src/mongo/messages.js');
const Projects = await import('../src/mongo/projects.js');

const CHANNEL = 'chan-1';

function fakeMsg() {
  return {
    channelId: CHANNEL,
    guildId: null,
    thread: null,
    id: 'discord-1',
    author: { id: 'u1', tag: 'steve#1', bot: false },
    createdAt: new Date(),
  };
}

beforeEach(() => fakeDb.reset());

describe('message project stamping', () => {
  it('recordUserMessage stamps project_id (default project when omitted)', async () => {
    await Messages.recordUserMessage({ msg: fakeMsg(), text: 'hi', attachments: [] });
    const doc = await fakeDb.collection('messages').findOne({ role: 'user' });
    const def = await Projects.getDefaultProject();
    expect(doc.project_id).toBe(def._id.toString());
  });

  it('recordAssistantMessage and recordAgentTurns stamp an explicit projectId', async () => {
    const p1 = (await Projects.createProject('Alpha'))._id.toString();
    await Messages.recordAssistantMessage({ projectId: p1, channelId: CHANNEL, text: 'yo' });
    await Messages.recordAgentTurns({
      projectId: p1,
      channelId: CHANNEL,
      turns: [{ role: 'assistant', content: 'turn' }],
    });
    const docs = await fakeDb.collection('messages').find({}).toArray();
    expect(docs).toHaveLength(2);
    for (const d of docs) expect(d.project_id).toBe(p1);
  });

  it('searchMessages filters by project only when projectId is passed', async () => {
    const p1 = (await Projects.createProject('Alpha'))._id.toString();
    const p2 = (await Projects.createProject('Beta'))._id.toString();
    await Messages.recordAssistantMessage({ projectId: p1, channelId: CHANNEL, text: 'needle one' });
    await Messages.recordAssistantMessage({ projectId: p2, channelId: CHANNEL, text: 'needle two' });
    const all = await Messages.searchMessages({
      channelId: CHANNEL, regex: /needle/i, limit: 10, contextChars: 40,
    });
    expect(all.results).toHaveLength(2);
    const scoped = await Messages.searchMessages({
      projectId: p1, channelId: CHANNEL, regex: /needle/i, limit: 10, contextChars: 40,
    });
    expect(scoped.results).toHaveLength(1);
    expect(scoped.results[0].excerpt).toMatch(/needle one/);
  });
});
