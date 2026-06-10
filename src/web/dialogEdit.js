// LLM-driven batch edit endpoint for a beat's dialog.
//
// Given a natural-language instruction ("delete #2, change #4's character to
// Bob, add a line at the end where Alice apologizes"), call Anthropic with
// four operation tools — add / update / move / delete — collect every
// tool_use the model emits, validate them against the original list, and
// apply them in a single transactional batch.
//
// All numbers in the model's tool calls refer to the ORIGINAL list (the
// snapshot taken at request time). They do not shift across operations
// within one batch; the system prompt tells the model so explicitly.

import { config } from '../config.js';
import { logger } from '../log.js';
import { listDialogs } from '../mongo/dialogs.js';
import { stripMarkdown } from '../util/markdown.js';
import { getAnthropic } from '../anthropic/client.js';
import {
  createDialogViaGateway,
  deleteDialogViaGateway,
  reorderDialogsViaGateway,
  setDialogTextFieldViaGateway,
} from './gateway.js';

const SYSTEM_PROMPT = [
  'You are editing the dialog for a screenplay beat. The current dialog items are listed below, numbered 1 through N as `#K  CHARACTER: BODY`. The user will give you natural-language editing instructions. Translate them into one or more tool calls.',
  '',
  'Numbers in your tool calls always refer to this original list. Numbers do NOT shift during your batch. If you delete item 2 and update item 3, the update applies to the item I labeled #3 below — not the item that becomes #2 after the delete.',
  '',
  '`after_item_number = 0` means "place at the very start". `after_item_number = N` (the current item count) means "append to the end". Multiple `add` calls with the same `after_item_number` are inserted in the order you call them.',
  '',
  'You may not also update or move an item you have deleted in the same batch.',
  '',
  'A dialog item has two fields: `character` (the speaker) and `body` (what they say). When updating, supply only the field(s) you are changing. When adding, supply both.',
  '',
  'If the instruction is ambiguous or does not actually require any change, emit no tool calls and explain why in your text reply.',
].join('\n');

const EDIT_TOOLS = [
  {
    name: 'update',
    description:
      "Rewrite a dialog item's body and/or character. Supply only the field(s) you are changing. " +
      'The number refers to the original list shown to you.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['item_number'],
      properties: {
        item_number: { type: 'integer', minimum: 1 },
        body: { type: 'string' },
        character: { type: 'string' },
      },
    },
  },
  {
    name: 'delete',
    description:
      'Delete a dialog item. The number refers to the original list. Do not also ' +
      'update or move the same number in this batch.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['item_number'],
      properties: {
        item_number: { type: 'integer', minimum: 1 },
      },
    },
  },
  {
    name: 'move',
    description:
      'Move a dialog item to a new position. Both numbers refer to the original list. ' +
      "after_item_number=0 means 'move to the very start'. after_item_number must not equal item_number.",
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['item_number', 'after_item_number'],
      properties: {
        item_number: { type: 'integer', minimum: 1 },
        after_item_number: { type: 'integer', minimum: 0 },
      },
    },
  },
  {
    name: 'add',
    description:
      "Insert a new dialog item with the given character and body. after_item_number=0 " +
      "means 'insert at the very start'; after_item_number=N means 'append to the end'.",
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['after_item_number', 'character', 'body'],
      properties: {
        after_item_number: { type: 'integer', minimum: 0 },
        character: { type: 'string' },
        body: { type: 'string' },
      },
    },
  },
];

export class InvalidOpsError extends Error {
  constructor(details) {
    super('Invalid edit operations.');
    this.code = 'INVALID_OPS';
    this.details = details;
  }
}

export async function editDialog({ projectId, beatId, instructions }) {
  const originals = await listDialogs({ beatId });
  const N = originals.length;

  // Build the user message: numbered list of current items + instruction.
  const numberedList = originals.length
    ? originals
        .map((d, i) => {
          const speaker = stripMarkdown(d.character || '').trim() || '(no speaker)';
          const body = stripMarkdown(d.body || '').trim() || '(empty)';
          return `${i + 1}. ${speaker}: ${body}`;
        })
        .join('\n')
    : '(no items yet)';
  const userText = [
    'Current dialog items:',
    numberedList,
    '',
    'User instructions:',
    instructions.trim(),
  ].join('\n');

  const client = getAnthropic();
  const resp = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: EDIT_TOOLS,
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
  });

  // Collect every tool_use the model emitted, in order.
  const ops = (resp.content || [])
    .filter((b) => b && b.type === 'tool_use')
    .map((b) => ({ name: b.name, input: b.input || {} }));

  if (!ops.length) {
    return {
      ok: true,
      ops_applied: { add: 0, update: 0, move: 0, delete: 0 },
      message: 'No changes were proposed. Try a more specific instruction.',
      dialogs: originals,
    };
  }

  // Phase 1: validate every op against the original snapshot. Collect every
  // failure so the user gets a complete picture rather than one-at-a-time.
  const details = validateOps(ops, N);
  if (details.length) {
    logger.warn(
      `dialog edit: invalid ops for beat=${beatId} (${details.length} problems)`,
    );
    throw new InvalidOpsError(details);
  }

  // Phase 2: build a working list of plan entries and apply ops.
  const result = applyOps(ops, originals);

  // Phase 3: commit. Order matters because each gateway call broadcasts.
  // (1) Deletes first so the SPA's count drops before adds arrive.
  for (const entry of result.deletes) {
    await deleteDialogViaGateway({ projectId, dialogId: entry.id });
  }
  // (2) Updates on surviving originals — write each changed field.
  for (const entry of result.updates) {
    if (entry.bodyChanged) {
      await setDialogTextFieldViaGateway({
        projectId,
        dialogId: entry.id,
        field: 'body',
        text: entry.body,
      });
    }
    if (entry.characterChanged) {
      await setDialogTextFieldViaGateway({
        projectId,
        dialogId: entry.id,
        field: 'character',
        text: entry.character,
      });
    }
  }
  // (3) Creates for new items. Capture the new ids so we can reorder.
  // seedFragments populates the y-doc body/character fragments before the
  // gateway broadcasts its ping, so the SPA shows the inserted text
  // immediately rather than after a reload.
  const newIdsByToken = new Map(); // tokenIndex → new dialog _id
  for (const entry of result.creates) {
    const d = await createDialogViaGateway({
      projectId,
      beatId,
      body: entry.body,
      character: entry.character,
      seedFragments: { body: entry.body, character: entry.character },
    });
    newIdsByToken.set(entry.tokenIndex, d._id.toString());
  }
  // (4) Final reorder if order changed (move ops, adds, or deletes happened).
  if (result.reorderRequired) {
    const orderedIds = result.finalTokens.map((t) => {
      if (t.kind === 'keep') return String(t.id);
      if (t.kind === 'new') return newIdsByToken.get(t.tokenIndex);
      throw new Error('unreachable');
    });
    await reorderDialogsViaGateway({ projectId, beatId, orderedIds });
  }

  const fresh = await listDialogs({ beatId });
  return {
    ok: true,
    ops_applied: {
      add: result.counts.add,
      update: result.counts.update,
      move: result.counts.move,
      delete: result.counts.delete,
    },
    dialogs: fresh,
  };
}

// ---------------------------------------------------------------------------
// Op validation — pre-flight all ops against the original snapshot. Returns
// an array of { op, reason } describing every problem; an empty array means
// the batch is safe to apply.

function validateOps(ops, N) {
  const details = [];
  const deletedSet = new Set(); // original-1-based numbers being deleted

  // First pass: collect all deletes so we can flag conflicts in the second pass.
  for (const op of ops) {
    if (op.name === 'delete') {
      const n = op.input?.item_number;
      if (Number.isInteger(n) && n >= 1 && n <= N) deletedSet.add(n);
    }
  }

  for (const op of ops) {
    const reason = validateOne(op, N, deletedSet);
    if (reason) details.push({ op: op.name, input: op.input, reason });
  }
  return details;
}

function validateOne(op, N, deletedSet) {
  const inp = op.input || {};
  switch (op.name) {
    case 'update': {
      const n = inp.item_number;
      if (!Number.isInteger(n) || n < 1 || n > N) {
        return `item_number ${n} is out of range (must be 1..${N})`;
      }
      if (deletedSet.has(n)) {
        return `item ${n} is also being deleted in this batch`;
      }
      const hasBody = typeof inp.body === 'string';
      const hasCharacter = typeof inp.character === 'string';
      if (!hasBody && !hasCharacter) {
        return `update must include at least one of \`body\` or \`character\``;
      }
      return null;
    }
    case 'delete': {
      const n = inp.item_number;
      if (!Number.isInteger(n) || n < 1 || n > N) {
        return `item_number ${n} is out of range (must be 1..${N})`;
      }
      return null;
    }
    case 'move': {
      const n = inp.item_number;
      const m = inp.after_item_number;
      if (!Number.isInteger(n) || n < 1 || n > N) {
        return `item_number ${n} is out of range (must be 1..${N})`;
      }
      if (!Number.isInteger(m) || m < 0 || m > N) {
        return `after_item_number ${m} is out of range (must be 0..${N})`;
      }
      if (m === n) {
        return `cannot move item ${n} after itself`;
      }
      if (deletedSet.has(n)) {
        return `item ${n} is also being deleted in this batch`;
      }
      if (m !== 0 && deletedSet.has(m)) {
        return `move target after_item_number=${m} is also being deleted; pick a different anchor`;
      }
      return null;
    }
    case 'add': {
      const m = inp.after_item_number;
      if (!Number.isInteger(m) || m < 0 || m > N) {
        return `after_item_number ${m} is out of range (must be 0..${N})`;
      }
      if (typeof inp.body !== 'string' || !inp.body.trim()) {
        return `body must be a non-empty string`;
      }
      if (typeof inp.character !== 'string' || !inp.character.trim()) {
        return `character must be a non-empty string`;
      }
      return null;
    }
    default:
      return `unknown tool: ${op.name}`;
  }
}

// ---------------------------------------------------------------------------
// Apply ops to a working list of tokens. Each token is either:
//   { kind: 'keep', id, originalIndex (1-based), body, character,
//     originalBody, originalCharacter }
//   { kind: 'new',  tokenIndex (unique), body, character }
// Returns the gateway-call plan: which keeps to delete, which keeps got new
// text, which new tokens to create, and the final ordering.

function applyOps(ops, originals) {
  let tokens = originals.map((d, i) => ({
    kind: 'keep',
    id: d._id.toString(),
    originalIndex: i + 1,
    body: d.body || '',
    character: d.character || '',
    originalBody: d.body || '',
    originalCharacter: d.character || '',
  }));

  const counts = { add: 0, update: 0, move: 0, delete: 0 };
  let nextTokenIndex = 0;
  let reorderRequired = false;

  function findKeepPos(n) {
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].kind === 'keep' && tokens[i].originalIndex === n) return i;
    }
    return -1;
  }

  // Step A: updates (mutate in place — no order change).
  for (const op of ops) {
    if (op.name !== 'update') continue;
    const pos = findKeepPos(op.input.item_number);
    if (pos < 0) continue;
    if (typeof op.input.body === 'string') tokens[pos].body = op.input.body;
    if (typeof op.input.character === 'string') {
      tokens[pos].character = op.input.character;
    }
    counts.update += 1;
  }

  // Step B: deletes (mark for removal — keep tokens in place so subsequent
  // ops that reference deleted-but-validated items can still find them).
  for (const op of ops) {
    if (op.name !== 'delete') continue;
    const pos = findKeepPos(op.input.item_number);
    if (pos < 0) continue;
    tokens[pos].kind = 'delete';
    counts.delete += 1;
    reorderRequired = true;
  }

  // Step C: adds, in tool-call order.
  for (const op of ops) {
    if (op.name !== 'add') continue;
    const m = op.input.after_item_number;
    const tokenIndex = nextTokenIndex++;
    const newToken = {
      kind: 'new',
      tokenIndex,
      body: op.input.body,
      character: op.input.character,
    };
    if (m === 0) {
      tokens.unshift(newToken);
    } else {
      let pos = -1;
      for (let i = 0; i < tokens.length; i++) {
        if (
          (tokens[i].kind === 'keep' || tokens[i].kind === 'delete') &&
          tokens[i].originalIndex === m
        ) {
          pos = i;
          break;
        }
      }
      let insertAt = pos + 1;
      while (insertAt < tokens.length && tokens[insertAt].kind === 'new') {
        insertAt += 1;
      }
      tokens.splice(insertAt, 0, newToken);
    }
    counts.add += 1;
    reorderRequired = true;
  }

  // Step D: moves, in tool-call order, against the working list.
  for (const op of ops) {
    if (op.name !== 'move') continue;
    const fromPos = findKeepPos(op.input.item_number);
    if (fromPos < 0) continue;
    const moving = tokens.splice(fromPos, 1)[0];
    const m = op.input.after_item_number;
    if (m === 0) {
      tokens.unshift(moving);
    } else {
      let anchorPos = -1;
      for (let i = 0; i < tokens.length; i++) {
        if (
          (tokens[i].kind === 'keep' || tokens[i].kind === 'delete') &&
          tokens[i].originalIndex === m
        ) {
          anchorPos = i;
          break;
        }
      }
      if (anchorPos < 0) {
        logger.warn(`dialog edit: move anchor ${m} not found; appending at end`);
        tokens.push(moving);
      } else {
        let insertAt = anchorPos + 1;
        while (insertAt < tokens.length && tokens[insertAt].kind === 'new') {
          insertAt += 1;
        }
        tokens.splice(insertAt, 0, moving);
      }
    }
    counts.move += 1;
    reorderRequired = true;
  }

  // Build the gateway-call plan.
  const deletes = tokens.filter((t) => t.kind === 'delete');
  const updates = tokens
    .filter(
      (t) =>
        t.kind === 'keep' &&
        (t.body !== t.originalBody || t.character !== t.originalCharacter),
    )
    .map((t) => ({
      id: t.id,
      body: t.body,
      character: t.character,
      bodyChanged: t.body !== t.originalBody,
      characterChanged: t.character !== t.originalCharacter,
    }));
  const creates = [];
  for (let i = 0; i < nextTokenIndex; i++) {
    const t = tokens.find((x) => x.kind === 'new' && x.tokenIndex === i);
    if (t) {
      creates.push({ tokenIndex: i, body: t.body, character: t.character });
    }
  }
  const finalTokens = tokens.filter((t) => t.kind !== 'delete');

  return {
    counts,
    deletes,
    updates,
    creates,
    finalTokens,
    reorderRequired,
  };
}

// Test-only export.
export const _internals = { validateOps, applyOps };
