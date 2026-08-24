/**
 * Tests for the crew-binned consumption learner.
 * @file learning.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ConsumptionLearner,
  MIN_INTERVAL_HOURS,
  MAX_INTERVAL_HOURS,
} = require("../plugin/learning.js");

test.describe("ConsumptionLearner", () => {
  test("seeds a new crew bin at the observed rate", () => {
    const learner = new ConsumptionLearner();
    const updated = learner.update({
      crewCount: 2,
      intervalHours: 24,
      liters: 48,
      timestamp: 1000,
    });
    assert.ok(updated);
    const bin = learner.bins.get(2);
    assert.ok(bin);
    assert.strictEqual(bin.rate, 48);
    assert.strictEqual(bin.samples, 1);
    assert.strictEqual(bin.lastUpdate, 1000);
  });

  test("keeps separate bins per crew count", () => {
    const learner = new ConsumptionLearner();
    learner.update({ crewCount: 1, intervalHours: 24, liters: 20 });
    learner.update({ crewCount: 3, intervalHours: 24, liters: 90 });
    assert.strictEqual(learner.bins.size, 2);
    assert.strictEqual(learner.bins.get(1)?.rate, 20);
    assert.strictEqual(learner.bins.get(3)?.rate, 90);
  });

  test("applies EMA with full alpha for a 24 h interval", () => {
    const learner = new ConsumptionLearner({ emaAlpha: 0.05 });
    learner.update({ crewCount: 2, intervalHours: 24, liters: 48 });
    // Second day: 96 l consumed → 96 l/day observed
    learner.update({ crewCount: 2, intervalHours: 24, liters: 96 });
    // alphaEff = 0.05 for a full-day interval
    assert.ok(
      Math.abs(learner.bins.get(2).rate - (0.05 * 96 + 0.95 * 48)) < 1e-9,
    );
  });

  test("weights short intervals less than full-day intervals", () => {
    const a = new ConsumptionLearner({ emaAlpha: 0.05 });
    const b = new ConsumptionLearner({ emaAlpha: 0.05 });
    for (const learner of [a, b]) {
      learner.update({ crewCount: 2, intervalHours: 24, liters: 48 });
    }
    // Both observe 96 l/day, but a over a full 24 h interval (full alpha)
    // and b over a single 15-minute tick (alpha weighted down to ~1/96)
    a.update({ crewCount: 2, intervalHours: 24, liters: 96 });
    b.update({ crewCount: 2, intervalHours: 15 / 60, liters: 1 });
    // The full-day interval must move the EMA more than the short tick
    assert.ok(a.bins.get(2).rate > b.bins.get(2).rate);
    // …but the short tick still nudges toward the observation
    assert.ok(b.bins.get(2).rate > 48);
    assert.ok(a.bins.get(2).rate - 48 > (b.bins.get(2).rate - 48) * 10);
  });

  test("rejects intervals that are too short or too long", () => {
    const learner = new ConsumptionLearner();
    assert.ok(
      !learner.update({ crewCount: 2, intervalHours: 0.01, liters: 5 }),
    );
    assert.ok(
      !learner.update({
        crewCount: 2,
        intervalHours: MAX_INTERVAL_HOURS + 1,
        liters: 5,
      }),
    );
    assert.strictEqual(learner.bins.size, 0);
    // Boundary values are accepted
    assert.ok(
      learner.update({
        crewCount: 2,
        intervalHours: MIN_INTERVAL_HOURS,
        liters: 1,
      }),
    );
  });

  test("rejects unknown crew and invalid liters", () => {
    const learner = new ConsumptionLearner();
    assert.ok(
      !learner.update({ crewCount: null, intervalHours: 24, liters: 10 }),
    );
    assert.ok(!learner.update({ crewCount: 2, intervalHours: 24, liters: -5 }));
    assert.ok(
      !learner.update({ crewCount: 2, intervalHours: 24, liters: NaN }),
    );
    assert.strictEqual(learner.bins.size, 0);
  });

  test("clamps absurd rates to the sanity ceiling", () => {
    const learner = new ConsumptionLearner({ maxRate: 200 });
    learner.update({ crewCount: 2, intervalHours: 24, liters: 1000 });
    assert.strictEqual(learner.bins.get(2)?.rate, 200);
  });

  test("getRate returns null for unknown crew or empty learner", () => {
    const learner = new ConsumptionLearner();
    assert.strictEqual(learner.getRate(2), null);
    assert.strictEqual(learner.getRate(null), null);
  });

  test("getRate requires minSamples before a bin is learned", () => {
    const learner = new ConsumptionLearner({ minSamples: 3 });
    learner.update({ crewCount: 2, intervalHours: 24, liters: 48 });
    assert.strictEqual(learner.getRate(2), null);
    learner.update({ crewCount: 2, intervalHours: 24, liters: 48 });
    learner.update({ crewCount: 2, intervalHours: 24, liters: 48 });
    assert.strictEqual(learner.getRate(2), 48);
  });

  test("getRate interpolates between learned bins", () => {
    const learner = new ConsumptionLearner({ minSamples: 3 });
    for (let i = 0; i < 3; i++) {
      learner.update({ crewCount: 1, intervalHours: 24, liters: 20 });
      learner.update({ crewCount: 3, intervalHours: 24, liters: 60 });
    }
    assert.strictEqual(learner.getRate(2), 40);
  });

  test("getRate falls back to the nearest learned bin outside the range", () => {
    const learner = new ConsumptionLearner({ minSamples: 3 });
    for (let i = 0; i < 3; i++) {
      learner.update({ crewCount: 2, intervalHours: 24, liters: 40 });
    }
    assert.strictEqual(learner.getRate(5), 40);
    assert.strictEqual(learner.getRate(1), 40);
  });

  test("learnedBins lists bins that passed the sample gate", () => {
    const learner = new ConsumptionLearner({ minSamples: 3 });
    learner.update({ crewCount: 2, intervalHours: 24, liters: 40 });
    for (let i = 0; i < 3; i++) {
      learner.update({ crewCount: 4, intervalHours: 24, liters: 80 });
    }
    const learned = learner.learnedBins();
    assert.strictEqual(learned.length, 1);
    assert.strictEqual(learned[0].crew, 4);
    assert.strictEqual(learned[0].rate, 80);
  });

  test("survives a JSON round-trip", () => {
    const learner = new ConsumptionLearner({ emaAlpha: 0.1, minSamples: 2 });
    learner.update({
      crewCount: 2,
      intervalHours: 24,
      liters: 48,
      timestamp: 1234,
    });
    learner.update({
      crewCount: 2,
      intervalHours: 12,
      liters: 30,
      timestamp: 5678,
    });

    const restored = ConsumptionLearner.fromJSON(
      JSON.parse(JSON.stringify(learner.toJSON())),
    );
    assert.strictEqual(restored.bins.size, 1);
    const bin = restored.bins.get(2);
    assert.ok(bin);
    assert.strictEqual(bin.rate, learner.bins.get(2).rate);
    assert.strictEqual(bin.samples, learner.bins.get(2).samples);
    assert.strictEqual(bin.lastUpdate, 5678);
    assert.strictEqual(restored.getRate(2), learner.getRate(2));
  });

  test("fromJSON skips corrupt entries", () => {
    const learner = ConsumptionLearner.fromJSON({
      bins: {
        2: { rate: 40, samples: 5 },
        "not-a-number": { rate: 10, samples: 1 },
        3: { rate: NaN, samples: 1 },
      },
    });
    assert.strictEqual(learner.bins.size, 1);
    assert.ok(learner.bins.has(2));
  });
});
