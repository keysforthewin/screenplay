import { describe, it, expect } from 'vitest';
import { TOOLS } from '../src/agent/tools.js';

describe('tools', () => {
  it('every tool has name + description + input_schema', () => {
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.input_schema.type).toBe('object');
    }
  });
  it('names are unique', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
