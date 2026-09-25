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
} from '../src/llm/modelSlots.js';

beforeEach(() => setModelOverrides({}));

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
