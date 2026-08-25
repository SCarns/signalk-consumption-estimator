/**
 * Tests for the tank estimator.
 * @file tank.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { TankEstimator } = require("../plugin/tank.js");

const HOUR = 3600 * 1000;
const T0 = 1700000000000;

/**
 * Creates an estimator with the default fresh water paths.
 *
 * @param {object} [opts] - Overrides for the estimator options
 * @returns {TankEstimator}
 */
function makeEstimator(opts = {}) {
  return new TankEstimator({
    id: "freshWater",
    name: "Fresh water",
    levelPath: "tanks.freshWater.water.currentLevel",
    remainingPath: "tanks.freshWater.water.remaining",
    predictionBase: "tanks.freshWater.water.prediction",
    ...opts,
  });
}

test.describe("TankEstimator capacity", () => {
  test("infers capacity from coincident level/remaining pairs", () => {
    const est = makeEstimator();
    est.processSample({
      remaining: 200,
      level: 0.8,
      crewCount: 2,
      timestamp: T0,
    });
    assert.strictEqual(est.capacityEstimate, 250);
    assert.strictEqual(est.capacity, 250);
  });

  test("smooths capacity estimates with an EMA", () => {
    const est = makeEstimator();
    est.processSample({
      remaining: 200,
      level: 0.8,
      crewCount: 2,
      timestamp: T0,
    });
    // 190 l at 0.76 → observed capacity 250 (no movement)
    est.processSample({
      remaining: 190,
      level: 0.76,
      crewCount: 2,
      timestamp: T0 + 12 * HOUR,
    });
    assert.strictEqual(est.capacityEstimate, 250);
    // 100 l at 0.5 → observed capacity 200 → EMA: 0.1*200 + 0.9*250
    est.processSample({
      remaining: 100,
      level: 0.5,
      crewCount: 2,
      timestamp: T0 + 24 * HOUR,
    });
    assert.strictEqual(est.capacityEstimate, 245);
  });

  test("infers capacity across separate remaining/level deltas", () => {
    const est = makeEstimator();
    // Only remaining arrives first
    est.processSample({
      remaining: 200,
      level: null,
      crewCount: 2,
      timestamp: T0,
    });
    assert.strictEqual(est.capacityEstimate, null);
    // Later, only level arrives — capacity is inferred from the remembered
    // remaining paired with the new level (200 / 0.8 = 250)
    est.processSample({
      remaining: null,
      level: 0.8,
      crewCount: 2,
      timestamp: T0 + 6 * HOUR,
    });
    assert.strictEqual(est.capacityEstimate, 250);
    assert.strictEqual(est.capacity, 250);
  });

  test("ignores level/remaining pairs at the sensor extremes", () => {
    const est = makeEstimator();
    est.processSample({
      remaining: 250,
      level: 1,
      crewCount: 2,
      timestamp: T0,
    });
    est.processSample({
      remaining: 5,
      level: 0.01,
      crewCount: 2,
      timestamp: T0 + 6 * HOUR,
    });
    assert.strictEqual(est.capacityEstimate, null);
  });

  test("configured capacity wins over the inferred estimate", () => {
    const est = makeEstimator({ capacity: 300 });
    est.processSample({
      remaining: 200,
      level: 0.8,
      crewCount: 2,
      timestamp: T0,
    });
    assert.strictEqual(est.capacity, 300);
    assert.strictEqual(est.capacityEstimate, 250);
  });
});

test.describe("TankEstimator processSample", () => {
  test("learns consumption from a decreasing remaining series", () => {
    const est = makeEstimator();
    est.processSample({
      remaining: 200,
      level: 0.8,
      crewCount: 2,
      timestamp: T0,
    });
    const res = est.processSample({
      remaining: 176,
      level: 0.704,
      crewCount: 2,
      timestamp: T0 + 24 * HOUR,
    });
    assert.strictEqual(res.status, "learned");
    assert.strictEqual(res.observedRate, 24);
    assert.strictEqual(res.learned, true);
    assert.strictEqual(est.learner.bins.get(2)?.rate, 24);
    assert.strictEqual(est.shortRate, 24);
  });

  test("detects refills and does not learn from them", () => {
    const est = makeEstimator();
    est.processSample({
      remaining: 100,
      level: 0.4,
      crewCount: 2,
      timestamp: T0,
    });
    const res = est.processSample({
      remaining: 180,
      level: 0.72,
      crewCount: 2,
      timestamp: T0 + 12 * HOUR,
    });
    assert.strictEqual(res.status, "refill");
    assert.strictEqual(res.learned, false);
    assert.strictEqual(est.learner.bins.size, 0);
    // Anchor moved to the post-fill level: the next interval learns again
    const res2 = est.processSample({
      remaining: 170,
      level: 0.68,
      crewCount: 2,
      timestamp: T0 + 24 * HOUR,
    });
    assert.strictEqual(res2.status, "learned");
    assert.strictEqual(res2.observedRate, 20);
  });

  test("skips intervals that are too short", () => {
    const est = makeEstimator();
    est.processSample({
      remaining: 200,
      level: 0.8,
      crewCount: 2,
      timestamp: T0,
    });
    const res = est.processSample({
      remaining: 190,
      level: 0.76,
      crewCount: 2,
      timestamp: T0 + 60 * 1000,
    });
    assert.strictEqual(res.status, "skipped");
    assert.strictEqual(est.learner.bins.size, 0);
  });

  test("skips learning when the source switches mid-interval", () => {
    const est = makeEstimator({ capacity: 250 });
    est.processSample({
      remaining: 200,
      level: 0.8,
      crewCount: 2,
      timestamp: T0,
    });
    // remaining goes away; level + configured capacity (250) takes over
    const res = est.processSample({
      remaining: null,
      level: 0.7,
      crewCount: 2,
      timestamp: T0 + 24 * HOUR,
    });
    assert.strictEqual(res.status, "skipped");
    assert.strictEqual(est.learner.bins.size, 0);
    // Now stable on the level source: learns
    const res2 = est.processSample({
      remaining: null,
      level: 0.6,
      crewCount: 2,
      timestamp: T0 + 48 * HOUR,
    });
    assert.strictEqual(res2.status, "learned");
    assert.strictEqual(res2.observedRate, 25);
  });

  test("returns insufficient when neither source resolves", () => {
    const est = makeEstimator();
    const res = est.processSample({
      remaining: null,
      level: null,
      crewCount: 2,
      timestamp: T0,
    });
    assert.strictEqual(res.status, "insufficient");
  });

  test("treats sub-noise consumption as zero", () => {
    const est = makeEstimator();
    est.processSample({
      remaining: 200,
      level: 0.8,
      crewCount: 2,
      timestamp: T0,
    });
    const res = est.processSample({
      remaining: 199.98,
      level: 0.8,
      crewCount: 2,
      timestamp: T0 + 12 * HOUR,
    });
    assert.strictEqual(res.status, "learned");
    assert.strictEqual(res.observedRate, 0);
  });

  test("updates the short-term rate with the fast EMA", () => {
    const est = makeEstimator({ shortAlpha: 0.3 });
    est.processSample({
      remaining: 200,
      level: 0.8,
      crewCount: 2,
      timestamp: T0,
    });
    est.processSample({
      remaining: 176,
      level: 0.704,
      crewCount: 2,
      timestamp: T0 + 24 * HOUR,
    });
    assert.strictEqual(est.shortRate, 24);
    est.processSample({
      remaining: 104,
      level: 0.416,
      crewCount: 2,
      timestamp: T0 + 48 * HOUR,
    });
    // Observed 72 l/day; short = 0.3*72 + 0.7*24
    assert.ok(Math.abs((est.shortRate ?? 0) - 38.4) < 1e-9);
  });
});

test.describe("TankEstimator predict", () => {
  test("predicts from a learned rate", () => {
    const est = makeEstimator({ capacity: 250, minSamples: 0.1 });
    est.processSample({
      remaining: 200,
      level: 0.8,
      crewCount: 2,
      timestamp: T0,
    });
    est.processSample({
      remaining: 176,
      level: 0.704,
      crewCount: 2,
      timestamp: T0 + 24 * HOUR,
    });
    const pred = est.predict({ remaining: 176, level: 0.704, crewCount: 2 });
    assert.strictEqual(pred.rateSource, "learned");
    assert.strictEqual(pred.rate, 24);
    assert.strictEqual(pred.remaining24h, 152);
    assert.strictEqual(pred.level24h, (176 - 24) / 250);
    assert.strictEqual(pred.timeToEmptyDays, 176 / 24);
  });

  test("falls back to per-crew default when nothing is learned", () => {
    const est = makeEstimator({
      defaultPerCrewLitersPerDay: 25,
      defaultCrewCount: 3,
    });
    const pred = est.predict({ remaining: 100, level: 0.4, crewCount: 2 });
    assert.strictEqual(pred.rateSource, "default");
    assert.strictEqual(pred.rate, 50);
    assert.strictEqual(pred.remaining24h, 50);
    // Uses the default crew count when the crew is unknown
    const predUnknown = est.predict({
      remaining: 100,
      level: 0.4,
      crewCount: null,
    });
    assert.strictEqual(predUnknown.rate, 75);
  });

  test("floors remaining at zero and clamps level", () => {
    const est = makeEstimator({ capacity: 100, minSamples: 0.1 });
    est.processSample({
      remaining: 100,
      level: 0.9,
      crewCount: 2,
      timestamp: T0,
    });
    est.processSample({
      remaining: 20,
      level: 0.2,
      crewCount: 2,
      timestamp: T0 + 24 * HOUR,
    });
    // Learned rate is 80 l/day
    const pred = est.predict({ remaining: 20, level: 0.2, crewCount: 2 });
    assert.strictEqual(pred.rate, 80);
    assert.strictEqual(pred.remaining24h, 0);
    assert.strictEqual(pred.level24h, 0);
    assert.strictEqual(pred.timeToEmptyDays, 0.25);
  });

  test("returns nulls when the tank state cannot be resolved", () => {
    const est = makeEstimator();
    const pred = est.predict({ remaining: null, level: null, crewCount: 2 });
    assert.strictEqual(pred.liters, null);
    assert.strictEqual(pred.remaining24h, null);
    assert.strictEqual(pred.level24h, null);
    assert.strictEqual(pred.timeToEmptyDays, null);
    // Rate still resolves (default fallback) for consumers of the rate alone
    assert.strictEqual(pred.rate, 12);
  });

  test("estimates liters from level when remaining is absent", () => {
    const est = makeEstimator({ capacity: 200, minSamples: 0.1 });
    const pred = est.predict({ remaining: null, level: 0.5, crewCount: 2 });
    assert.strictEqual(pred.liters, 100);
    assert.strictEqual(pred.remaining24h, Math.max(0, 100 - 12));
    assert.strictEqual(pred.level24h, Math.max(0, (100 - 12) / 200));
  });
});

test.describe("TankEstimator persistence", () => {
  test("survives a JSON round-trip", () => {
    const est = makeEstimator({ minSamples: 0.1 });
    est.processSample({
      remaining: 200,
      level: 0.8,
      crewCount: 2,
      timestamp: T0,
    });
    est.processSample({
      remaining: 176,
      level: 0.704,
      crewCount: 2,
      timestamp: T0 + 24 * HOUR,
    });

    const restored = makeEstimator({ minSamples: 0.1 });
    restored.fromJSON(JSON.parse(JSON.stringify(est.toJSON())));

    assert.strictEqual(restored.capacityEstimate, est.capacityEstimate);
    assert.strictEqual(restored.capacitySamples, est.capacitySamples);
    assert.strictEqual(restored.shortRate, est.shortRate);
    assert.deepStrictEqual(restored.anchor, est.anchor);
    assert.strictEqual(restored.learner.getRate(2), est.learner.getRate(2));
  });

  test("fromJSON tolerates junk", () => {
    const est = makeEstimator();
    est.fromJSON(null);
    est.fromJSON("nope");
    est.fromJSON({
      capacityEstimate: -5,
      anchor: { liters: 1 },
      shortRate: "x",
    });
    assert.strictEqual(est.capacityEstimate, null);
    assert.strictEqual(est.anchor, null);
    assert.strictEqual(est.shortRate, null);
  });

  test("skipLearning prevents learning but still computes observed rate", () => {
    const est = makeEstimator({ minSamples: 0.1 });

    est.processSample({
      remaining: 200,
      level: 0.8,
      crewCount: 2,
      timestamp: T0,
    });
    est.processSample({
      remaining: 180,
      level: 0.72,
      crewCount: 2,
      timestamp: T0 + 12 * HOUR,
    });

    // First sample learns normally (learned 40 l/day)
    assert.strictEqual(est.learner.getRate(2), 40);

    // Second sample with skipLearning=true should not learn
    est.processSample({
      remaining: 140,
      level: 0.56,
      crewCount: 2,
      timestamp: T0 + 24 * HOUR,
      skipLearning: true,
    });

    // Rate should still be 40 (unchanged from the first learning)
    assert.strictEqual(est.learner.getRate(2), 40);

    // Now learn normally again with higher consumption to verify learning still works
    est.processSample({
      remaining: 92,
      level: 0.368,
      crewCount: 2,
      timestamp: T0 + 36 * HOUR,
    });

    // New learning (96 l/day over 12h) should have moved the estimate upward
    // from 40 toward 96 with EMA smoothing
    const rate = est.learner.getRate(2);
    assert(rate > 40 && rate < 96, `rate should be between 40 and 96, got ${rate}`);
  });

  test("infers consumption during partial canister refill", () => {
    const est = makeEstimator({ capacity: 120, minSamples: 0.1 });

    // Start with 100L
    est.processSample({
      remaining: 100,
      level: null,
      crewCount: 2,
      timestamp: T0,
    });
    // Next sample shows 107L (+7L delta): consumed 3L, added 10L canister
    const res = est.processSample({
      remaining: 107,
      level: null,
      crewCount: 2,
      timestamp: T0 + 12 * HOUR,
    });

    // Should infer 3L consumption (10L canister - 7L observed increase)
    assert.strictEqual(res.status, "learned");
    assert.strictEqual(res.observedRate, 6); // 3L over 12h = 6 L/day
    assert.ok(res.learned);

    // Rate should incorporate the 6 L/day (which will move toward it with EMA)
    const rate = est.learner.getRate(2);
    assert(rate > 0 && rate < 10, `rate should be ~6, got ${rate}`);
  });

  test("skips learning for large refills that exceed typical canister", () => {
    const est = makeEstimator({ capacity: 200, minSamples: 0.1 });

    est.processSample({
      remaining: 50,
      level: null,
      crewCount: 2,
      timestamp: T0,
    });
    // Large refill (delta = +80L), can't infer consumption
    const res = est.processSample({
      remaining: 130,
      level: null,
      crewCount: 2,
      timestamp: T0 + 12 * HOUR,
    });

    assert.strictEqual(res.status, "refill");
    assert.strictEqual(res.observedRate, null);
    assert.strictEqual(res.learned, false);
  });
});
