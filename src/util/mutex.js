export function keyedMutex() {
  const queues = new Map();
  return {
    run(key, fn) {
      const prev = queues.get(key) || Promise.resolve();
      const next = prev.then(() => fn(), () => fn());
      queues.set(
        key,
        next.finally(() => {
          if (queues.get(key) === next) queues.delete(key);
        }),
      );
      return next;
    },
  };
}
