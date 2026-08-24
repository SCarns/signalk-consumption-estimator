/**
 * Tank state persistence.
 *
 * Learned state is stored as JSON files in the plugin's data directory,
 * one file per tank.
 *
 * @file store.js
 */

const { readFile, writeFile, mkdir } = require("node:fs/promises");
const { dirname, join } = require("node:path");

/**
 * Sanitizes a tank id for use in a filename.
 *
 * @param {string} tankId
 * @returns {string}
 */
function tankFilename(tankId) {
  const sanitized = String(tankId).replace(/[^a-zA-Z0-9_-]/g, "-");
  return `tank-${sanitized}.json`;
}

/**
 * Loads a tank's persisted state.
 *
 * @param {string} dataDir - Plugin data directory
 * @param {string} tankId - Tank identifier
 * @returns {Promise<object|null>} State object, or null when none exists
 */
async function loadTankState(dataDir, tankId) {
  try {
    const content = await readFile(
      join(dataDir, tankFilename(tankId)),
      "utf-8",
    );
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Saves a tank's state to disk.
 *
 * @param {string} dataDir - Plugin data directory
 * @param {string} tankId - Tank identifier
 * @param {object} state - Serializable state
 * @returns {Promise<void>}
 */
async function saveTankState(dataDir, tankId, state) {
  const path = join(dataDir, tankFilename(tankId));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf-8");
}

module.exports = {
  tankFilename,
  loadTankState,
  saveTankState,
};
