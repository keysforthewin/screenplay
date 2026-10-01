import { describe, it, expect, beforeEach } from 'vitest';
import { config } from '../src/config.js';
import {
  MODEL_SLOT_KEYS,
  modelFor,
  defaultModelFor,
  setModelOverrides,
  getModelOverrides,
  describeModelSlots,
  isValidModelId,
  isHarnessModelId,
  parseHarnessModel,
  encodeHarnessModel,
  normalizeHarnessTarget,
} from '../src/llm/modelSlots.js';

beforeEach(() => {
  setModelOverrides({});
  process.env.LLM_HARNESS_ENABLED = '';
});

describe('modelFor', () => {
  it('falls back to the family env default when no override is set', () => {
    expect(modelFor('agent')).toBe(config.anthropic.agentModel);
    expect(modelFor('writer')).toBe(config.anthropic.model);
    expect(modelFor('dialog')).toBe(config.anthropic.model);
    expect(modelFor('enhancer')).toBe(config.anthropic.enhancerModel);
  });

  it('returns the override once set and reverts when cleared', () => {
    setModelOverrides({ writer: 'claude-haiku-4-5' });
    expect(modelFor('writer')).toBe('claude-haiku-4-5');
    expect(modelFor('dialog')).toBe(config.anthropic.model); // untouched
    setModelOverrides({});
    expect(modelFor('writer')).toBe(defaultModelFor('writer'));
  });

  it('ignores unknown keys and malformed ids', () => {
    setModelOverrides({ bogus: 'claude-x', writer: 'Not A Model', dialog: '' });
    expect(getModelOverrides()).toEqual(Object.fromEntries(MODEL_SLOT_KEYS.map((k) => [k, null])));
  });

  it('throws on an unknown slot', () => {
    expect(() => modelFor('nope')).toThrow(/unknown model slot/);
  });

  it('describeModelSlots reports default/override/effective per slot', () => {
    setModelOverrides({ agent: 'claude-opus-5' });
    const agent = describeModelSlots().find((s) => s.key === 'agent');
    expect(agent.override).toBe('claude-opus-5');
    expect(agent.effective).toBe('claude-opus-5');
    expect(agent.default).toBe(config.anthropic.agentModel);
  });

  it('isValidModelId accepts Anthropic-shaped ids only', () => {
    expect(isValidModelId('claude-fable-5-1')).toBe(true);
    expect(isValidModelId('claude-haiku-4-5-20251001')).toBe(true);
    expect(isValidModelId('')).toBe(false);
    expect(isValidModelId('has space')).toBe(false);
    expect(isValidModelId(null)).toBe(false);
  });
});

describe('coding-agent harness targets', () => {
  it('encodes and parses provider:model:effort ids', () => {
    expect(encodeHarnessModel({ provider: 'codex', model: 'gpt-6-sol', effort: 'xhigh' })).toBe('codex:gpt-6-sol:xhigh');
    expect(encodeHarnessModel({ provider: 'claude-code', model: null, effort: null })).toBe('claude-code:default:default');
    expect(parseHarnessModel('claude-code:opus:default')).toEqual({ provider: 'claude-code', model: 'opus', effort: null });
    expect(parseHarnessModel('claude-opus-5')).toBeNull();
    expect(isHarnessModelId('codex:gpt-5.5:high')).toBe(true);
    expect(isHarnessModelId('claude-fable-5-1')).toBe(false);
    // Encoded ids still pass the generic id check other code relies on.
    expect(isValidModelId('codex:gpt-5.5:high')).toBe(true);
  });

  it('normalizes targets and rejects bad ones', () => {
    expect(normalizeHarnessTarget({ provider: 'claude-code', model: ' Opus ', effort: '' })).toEqual({
      provider: 'claude-code',
      model: 'opus',
      effort: null,
    });
    expect(() => normalizeHarnessTarget({ provider: 'nope' })).toThrow(/unknown provider/);
    expect(() => normalizeHarnessTarget({ provider: 'claude-code', effort: 'minimal' })).toThrow(/effort/);
    expect(() => normalizeHarnessTarget({ provider: 'codex', model: 'default' })).toThrow(/model/);
  });

  it('modelFor encodes a harness override only while the harness is enabled', () => {
    setModelOverrides({ writer: { provider: 'claude-code', model: 'opus', effort: 'max' } });
    expect(modelFor('writer')).toBe(config.anthropic.model);
    process.env.LLM_HARNESS_ENABLED = '1';
    expect(modelFor('writer')).toBe('claude-code:opus:max');
    const writer = describeModelSlots().find((s) => s.key === 'writer');
    expect(writer.provider).toBe('claude-code');
    expect(writer.effort).toBe('max');
    expect(describeModelSlots().find((s) => s.key === 'dialog').provider).toBe('api');
  });
});
