/**
 * Per-tank consumption estimator.
 *
 * Watches a tank's `remaining` (liters, primary) and `currentLevel`
 * (ratio) paths, infers tank capacity from level/remaining pairs, detects
 * refills, and feeds observed consumption intervals into a crew-binned
 * learner. Produces the 24-hour prediction used for the Signal K deltas.
 *
 * A short-term EMA of the observed rate (fast alpha) is kept alongside
 * the learned long-term rate so consumers can compare "what is happening
 * now" against "what is expected" (anomaly notification).
 *
 * @file tank.js
 */

const { ConsumptionLearner } = require("./learning.js");

/**
 * Level range within which remaining/level pairs are used for capacity
 * inference. At the extremes the sensor resolution and geometry make the
 * ratio unreliable.
 */
const CAPACITY_LEVEL_MIN = 0.05;
const CAPACITY_LEVEL_MAX = 0.98;

/** EMA smoothing for capacity inference. */
const CAPACITY_ALPHA = 0.1;

/** A rise larger than both of these is treated as a refill. */
const REFILL_MIN_LITERS = 1;
const REFILL_CAPACITY_FRACTION = 0.05;

/** Consumption below this over an interval reads as zero (sensor noise). */
const NOISE_LITERS = 0.05;

/** Fast EMA for the short-term observed rate. */
const DEFAULT_SHORT_ALPHA = 0.3;

/**
 * Intervals outside this range are not learned (see learning.js for the
 * rationale; mirrored here for sample gating).
 */
const MIN_INTERVAL_HOURS = 5 / 60;
const MAX_INTERVAL_HOURS = 24 * 7;

/**
 * Clamps a value to [0, 1].
 *
 * @param {number} value
 * @returns {number}
 */
function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

/**
 * Tank consumption estimator with crew-binned learning.
 */
class TankEstimator {
  /**
   * @param {object} opts
   * @param {string} opts.id - Tank identifier (persistence filename)
   * @param {string} opts.name - Human-readable tank name
   * @param {string} opts.levelPath - Signal K level path (ratio)
   * @param {string} opts.remainingPath - Signal K remaining path (liters)
   * @param {string} opts.predictionBase - Base path for prediction deltas
   * @param {number|null} [opts.capacity] - Configured capacity override (liters)
   * @param {number} [opts.defaultPerCrewLitersPerDay] - Fallback rate per crew member
   * @param {number} [opts.defaultCrewCount] - Crew count used when unknown
   * @param {number} [opts.emaAlpha] - Learner EMA alpha
   * @param {number} [opts.minSamples] - Learner minimum weighted samples
   * @param {number} [opts.shortAlpha] - Short-term rate EMA alpha
   */
  constructor(opts) {
    this.id = opts.id;
    this.name = opts.name;
    this.levelPath = opts.levelPath;
    this.remainingPath = opts.remainingPath;
    this.predictionBase = opts.predictionBase;
    this.configuredCapacity =
      typeof opts.capacity === "number" &&
      Number.isFinite(opts.capacity) &&
      opts.capacity > 0
        ? opts.capacity
        : null;
    this.defaultPerCrew =
      typeof opts.defaultPerCrewLitersPerDay === "number" &&
      opts.defaultPerCrewLitersPerDay >= 0
        ? opts.defaultPerCrewLitersPerDay
        : 6;
    this.defaultCrewCount =
      typeof opts.defaultCrewCount === "number" && opts.defaultCrewCount >= 0
        ? Math.round(opts.defaultCrewCount)
        : 2;
    this.shortAlpha =
      typeof opts.shortAlpha === "number" && opts.shortAlpha > 0
        ? opts.shortAlpha
        : DEFAULT_SHORT_ALPHA;

    /** @type {ConsumptionLearner} */
    this.learner = new ConsumptionLearner({
      emaAlpha: opts.emaAlpha,
      minSamples: opts.minSamples,
    });

    /** @type {number|null} */
    this.capacityEstimate = null;
    /** @type {number} */
    this.capacitySamples = 0;

    /**
     * Last processed sample anchor.
     *
     * @type {{liters: number, time: number, source: "remaining"|"level"}|null}
     */
    this.anchor = null;

    /**
     * Most recently seen remaining (liters) and level (ratio), remembered
     * across cycles so capacity can be inferred even when the two arrive in
     * separate deltas from different senders.
     *
     * @type {{remaining: number|null, level: number|null, time: number}}
     */
    this.lastSeen = { remaining: null, level: null, time: 0 };

    /** @type {number|null} */
    this.shortRate = null;
  }

  /**
   * Capacity in liters: configured override wins, else the inferred estimate.
   *
   * @returns {number|null}
   */
  get capacity() {
    return this.configuredCapacity ?? this.capacityEstimate;
  }

  /**
   * Processes a tank sample: infers capacity, detects refills, and learns
   * the consumption over the interval since the previous sample.
   *
   * @param {object} sample
   * @param {number|null} sample.remaining - Remaining liters (primary source)
   * @param {number|null} sample.level - Current level (ratio 0-1)
   * @param {number|null} sample.crewCount - Crew on board at sample time
   * @param {number} sample.timestamp - Sample time (epoch ms)
   * @returns {{status: "learned"|"refill"|"skipped"|"insufficient",
   *            observedRate: number|null, learned: boolean}}
   */
  processSample({ remaining, level, crewCount, timestamp }) {
    if (Number.isFinite(timestamp)) {
      if (remaining != null && Number.isFinite(remaining)) {
        this.lastSeen.remaining = remaining;
        this.lastSeen.time = timestamp;
      }
      if (level != null && Number.isFinite(level)) {
        this.lastSeen.level = level;
        this.lastSeen.time = timestamp;
      }
    }

    // Capacity inference from any known remaining/level pair, even if
    // they arrived in separate deltas (different senders). Uses the
    // freshest value of each seen so far.
    // Capacity inference from any known remaining/level pair, even if
    // they arrived in separate deltas (different senders). Uses the
    // freshest value of each seen so far. The estimate is tracked even
    // when a capacity is configured, so it survives a later config change.
    {
      const r =
        remaining != null && Number.isFinite(remaining)
          ? remaining
          : this.lastSeen.remaining;
      const l =
        level != null && Number.isFinite(level) ? level : this.lastSeen.level;
      if (
        r != null &&
        l != null &&
        l >= CAPACITY_LEVEL_MIN &&
        l <= CAPACITY_LEVEL_MAX &&
        l > 0
      ) {
        const observedCap = r / l;
        if (Number.isFinite(observedCap) && observedCap > 0) {
          this.capacityEstimate =
            this.capacityEstimate == null
              ? observedCap
              : CAPACITY_ALPHA * observedCap +
                (1 - CAPACITY_ALPHA) * this.capacityEstimate;
          this.capacitySamples += 1;
        }
      }
    }

    const cap = this.capacity;

    let liters = null;
    /** @type {"remaining"|"level"|null} */
    let source = null;
    if (remaining != null && Number.isFinite(remaining)) {
      liters = remaining;
      source = "remaining";
    } else if (
      level != null &&
      Number.isFinite(level) &&
      cap != null &&
      cap > 0
    ) {
      liters = level * cap;
      source = "level";
    }

    if (liters == null || source == null || !Number.isFinite(timestamp)) {
      return { status: "insufficient", observedRate: null, learned: false };
    }

    const anchor = this.anchor;
    this.anchor = { liters, time: timestamp, source };

    if (anchor == null || anchor.source !== source) {
      return { status: "skipped", observedRate: null, learned: false };
    }

    const intervalHours = (timestamp - anchor.time) / 3600000;
    if (
      !Number.isFinite(intervalHours) ||
      intervalHours < MIN_INTERVAL_HOURS ||
      intervalHours > MAX_INTERVAL_HOURS
    ) {
      return { status: "skipped", observedRate: null, learned: false };
    }

    const delta = liters - anchor.liters;
    const refillThreshold = Math.max(
      REFILL_MIN_LITERS,
      cap != null ? REFILL_CAPACITY_FRACTION * cap : 0,
    );
    if (delta > refillThreshold) {
      // Tank was filled — the interval says nothing about consumption
      return { status: "refill", observedRate: null, learned: false };
    }

    const consumed = Math.max(0, -delta);
    const observedRate =
      consumed < NOISE_LITERS ? 0 : (consumed / intervalHours) * 24;

    const learned = this.learner.update({
      crewCount,
      intervalHours,
      liters: consumed,
      timestamp,
    });

    this.shortRate =
      this.shortRate == null
        ? observedRate
        : this.shortAlpha * observedRate +
          (1 - this.shortAlpha) * this.shortRate;

    return { status: "learned", observedRate, learned };
  }

  /**
   * Predicts tank state 24 hours from now.
   *
   * @param {object} sample
   * @param {number|null} sample.remaining - Current remaining liters
   * @param {number|null} sample.level - Current level (ratio 0-1)
   * @param {number|null} sample.crewCount - Current crew count
   * @returns {{rate: number, rateSource: "learned"|"default",
   *            liters: number|null, capacity: number|null,
   *            remaining24h: number|null, level24h: number|null,
   *            timeToEmptyDays: number|null}}
   */
  predict({ remaining, level, crewCount }) {
    const cap = this.capacity;

    let liters = null;
    if (remaining != null && Number.isFinite(remaining)) {
      liters = remaining;
    } else if (
      level != null &&
      Number.isFinite(level) &&
      cap != null &&
      cap > 0
    ) {
      liters = level * cap;
    }

    let rate = this.learner.getRate(crewCount);
    let rateSource = "learned";
    if (rate == null) {
      const crew = crewCount ?? this.defaultCrewCount;
      rate = this.defaultPerCrew * (Number.isFinite(crew) ? crew : 0);
      rateSource = "default";
    }

    const remaining24h = liters == null ? null : Math.max(0, liters - rate);
    const level24h =
      liters != null && cap != null && cap > 0
        ? clamp01((liters - rate) / cap)
        : null;
    const timeToEmptyDays = liters != null && rate > 0 ? liters / rate : null;

    return {
      rate,
      rateSource,
      liters,
      capacity: cap,
      remaining24h,
      level24h,
      timeToEmptyDays,
    };
  }

  /**
   * Learned (long-term) rate for a crew count, without the default
   * fallback — used by the anomaly check so it never compares against a
   * default guess.
   *
   * @param {number|null} crewCount
   * @returns {number|null}
   */
  learnedRate(crewCount) {
    return this.learner.getRate(crewCount);
  }

  /**
   * Serializes the estimator state for persistence.
   *
   * @returns {object}
   */
  toJSON() {
    return {
      version: 1,
      id: this.id,
      capacityEstimate: this.capacityEstimate,
      capacitySamples: this.capacitySamples,
      lastSeen: this.lastSeen,
      anchor: this.anchor,
      shortRate: this.shortRate,
      learner: this.learner.toJSON(),
    };
  }

  /**
   * Restores estimator state from a serialized object.
   *
   * @param {object} data
   * @returns {void}
   */
  fromJSON(data) {
    if (data == null || typeof data !== "object") {
      return;
    }
    if (
      typeof data.capacityEstimate === "number" &&
      Number.isFinite(data.capacityEstimate) &&
      data.capacityEstimate > 0
    ) {
      this.capacityEstimate = data.capacityEstimate;
    }
    if (
      typeof data.capacitySamples === "number" &&
      Number.isFinite(data.capacitySamples)
    ) {
      this.capacitySamples = data.capacitySamples;
    }
    if (
      data.anchor != null &&
      typeof data.anchor === "object" &&
      Number.isFinite(data.anchor.liters) &&
      Number.isFinite(data.anchor.time) &&
      (data.anchor.source === "remaining" || data.anchor.source === "level")
    ) {
      this.anchor = {
        liters: data.anchor.liters,
        time: data.anchor.time,
        source: data.anchor.source,
      };
    }
    if (typeof data.shortRate === "number" && Number.isFinite(data.shortRate)) {
      this.shortRate = data.shortRate;
    }
    if (data.lastSeen != null && typeof data.lastSeen === "object") {
      const ls = data.lastSeen;
      if (ls.remaining == null || Number.isFinite(ls.remaining)) {
        this.lastSeen.remaining = ls.remaining == null ? null : ls.remaining;
      }
      if (ls.level == null || Number.isFinite(ls.level)) {
        this.lastSeen.level = ls.level == null ? null : ls.level;
      }
      if (Number.isFinite(ls.time)) {
        this.lastSeen.time = ls.time;
      }
    }
    if (data.learner != null && typeof data.learner === "object") {
      this.learner = ConsumptionLearner.fromJSON(data.learner);
    }
  }
}

module.exports = {
  TankEstimator,
  DEFAULT_SHORT_ALPHA,
  NOISE_LITERS,
  REFILL_MIN_LITERS,
  REFILL_CAPACITY_FRACTION,
  MIN_INTERVAL_HOURS,
  MAX_INTERVAL_HOURS,
};
