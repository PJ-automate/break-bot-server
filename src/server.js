/**
 * server.js — Break Bot Server (standalone)
 * Handles Telegram webhook for CSBreakMonitoring_bot + dashboard API.
 * Runs independently from project3-qc-point on its own port.
 */
'use strict';

const express = require('express');
const CONFIG = require('./config');
const { handleBreakUpdate, getDashboardData } = require('./break-bot');
const db = require('./break-db');
const syncWorker = require('./sync-worker');
const archiveWorker = require('./archive-worker');
const { initBreakAuth, readRange } = require('./google');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ============================================================
//  BREAK BOT WEBHOOK — receives Telegram updates
// ============================================================
app.post('/webhook-break', async (req, res) => {
  res.send('OK');
  try {
    await handleBreakUpdate(req.body);
  } catch (err) {
    console.error('[BreakBot] Webhook error:', err.message);
  }
});

// ============================================================
//  DASHBOARD DATA API — for Tab5
// ============================================================
var dashboardCache = { data: null, ts: 0 };
var DASHBOARD_CACHE_TTL = 15000;

app.get('/api/breaks/dashboard', async (req, res) => {
  try {
    if (dashboardCache.data && Date.now() - dashboardCache.ts < DASHBOARD_CACHE_TTL) {
      return res.json(dashboardCache.data);
    }
    const data = await getDashboardData();
    if (data && data.onBreak) {
      dashboardCache = { data, ts: Date.now() };
    }
    res.json(data);
  } catch (err) {
    console.error('[BreakBot] Dashboard error:', err.message);
    res.json({ onBreak: [], dailySummary: [], breakHistory: [], violations: [] });
  }
});

app.get('/api/break-tracker', async (req, res) => {
  try {
    if (dashboardCache.data && Date.now() - dashboardCache.ts < DASHBOARD_CACHE_TTL) {
      return res.json({ ok: true, data: dashboardCache.data });
    }
    const data = await getDashboardData();
    if (data && data.onBreak) {
      dashboardCache = { data, ts: Date.now() };
    }
    res.json({ ok: true, data });
  } catch (err) {
    console.error('[BreakBot] Tracker error:', err.message);
    res.json({ ok: false, data: { onBreak: [], dailySummary: [], breakHistory: [], violations: [] } });
  }
});

// ============================================================
//  SET WEBHOOK
// ============================================================
app.get('/set-break-webhook', async (req, res) => {
  try {
    const webhookUrl = req.query.url;
    if (!webhookUrl) return res.status(400).send('Missing ?url=');
    const axios = require('axios');
    const result = await axios.get(
      'https://api.telegram.org/bot' + CONFIG.breakBotToken + '/setWebhook?url=' + encodeURIComponent(webhookUrl)
    );
    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  FORCE FORMAT RE-APPLY
// ============================================================
app.get('/force-format', async (req, res) => {
  try {
    const { formatBreakSheets } = require('./google');
    await formatBreakSheets(require('./config').breakSheetId);
    res.json({ status: 'ok', message: 'Formatting re-applied' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    timezone: CONFIG.timezone
  });
});

// ============================================================
//  STARTUP
// ============================================================
async function start() {
  // Initialize SQLite database
  db.initDB();

  // Import existing data from Google Sheet (one-time migration)
  try {
    await initBreakAuth();
    console.log('[Startup] Importing break records from Google Sheet...');
    const data = await readRange(CONFIG.breakSheetId, 'CS BREAK!A:O');
    if (data && data.length > 1) {
      var imported = db.importFromSheetData(data);
      console.log('[Startup] Imported ' + imported + ' break records from Google Sheet');
    }
  } catch (err) {
    console.error('[Startup] Sheet import error (non-fatal):', err.message);
    console.log('[Startup] Continuing with empty database - data will sync as users interact');
  }

  // Start background sync worker (every 5 seconds)
  syncWorker.startSyncWorker(5000);

  // Start archive worker (checks every 15 minutes for midnight crossover)
  archiveWorker.startArchiveWorker(900000);

  app.listen(CONFIG.port, CONFIG.host, () => {
    console.log('[BreakBot] Server running on http://' + CONFIG.host + ':' + CONFIG.port);
    console.log('[BreakBot] Webhook: /webhook-break');
    console.log('[BreakBot] Dashboard: /api/breaks/dashboard');
    console.log('[BreakBot] Archive: auto-archive will run at midnight PH time');
  });
}

start().catch(err => {
  console.error('[BreakBot] Fatal startup error:', err);
  process.exit(1);
});

// ============================================================
//  BREAK HISTORY API — for Tab5 date range filter
// ============================================================
app.get('/api/breaks/history', async (req, res) => {
  try {
    var dateStr = req.query.date || req.query.from;
    if (!dateStr) return res.json({ error: 'Missing ?date=YYYY-MM-DD' });
    var data = await require('./break-bot').getDashboardDataForDate(dateStr);
    res.json({ ok: true, data: data });
  } catch (err) {
    console.error('[BreakBot] History error:', err.message);
    res.json({ ok: false, error: err.message });
  }
});