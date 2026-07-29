/**
 * coordinator.js — Shared lock between Archive Worker and Sync Worker.
 *
 * Prevents concurrent Google Sheets modifications by ensuring the Sync Worker
 * does not write to the sheet while the Archive Worker is running.
 *
 * Both workers run on the same Node.js event loop (single-threaded),
 * so a simple boolean is sufficient — no race condition on the flag itself.
 *
 * Usage:
 *   Archive Worker: coordinator.setArchiveRunning(true) → work → coordinator.setArchiveRunning(false)
 *   Sync Worker:    if (coordinator.isArchiveRunning()) { skip; return; }
 */
'use strict';

let _archiveRunning = false;

/**
 * Set whether the archive worker is currently running.
 * Called by the archive worker at the start and end of runArchive().
 */
function setArchiveRunning(value) {
  _archiveRunning = value;
}

/**
 * Check whether the archive worker is currently running.
 * Called by the sync worker before performing Google Sheets writes.
 */
function isArchiveRunning() {
  return _archiveRunning;
}

module.exports = {
  setArchiveRunning,
  isArchiveRunning
};
