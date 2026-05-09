// LLM-driven batch edit endpoint for a beat's storyboards.
//
// Given a natural-language instruction ("delete #2, move #4 before #1, add a
// frame at the end about Y, change #3 to talk about Z"), call Anthropic with
// four operation tools — add / update_description / move / delete — collect
// every tool_use the model emits, validate them against the original list,
// and apply them in a single transactional batch.
//
// All numbers in the model's tool calls refer to the ORIGINAL list (the
// snapshot taken at request time). They do not shift across operations
// within one batch; the system prompt tells the model so explicitly.

import { config } from '../config.js';
import { logger } from '../log.js';
import { listStoryboards } from '../mongo/storyboards.js';
import { stripMarkdown } from '../util/markdown.js';
import { getAnthropic } from '../anthropic/client.js';
import {
  createStoryboardViaGateway,
  deleteStoryboardViaGateway,
  reorderStoryboardsViaGateway,
  setStoryboardTextPromptViaGateway,
} from './gateway.js';

const SYSTEM_PROMPT = [
  'You are editing a storyboard for a screenplay beat. The current storyboard items are listed below, numbered 1 through N. The user will give you natural-language editing instructions. Translate them into one or more tool calls.',
  '',
  'Numbers in your tool calls always refer to this original list. Numbers do NOT shift during your batch. If you delete item 2 and update item 3, the update applies to the item I labeled #3 below — not the item that becomes #2 after the delete.',
  '',
  '`after_item_number = 0` means "place at the very start". `after_item_number = N` (the current item count) means "append to the end". Multiple `add` calls with the same `after_item_number` are inserted in the order you call them.',
  '',
  'You may not also update or move an item you have deleted in the same batch.',
  '',
  'Note: editing only changes text prompts and ordering. `update_description` does NOT regenerate any images — existing frame images are preserved as-is. Items you add will have no images until the user generates them. If your edit implies a meaningful visual change, say so in your text reply so the user knows to regenerate that frame.',
  '',
  'If the instruction is ambiguous or does not actually require any change, emit no tool calls and explain why in your text reply.',
].join('\n');

const EDIT_TOOLS = [
  {
    name: 'update_description',
    description:
      'Rewrite the text prompt of an existing storyboard item. The number refers ' +
      'to the original list shown to you. Does not regenerate images.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['item_number', 'text_prompt'],
      properties: {
        item_number: { type: 'integer', minimum: 1 },
        text_prompt: { type: 'string' },
      },
    },
  },
  {
    name: 'delete',
    description:
      'Delete a storyboard item. The number refers to the original list. Do not ' +
      'also update or move the same number in this batch.',
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
      "Move a storyboard item to a new position. Both numbers refer to the original list. " +
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
      "Insert a new storyboard item with the given text prompt. after_item_number=0 means " +
      "'insert at the very start'; after_item_number=N means 'append to the end'. No image " +
      'is generated for this item — start frame, end frame, and character sheet remain blank.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['after_item_number', 'text_prompt'],
      properties: {
        after_item_number: { type: 'integer', minimum: 0 },
        text_prompt: { type: 'string' },
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

export async function editStoryboard({ beatId, instructions }) {
  const originals = await listStoryboards({ beatId });
  const N = originals.length;

  // Build the user message: numbered list of current items + instruction.
  const numberedList = originals.length
    ? originals
        .map((sb, i) => {
          const text = stripMarkdown(sb.text_prompt || '').trim() || '(empty)';
          return `${i + 1}. ${text}`;
        })
        .join('\n')
    : '(no items yet)';
  const userText = [
    'Current storyboard items:',
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
      storyboards: originals,
    };
  }

  // Phase 1: validate every op against the original snapshot. Collect every
  // failure so the user gets a complete picture rather than one-at-a-time.
  const details = validateOps(ops, N);
  if (details.length) {
    logger.warn(
      `storyboard edit: invalid ops for beat=${beatId} (${details.length} problems)`,
    );
    throw new InvalidOpsError(details);
  }

  // Phase 2: build a working list of plan entries and apply ops.
  const result = applyOps(ops, originals);

  // Phase 3: commit. Order matters because each gateway call broadcasts.
  // (1) Deletes first so the SPA's count drops before adds arrive.
  for (const entry of result.deletes) {
    await deleteStoryboardViaGateway({ storyboardId: entry.id });
  }
  // (2) Updates on surviving originals.
  for (const entry of result.updates) {
    await setStoryboardTextPromptViaGateway({
      storyboardId: entry.id,
      text: entry.text,
    });
  }
  // (3) Creates for new items. Capture the new ids so we can reorder.
  // seedFragments populates the y-doc text_prompt fragment before the
  // gateway's broadcast, so the SPA shows the inserted prompt immediately.
  const newIdsByToken = new Map(); // tokenIndex → new sb _id
  for (const entry of result.creates) {
    const sb = await createStoryboardViaGateway({
      beatId,
      textPrompt: entry.text,
      seedFragments: { text_prompt: entry.text },
    });
    newIdsByToken.set(entry.tokenIndex, sb._id.toString());
  }
  // (4) Final reorder if order changed (move ops, adds, or deletes happened).
  if (result.reorderRequired) {
    const orderedIds = result.finalTokens.map((t) => {
      if (t.kind === 'keep') return String(t.id);
      if (t.kind === 'new') return newIdsByToken.get(t.tokenIndex);
      throw new Error('unreachable');
    });
    await reorderStoryboardsViaGateway({ beatId, orderedIds });
  }

  const fresh = await listStoryboards({ beatId });
  return {
    ok: true,
    ops_applied: {
      add: result.counts.add,
      update: result.counts.update,
      move: result.counts.move,
      delete: result.counts.delete,
    },
    storyboards: fresh,
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
    case 'update_description': {
      const n = inp.item_number;
      if (!Number.isInteger(n) || n < 1 || n > N) {
        return `item_number ${n} is out of range (must be 1..${N})`;
      }
      if (deletedSet.has(n)) {
        return `item ${n} is also being deleted in this batch`;
      }
      if (typeof inp.text_prompt !== 'string') {
        return `text_prompt must be a string`;
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
      if (typeof inp.text_prompt !== 'string' || !inp.text_prompt.trim()) {
        return `text_prompt must be a non-empty string`;
      }
      return null;
    }
    default:
      return `unknown tool: ${op.name}`;
  }
}

// ---------------------------------------------------------------------------
// Apply ops to a working list of tokens. Each token is either:
//   { kind: 'keep', id, originalIndex (1-based), text }
//   { kind: 'new',  tokenIndex (unique), text }
// Returns the gateway-call plan: which keeps to delete, which keeps got new
// text, which new tokens to create, and the final ordering.

function applyOps(ops, originals) {
  // Working tokens, in original order. originalIndex is 1-based.
  let tokens = originals.map((sb, i) => ({
    kind: 'keep',
    id: sb._id.toString(),
    originalIndex: i + 1,
    text: sb.text_prompt || '',
    originalText: sb.text_prompt || '',
  }));

  const counts = { add: 0, update: 0, move: 0, delete: 0 };
  let nextTokenIndex = 0;
  let reorderRequired = false;

  // Helper: find the position of the keep-token whose originalIndex is `n`.
  function findKeepPos(n) {
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].kind === 'keep' && tokens[i].originalIndex === n) return i;
    }
    return -1;
  }

  // Step A: updates (mutate in place — no order change).
  for (const op of ops) {
    if (op.name !== 'update_description') continue;
    const pos = findKeepPos(op.input.item_number);
    if (pos < 0) continue;
    tokens[pos].text = op.input.text_prompt;
    counts.update += 1;
  }

  // Step B: deletes (mark for removal — keep tokens in place so subsequent
  // ops that reference deleted-but-validated items can still find them).
  // Validation already rejected ops that touch a deleted item.
  for (const op of ops) {
    if (op.name !== 'delete') continue;
    const pos = findKeepPos(op.input.item_number);
    if (pos < 0) continue;
    tokens[pos].kind = 'delete';
    counts.delete += 1;
    reorderRequired = true;
  }

  // Step C: adds, in tool-call order. Insert after the keep-token whose
  // originalIndex matches `after_item_number`. If after_item_number=0, insert
  // at the very front. Multiple adds with the same anchor stack in tool-call
  // order naturally because each insert lands after the previous one.
  for (const op of ops) {
    if (op.name !== 'add') continue;
    const m = op.input.after_item_number;
    const tokenIndex = nextTokenIndex++;
    const newToken = {
      kind: 'new',
      tokenIndex,
      text: op.input.text_prompt,
    };
    if (m === 0) {
      tokens.unshift(newToken);
    } else {
      // Insert after the most recent token associated with original-index m
      // (which may itself be a 'delete' or 'keep' — both are fine as anchor).
      // If multiple new tokens have already landed after the same keep, we
      // want to place this one after the LAST of them so tool-call order is
      // preserved. Walk forward from the keep until we hit a different keep.
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
      // Walk forward across any 'new' tokens that already follow this keep,
      // so subsequent adds with the same anchor stack in order.
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
        // Anchor was not found — shouldn't happen because validation ensures
        // the anchor isn't deleted, but if it does, append at end as a safety.
        logger.warn(
          `storyboard edit: move anchor ${m} not found; appending at end`,
        );
        tokens.push(moving);
      } else {
        // Insert after the anchor + any trailing 'new' tokens belonging to it
        // so concurrent add+move with the same anchor produces a stable order.
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
  // Updates: keep-tokens whose text differs from their original text. (After
  // moves/adds/deletes, the keep token's text is still tracked.)
  const updates = tokens
    .filter((t) => t.kind === 'keep' && t.text !== t.originalText)
    .map((t) => ({ id: t.id, text: t.text }));
  // Creates: new tokens, in token-creation order (so we can map back from
  // tokenIndex → new sb._id once created).
  const creates = [];
  for (let i = 0; i < nextTokenIndex; i++) {
    const t = tokens.find((x) => x.kind === 'new' && x.tokenIndex === i);
    if (t) creates.push({ tokenIndex: i, text: t.text });
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
