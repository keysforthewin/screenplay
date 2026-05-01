import { describe, it, expect, vi } from 'vitest';
import { shouldIgnoreMessage } from '../src/discord/messageFilter.js';

const BOT_ID = 'BOT';
const ALICE_ID = 'ALICE';
const BOB_ID = 'BOB';

function makeMsg(overrides = {}) {
  return {
    mentions: {
      users: new Map(),
      everyone: false,
      roles: new Map(),
    },
    reference: null,
    fetchReference: vi.fn(),
    ...overrides,
  };
}

describe('shouldIgnoreMessage', () => {
  it('processes plain messages with no mentions and no reply', async () => {
    const msg = makeMsg();
    expect(await shouldIgnoreMessage(msg, BOT_ID)).toBe(false);
  });

  it('processes messages that only @mention the bot', async () => {
    const users = new Map([[BOT_ID, { id: BOT_ID }]]);
    const msg = makeMsg({ mentions: { users, everyone: false, roles: new Map() } });
    expect(await shouldIgnoreMessage(msg, BOT_ID)).toBe(false);
  });

  it('ignores messages that @mention only another user', async () => {
    const users = new Map([[ALICE_ID, { id: ALICE_ID }]]);
    const msg = makeMsg({ mentions: { users, everyone: false, roles: new Map() } });
    expect(await shouldIgnoreMessage(msg, BOT_ID)).toBe(true);
  });

  it('processes messages that @mention the bot AND another user (bot tag wins)', async () => {
    const users = new Map([
      [BOT_ID, { id: BOT_ID }],
      [ALICE_ID, { id: ALICE_ID }],
    ]);
    const msg = makeMsg({ mentions: { users, everyone: false, roles: new Map() } });
    expect(await shouldIgnoreMessage(msg, BOT_ID)).toBe(false);
  });

  it('ignores @everyone messages', async () => {
    const msg = makeMsg({
      mentions: { users: new Map(), everyone: true, roles: new Map() },
    });
    expect(await shouldIgnoreMessage(msg, BOT_ID)).toBe(true);
  });

  it('ignores @here messages (surfaces as everyone=true)', async () => {
    const msg = makeMsg({
      mentions: { users: new Map(), everyone: true, roles: new Map() },
    });
    expect(await shouldIgnoreMessage(msg, BOT_ID)).toBe(true);
  });

  it('ignores messages with role pings', async () => {
    const roles = new Map([['ROLE_1', { id: 'ROLE_1' }]]);
    const msg = makeMsg({
      mentions: { users: new Map(), everyone: false, roles },
    });
    expect(await shouldIgnoreMessage(msg, BOT_ID)).toBe(true);
  });

  it('processes replies to a bot message', async () => {
    const msg = makeMsg({
      reference: { messageId: 'M1', type: 0 },
      fetchReference: vi.fn().mockResolvedValue({ author: { id: BOT_ID } }),
    });
    expect(await shouldIgnoreMessage(msg, BOT_ID)).toBe(false);
    expect(msg.fetchReference).toHaveBeenCalledOnce();
  });

  it('ignores replies to another human and fetches the reference', async () => {
    const msg = makeMsg({
      reference: { messageId: 'M1', type: 0 },
      fetchReference: vi.fn().mockResolvedValue({ author: { id: ALICE_ID } }),
    });
    expect(await shouldIgnoreMessage(msg, BOT_ID)).toBe(true);
    expect(msg.fetchReference).toHaveBeenCalledOnce();
  });

  it('processes a reply to a human if the bot is also @mentioned (no fetch needed)', async () => {
    const users = new Map([[BOT_ID, { id: BOT_ID }]]);
    const fetchReference = vi.fn();
    const msg = makeMsg({
      mentions: { users, everyone: false, roles: new Map() },
      reference: { messageId: 'M1', type: 0 },
      fetchReference,
    });
    expect(await shouldIgnoreMessage(msg, BOT_ID)).toBe(false);
    expect(fetchReference).not.toHaveBeenCalled();
  });

  it('processes (fail-open) when fetchReference rejects', async () => {
    const msg = makeMsg({
      reference: { messageId: 'M1', type: 0 },
      fetchReference: vi.fn().mockRejectedValue(new Error('deleted')),
    });
    expect(await shouldIgnoreMessage(msg, BOT_ID)).toBe(false);
  });

  it('does not treat forwards (type !== 0) as a reply', async () => {
    const fetchReference = vi.fn();
    const msg = makeMsg({
      reference: { messageId: 'M1', type: 1 },
      fetchReference,
    });
    expect(await shouldIgnoreMessage(msg, BOT_ID)).toBe(false);
    expect(fetchReference).not.toHaveBeenCalled();
  });

  it('handles a reply that pings other users (caught by mention check before fetch)', async () => {
    const users = new Map([[BOB_ID, { id: BOB_ID }]]);
    const fetchReference = vi.fn();
    const msg = makeMsg({
      mentions: { users, everyone: false, roles: new Map() },
      reference: { messageId: 'M1', type: 0 },
      fetchReference,
    });
    expect(await shouldIgnoreMessage(msg, BOT_ID)).toBe(true);
    expect(fetchReference).not.toHaveBeenCalled();
  });
});
