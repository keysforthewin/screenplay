import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { errorMock } = vi.hoisted(() => ({ errorMock: vi.fn() }));
vi.mock('../src/log.js', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: errorMock,
  },
}));

const handlersMod = await import('../src/agent/handlers.js');
const { HANDLERS, dispatchTool } = handlersMod;

describe('dispatchTool error logging', () => {
  beforeEach(() => {
    errorMock.mockClear();
  });
  afterEach(() => {
    delete HANDLERS.__test_throws__;
  });

  it('logs tool name, message, and stack trace at error level when handler throws', async () => {
    HANDLERS.__test_throws__ = async () => {
      throw new Error('synthetic boom');
    };
    const result = await dispatchTool('__test_throws__', {});
    expect(result).toBe('Tool error (__test_throws__): synthetic boom');
    expect(errorMock).toHaveBeenCalledTimes(1);
    const logged = String(errorMock.mock.calls[0][0]);
    expect(logged).toContain('__test_throws__');
    expect(logged).toContain('synthetic boom');
    // Stack frames always start with `at ` somewhere — proves the stack is included.
    expect(logged).toMatch(/\n.*at /);
  });

  it('still returns the model-visible Tool error string after logging', async () => {
    HANDLERS.__test_throws__ = async () => {
      throw new Error('another boom');
    };
    const result = await dispatchTool('__test_throws__', { foo: 'bar' });
    expect(result).toMatch(/^Tool error \(__test_throws__\): another boom$/);
  });

  it('does not log for unknown tools (returns Unknown tool message)', async () => {
    const result = await dispatchTool('__nonexistent__', {});
    expect(result).toBe('Unknown tool: __nonexistent__');
    expect(errorMock).not.toHaveBeenCalled();
  });
});
