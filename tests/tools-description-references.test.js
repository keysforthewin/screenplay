// Guards a failure mode `tools-schema.test.js` cannot see: a tool DESCRIPTION
// that tells the model to call a tool which no longer exists.
//
// The schema test enforces TOOLS <-> HANDLERS parity, but descriptions are free
// text — nothing checked the tool names inside them. Three removed tools
// (`update_character`, `update_beat`, `append_to_beat_body`) survived in eight
// descriptions long after the unified `edit` tool replaced them. The visible
// symptom: `create_beat` said "leave the body empty and use
// append_to_beat_body later", so asking for a beat and describing the scene
// produced an empty beat and the user had to ask a second time. The model
// followed its instructions exactly; the instructions pointed at nothing.
//
// Heuristic: flag any snake_case identifier in a description whose first
// segment is a verb used by a real tool name (`update_`, `create_`, `edit_`,
// ...) but which is not itself a real tool. That shape is what a tool
// reference looks like, and it catches bare prose mentions ("...before calling
// edit_beat_body") that a `name(`-style check misses.

import { describe, it, expect } from 'vitest';
import { TOOLS } from '../src/agent/tools.js';

// Identifiers that share a tool's verb prefix but are API vocabulary, not tools.
const API_VOCAB = new Set(['tool_use', 'tool_result']);

const realToolNames = new Set(TOOLS.map((t) => t.name));
// Verb = first segment of a real tool name, e.g. `update` from
// `update_character_template`. An unknown identifier starting with one of
// these reads as a tool reference.
const toolVerbs = new Set([...realToolNames].map((n) => n.split('_')[0]));
// Deriving verbs only from surviving tools leaves a hole: when the last tool
// using a verb is deleted, references to it stop looking like tool names.
// That is exactly how `append_to_beat_body` hid — nothing else starts with
// `append`. Seed the plausible tool verbs that no current tool happens to use.
for (const verb of [
  'append', 'insert', 'fetch', 'write', 'apply',
  'rename', 'copy', 'fill', 'put', 'send', 'make', 'open', 'close',
]) {
  toolVerbs.add(verb);
}

// Every parameter name across every schema. Params legitimately share tool
// verbs (`attach_to_beat`, `set_as_main`, `replace_source`) and are referenced
// by name in prose, so they are not tool references.
function collectParamNames() {
  const names = new Set();
  const walk = (schema) => {
    if (!schema || typeof schema !== 'object') return;
    for (const [key, value] of Object.entries(schema.properties || {})) {
      names.add(key);
      walk(value);
    }
    if (schema.items) walk(schema.items);
  };
  for (const tool of TOOLS) walk(tool.input_schema);
  return names;
}
const paramNames = collectParamNames();

// Model-facing text for one tool: its description plus every description
// nested in its schema.
function modelFacingText(tool) {
  return `${tool.description || ''} ${JSON.stringify(tool.input_schema || {})}`;
}

const IDENTIFIER = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g;

function danglingReferences(tool) {
  const text = modelFacingText(tool);
  const found = new Set();
  for (const match of text.matchAll(IDENTIFIER)) {
    const name = match[0];
    if (realToolNames.has(name)) continue;
    if (paramNames.has(name)) continue;
    if (API_VOCAB.has(name)) continue;
    if (!toolVerbs.has(name.split('_')[0])) continue;
    // Brace-expansion shorthand, e.g. `attach_library_image_to_{beat,character}`
    // — the match stops at the brace, so the truncated stem is not a reference.
    if (text.slice(match.index + name.length).startsWith('_{')) continue;
    found.add(name);
  }
  return [...found];
}

describe('tool descriptions', () => {
  it('never point the model at a tool that does not exist', () => {
    const offenders = TOOLS.flatMap((tool) =>
      danglingReferences(tool).map((ref) => `${tool.name} -> ${ref}`),
    );
    expect(offenders).toEqual([]);
  });

  it('does not regress the specific tools that were removed', () => {
    // These three were replaced by `edit` / `set_field`. If one reappears in a
    // description, the model will try to call it and silently stall.
    const retired = ['update_character', 'update_beat', 'append_to_beat_body'];
    const offenders = [];
    for (const tool of TOOLS) {
      const text = modelFacingText(tool);
      for (const name of retired) {
        // \b alone would let `update_character_template` (a real tool) match
        // `update_character`; require the name not continue into another segment.
        if (new RegExp(`\\b${name}(?![a-z0-9_])`).test(text)) {
          offenders.push(`${tool.name} -> ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('detects a dangling reference when one is introduced', () => {
    // Proves the heuristic actually fires — a green suite above should mean
    // "clean", not "the check silently matches nothing".
    const planted = {
      name: 'fake_tool',
      description: 'Locate the snippet before calling edit_beat_body.',
      input_schema: { type: 'object', properties: {} },
    };
    expect(danglingReferences(planted)).toEqual(['edit_beat_body']);
  });
});
