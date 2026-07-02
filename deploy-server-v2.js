/**
 * server.js — Break Bot Server (standalone)
 * Handles Telegram webhook for CSBreakMonitoring_bot + dashboard API.
 * Runs independently from project3-qc-point on its own port.
 */
'use strict';

const express = require('express');
const CONFIG = require('./config');
const { handleBreakUpdate, getDashboardData } = require('./break-bot');
const buffer = require('./break-buffer');
const { initBreakAuth } = require('./google');

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
      `https://api.telegram.org/bot${CONFIG.breakBotToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}`
    );
    res.json(result.data);
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
  const authOk = await initBreakAuth();
  if (!authOk) {
    console.error('[BreakBot] Google Auth failed. Check service account path.');
    process.exit(1);
  }

  // Process any pending buffer entries from previous runs (crashes/restarts)
  buffer.processBuffer().catch(function(e) {
    console.error('[Buffer] Startup process error:', e.message);
  });

  app.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`[BreakBot] Server running on http://${CONFIG.host}:${CONFIG.port}`);
    console.log(`[BreakBot] Webhook: /webhook-break`);
    console.log(`[BreakBot] Dashboard: /api/breaks/dashboard`);
  });
}

start().catch(err => {
  console.error('[BreakBot] Fatal startup error:', err);
  process.exit(1);
});
