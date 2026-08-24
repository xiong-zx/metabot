/** Minimal ArcRunner so the data-directory lock tests need no official release. */
export function createArcRunner() {
  const idle = async () => ({ state: 'running' });
  return {
    start: async (input) => ({ id: `lock-fixture-${input.run_id}` }),
    recover: idle,
    pause: async () => ({ state: 'paused' }),
    resume: idle,
    cancel: async () => ({ state: 'cancelled' }),
    collect: () => new Promise(() => {}),
  };
}
