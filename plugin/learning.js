/**
 * Crew-binned EMA learning for tank consumption rates.
 *
 * Consumption (liters/day) is learned separately for each observed crew
 * count, so predictions adapt to how many people are aboard. Each update
 * carries the liters consumed over an interval; the rate is converted to
 * liters/day and folded into the crew bin with an exponential moving
 * average whose effective alpha is weighted by the interval length — a
 * 15-minute tick nudges the estimate gently, a full day moves it by the
 * configured alpha.
 *
 * When the exact crew bin has too few samples, the rate is interpolated
 * between the nearest learned bins (consumption scales roughly with
 * crew), falling back to the single nearest learned bin.
 *
 * @file learning.js
 */

/**
 * Default EMA smoothing factor (per 24 h worth of observations).
 */
const DEFAULT_EMA_ALPHA = 0.05;

/**
 * Default weighted-sample count before a bin counts as "learned".
 * Samples are weighted by interval length (a 24 h interval contributes
 * 1.0, a 15-minute cycle 1/96), so the default of 3 means roughly three
 * days worth of observations for a bin.
 */
const DEFAULT_MIN_SAMPLES = 3;

/**
 * Sanity ceiling for observed consumption rates (liters/day). Anything
 * above this is treated as sensor error and dropped.
 */
const DEFAULT_MAX_RATE = 1000;

/**
 * Intervals shorter than this are dominated by sensor jitter (minimum 5
 * minutes).
 */
const MIN_INTERVAL_HOURS = 5 / 60;

/**
 * Intervals longer than this (server was off, tank unmonitored) are not
 * attributed to current behavior.
 */
const MAX_INTERVAL_HOURS = 24 * 7;

/**
 * Clamps a crew count to a non-negative integer.
 *
 * @param {number} crewCount
 * @returns {number}
 */
function normalizeCrew(crewCount) {
  return Math.max(0, Math.round(crewCount));
}

/**
 * Crew-binned consumption learner.
 */
class ConsumptionLearner {
  /**
   * @param {object} [opts]
   * @param {number} [opts.emaAlpha] - EMA smoothing factor per 24 h
   * @param {number} [opts.minSamples] - Weighted samples before a bin is learned
   * @param {number} [opts.maxRate] - Sanity ceiling in liters/day
   */
  constructor(opts = {}) {
    this.emaAlpha =
      typeof opts.emaAlpha === "number" && opts.emaAlpha > 0
        ? opts.emaAlpha
        : DEFAULT_EMA_ALPHA;
    this.minSamples =
      typeof opts.minSamples === "number" && opts.minSamples > 0
        ? opts.minSamples
        : DEFAULT_MIN_SAMPLES;
    this.maxRate =
      typeof opts.maxRate === "number" && opts.maxRate > 0
        ? opts.maxRate
        : DEFAULT_MAX_RATE;

    /**
     * Crew count → { rate: liters/day, samples: weighted count,
     * lastUpdate: timestamp|null }
     *
     * @type {Map<number, {rate: number, samples: number, lastUpdate: number|null}>}
     */
    this.bins = new Map();
  }

  /**
   * Learns from an observed consumption interval.
   *
   * @param {object} params
   * @param {number|null} params.crewCount - Crew on board (samples with
   *        unknown crew are dropped — they cannot be attributed to a bin)
   * @param {number} params.intervalHours - Length of the observation interval
   * @param {number} params.liters - Liters consumed during the interval
   * @param {number|null} [params.timestamp] - Observation time (epoch ms)
   * @returns {boolean} True if a bin was updated
   */
  update({ crewCount, intervalHours, liters, timestamp = null }) {
    if (
      crewCount == null ||
      !Number.isFinite(crewCount) ||
      liters == null ||
      !Number.isFinite(liters) ||
      liters < 0 ||
      !Number.isFinite(intervalHours) ||
      intervalHours < MIN_INTERVAL_HOURS ||
      intervalHours > MAX_INTERVAL_HOURS
    ) {
      return false;
    }

    const crew = normalizeCrew(crewCount);
    const observed = Math.min(this.maxRate, (liters / intervalHours) * 24);
    const weight = Math.min(1, intervalHours / 24);
    const alphaEff = 1 - (1 - this.emaAlpha) ** weight;

    const bin = this.bins.get(crew);
    if (bin == null) {
      this.bins.set(crew, {
        rate: observed,
        samples: weight,
        lastUpdate: timestamp,
      });
    } else {
      bin.rate = alphaEff * observed + (1 - alphaEff) * bin.rate;
      bin.samples += weight;
      bin.lastUpdate = timestamp;
    }
    return true;
  }

  /**
   * Bins that have enough samples to be considered learned.
   *
   * @returns {Array<{crew: number, rate: number, samples: number}>}
   */
  learnedBins() {
    return Array.from(this.bins.entries())
      .filter(([, bin]) => bin.samples >= this.minSamples)
      .map(([crew, bin]) => ({
        crew,
        rate: bin.rate,
        samples: bin.samples,
      }))
      .sort((a, b) => a.crew - b.crew);
  }

  /**
   * Predicted consumption rate (liters/day) for a crew count.
   *
   * Resolution order: the exact bin once learned, then linear
   * interpolation between the nearest learned bins below and above, then
   * the single nearest learned bin. Null when nothing is learned yet.
   *
   * @param {number|null} crewCount
   * @returns {number|null} Liters/day, or null when no bins are learned
   */
  getRate(crewCount) {
    if (crewCount == null || !Number.isFinite(crewCount)) {
      return null;
    }
    const crew = normalizeCrew(crewCount);

    const exact = this.bins.get(crew);
    if (exact != null && exact.samples >= this.minSamples) {
      return exact.rate;
    }

    const learned = this.learnedBins();
    if (learned.length === 0) {
      return null;
    }

    const below = learned.filter((b) => b.crew < crew).at(-1) ?? null;
    const above = learned.find((b) => b.crew > crew) ?? null;
    if (below != null && above != null) {
      const span = above.crew - below.crew;
      const frac = (crew - below.crew) / span;
      return below.rate + (above.rate - below.rate) * frac;
    }
    return (below ?? above).rate;
  }

  /**
   * Serializes the learner state.
   *
   * @returns {object}
   */
  toJSON() {
    return {
      version: 1,
      emaAlpha: this.emaAlpha,
      minSamples: this.minSamples,
      bins: Object.fromEntries(
        Array.from(this.bins.entries()).map(([crew, bin]) => [
          String(crew),
          {
            rate: bin.rate,
            samples: bin.samples,
            lastUpdate: bin.lastUpdate,
          },
        ]),
      ),
    };
  }

  /**
   * Restores learner state from a serialized object.
   *
   * @param {object} data
   * @returns {ConsumptionLearner}
   */
  static fromJSON(data) {
    const learner = new ConsumptionLearner({
      emaAlpha: data?.emaAlpha,
      minSamples: data?.minSamples,
    });
    if (data?.bins && typeof data.bins === "object") {
      for (const [crew, bin] of Object.entries(data.bins)) {
        const crewNum = Number(crew);
        if (
          !Number.isFinite(crewNum) ||
          bin == null ||
          !Number.isFinite(bin.rate) ||
          !Number.isFinite(bin.samples)
        ) {
          continue;
        }
        learner.bins.set(normalizeCrew(crewNum), {
          rate: bin.rate,
          samples: bin.samples,
          lastUpdate:
            typeof bin.lastUpdate === "number" ? bin.lastUpdate : null,
        });
      }
    }
    return learner;
  }
}

module.exports = {
  ConsumptionLearner,
  DEFAULT_EMA_ALPHA,
  DEFAULT_MIN_SAMPLES,
  DEFAULT_MAX_RATE,
  MIN_INTERVAL_HOURS,
  MAX_INTERVAL_HOURS,
};
