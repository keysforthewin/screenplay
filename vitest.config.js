export default {
  test: {
    setupFiles: ['./tests/setup.js'],
    // The default 5s is too tight for this suite's heavy-import handler tests
    // when the whole suite runs in parallel (module transform/import is CPU-bound
    // and starves slow tests under load — they pass comfortably in isolation).
    // Give realistic headroom so the full `npm test` run (the deploy gate) is
    // not flaky; a genuinely hung test still fails, just later.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
};
