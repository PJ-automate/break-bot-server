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

// Metrics for monitoring archive and recovery activity
var _metrics = {
  archiveStartTime: null,
  archiveFinishTime: null,
  deferredSyncs: 0,
  rowRecoveries: 0
};

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

/** Record archive start timestamp. */
function recordArchiveStart() {
  _metrics.archiveStartTime = Date.now();
  _metrics.archiveFinishTime = null;
}

/** Record archive finish and return duration in seconds. */
function recordArchiveFinish() {
  _metrics.archiveFinishTime = Date.now();
  if (_metrics.archiveStartTime) {
    return Math.round((_metrics.archiveFinishTime - _metrics.archiveStartTime) / 1000);
  }
  return 0;
}

/** Increment the deferred sync counter. */
function incrementDeferredSyncs() {
  _metrics.deferredSyncs++;
}

/** Increment the row recovery counter. */
function incrementRowRecoveries() {
  _metrics.rowRecoveries++;
}

/** Get all metrics. */
function getMetrics() {
  return {
    archiveRunning: _archiveRunning,
    archiveDuration: _metrics.archiveStartTime && _metrics.archiveFinishTime
      ? Math.round((_metrics.archiveFinishTime - _metrics.archiveStartTime) / 1000) + 's'
      : (_metrics.archiveStartTime ? 'in progress' : 'not run'),
    deferredSyncs: _metrics.deferredSyncs,
    rowRecoveries: _metrics.rowRecoveries
  };
}

module.exports = {
  setArchiveRunning,
  isArchiveRunning,
  recordArchiveStart,
  recordArchiveFinish,
  incrementDeferredSyncs,
  incrementRowRecoveries,
  getMetrics
};
