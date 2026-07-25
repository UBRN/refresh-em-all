const { runPool } = require('./harness');
const { PROFILES } = require('./reliability-scenario');

describe('E2E reliability harness', () => {
  test('bounded worker pool preserves result order and concurrency', async () => {
    let activeWorkers = 0;
    let maximumWorkers = 0;
    const values = Array.from({ length: 12 }, (_, index) => index + 1);

    const results = await runPool(values, 4, async value => {
      activeWorkers++;
      maximumWorkers = Math.max(maximumWorkers, activeWorkers);
      await Promise.resolve();
      activeWorkers--;
      return value * 2;
    });

    expect(results).toEqual(values.map(value => value * 2));
    expect(maximumWorkers).toBe(4);
  });

  test('profiles exercise normal, medium, and large tab ranges', () => {
    expect(PROFILES.smoke).toMatchObject({ tabCount: 8, tabsPerWindow: 4 });
    expect(PROFILES.medium).toMatchObject({ tabCount: 20, tabsPerWindow: 10 });
    expect(PROFILES.full).toMatchObject({ tabCount: 50, tabsPerWindow: 25 });
  });
});
