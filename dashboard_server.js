/**
 * dashboard_server.js ??? Project2 CS System Dashboard Server
 *
 * Standalone Express web server that polls LiveChat API every 30s
 * and serves a real-time agent activity dashboard with 6 tabs:
 *   1. Live Agent Activity
 *   2. Agent Chatflow
 *   3. Daily Chat Trends
 *   4. QC Report
 *   5. CS Break Tracker
 *   6. Lark Attendance
 *
 * Each tab is a separate HTML file in src/tabs/ for independent editing.
 *
 * Usage:
 *   node src/dashboard_server.js
 *   npm run dashboard
 *
 * June 20-21, 2026
 */
'use strict';

// ============================================================
// IMPORTS
// ============================================================
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const CONFIG = require('../config/config');
const fetchAgentStatuses = require('./tab1-live-activity/monitor_agent_activity').fetchAgentStatuses;
var loadGroups = require('./shared/read_groups').loadGroups;
const DashboardData = require('./shared/dashboard_data');
const larkAttendance = require('./tab6-lark-attendance/lark_attendance');
const shiftChangeSync = require('./tab6-lark-attendance/shift_change_sync');
const LARK_EMAIL_MAP_SCRIPT = path.join(__dirname, '..', 'scripts', 'lark_email_map.py');
var larkRealtimeCache = {};
var larkCacheLastRefresh = 0;
var larkAllowedNames = []; // Staff names from CS attendance groups only
var larkJoinDates = {}; // staff_name -> join_time unix timestamp
var larkEmailMap = {}; // cached email map for historical date queries

// ============================================================
// CONFIGURATION
// ============================================================
const PORT = CONFIG.dashboard.port || 8080;
const POLL_INTERVAL_MS = 5000; // 5-second cycle for all-offline detection
var API_TOKEN = CONFIG.livechat.token || '';

// Try loading a persisted token from data/.livechat_token (fresher than config default)
var tokenFile = path.join(CONFIG.dashboard.dataDir, '.livechat_token');
try {
  if (fs.existsSync(tokenFile)) {
    var persistedToken = fs.readFileSync(tokenFile, 'utf8').trim();
    if (persistedToken && persistedToken.length > 10) {
      API_TOKEN = persistedToken;
      console.log('[DASHBOARD] Using persisted token from ' + tokenFile + ' (' + persistedToken.length + ' chars)');
    }
  }
} catch (err) {
  console.warn('[DASHBOARD] Could not read persisted token:', err.message);
}

if (!API_TOKEN) {
  API_TOKEN = 'us-south1:vWhwD2616DZ1-d8chNNgm4Wr-eI';
}

// Background scraper cache for agent chat loads (from old dashboard)
var cachedChatLoads = { agentLoads: {}, timestamp: 0, lastError: null };
var ALERTED_AGENTS = {}; // state-based: { agentName: true } — notified once until agent drops below 12
var sseClients = [];   // active SSE connections for broadcasting
// Standard image for Telegram alerts
var STANDARD_IMAGE = path.join(__dirname, '..', 'data', 'Standard Image for project2.png');

// ============================================================
// LOAD HTML DASHBOARD FROM FILE
// ============================================================
var DASHBOARD_HTML = '';
var htmlPath = path.join(__dirname, 'dashboard.html');
try {
  DASHBOARD_HTML = fs.readFileSync(htmlPath, 'utf8');
  console.log('[DASHBOARD] Loaded dashboard HTML (' + DASHBOARD_HTML.length + ' bytes)');
} catch (err) {
  console.error('[DASHBOARD] Failed to load dashboard.html:', err.message);
  DASHBOARD_HTML = '<html><body><h1>Dashboard HTML not found</h1></body></html>';
}

// ============================================================
// INIT
// ============================================================

// Load groups
try {
  loadGroups(CONFIG.paths.groupsFile);
  console.log('[DASHBOARD] Groups loaded: ' + CONFIG.paths.groupsFile);
} catch (err) {
  console.error('[DASHBOARD] Failed to load groups:', err.message);
    process.exit(1);
}

// Set up data directory and load persisted data
DashboardData.setDataDir(CONFIG.dashboard.dataDir);
DashboardData.loadPersistedData();

// Create Express app
const app = express();
app.use(cors());

// Serve tab files — each tab in its own folder for isolated updates
app.use('/tabs', function(req, res, next) {
  var seg = req.path.split('/').filter(Boolean); // ["tab1-live-activity", "index.html"]
  if (seg.length < 1) return next();
  var tabMap = {
    'tab1-live-activity': 'tab1-live-activity',
    'tab2-chatflow': 'tab2-chatflow',
    'tab3-daily-chat-trends': 'tab3-daily-chat-trends',
    'tab4-qc-report': 'tab4-qc-report',
    'tab5-cs-break-tracker': 'tab5-cs-break-tracker',
    'tab6-lark-attendance': 'tab6-lark-attendance',
  };
  var folder = tabMap[seg[0]];
  if (!folder) return next();
  var filePath = path.join(__dirname, folder, seg.slice(1).join('/'));
  if (fs.existsSync(filePath)) return res.sendFile(filePath);
  next();
});

// POST /api/update-token ??? Receive a fresh API token from local machine
app.post('/api/update-token', function(req, res) {
  var body = '';
  req.on('data', function(c) { body += c; });
  req.on('end', function() {
    try {
      var data = JSON.parse(body);
      if (data.token && data.token.length > 10) {
        API_TOKEN = data.token;
        // Also persist to file
        try {
          var tokenDir = CONFIG.dashboard.dataDir;
          if (!fs.existsSync(tokenDir)) fs.mkdirSync(tokenDir, { recursive: true });
          fs.writeFileSync(path.join(tokenDir, '.livechat_token'), data.token, 'utf8');
        } catch(e) {}
        console.log('[DASHBOARD] Token updated via POST (' + data.token.substring(0, 20) + '...)');
        res.json({ status: 'ok', updated: true });
      } else {
        res.status(400).json({ status: 'error', message: 'Invalid token' });
      }
    } catch(e) {
      res.status(400).json({ status: 'error', message: e.message });
    }
  });
});

// VPS proxy fallback ??? fetch from VPS when local data is incomplete
var VPS_BASE = 'http://164.132.45.47:8080';
function proxyFromVPS(path, res) {
  var httpMod = require('http');
  var opts = { hostname: '164.132.45.47', port: 8080, path: path, method: 'GET', timeout: 5000 };
  var pref = httpMod.request(opts, function(pr) {
    var d = ''; pr.on('data', function(c) { d += c; }); pr.on('end', function() { res.json(JSON.parse(d)); });
  });
  pref.on('error', function() { res.json({ error: 'No data' }); });
  pref.end();
}

// Periodic save every 5 minutes
setInterval(function() {
  DashboardData.savePersistedData();
}, 300000);

// ============================================================
// API ROUTES ??? Existing (used by Tab 1)
// ============================================================

// GET /api/status ??? Current agent status by group
app.get('/api/status', function(req, res) {
  try {
    var data = DashboardData.getStatusData();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/history ??? Timeline data for chart (last hour)
app.get('/api/history', function(req, res) {
  try {
    var data = DashboardData.getHistoryData();
    // FIXED: was data.snapshots (doesn't exist, causing infinite proxy loop)
    if (data && data.timestamps && data.timestamps.length > 0) {
      res.json(data);
    } else {
      // No data yet — return empty instead of self-proxying (was infinite loop)
      res.json({ timestamps: [], snapshots: [] });
    }
  } catch (err) {
    res.json({ timestamps: [], snapshots: [], error: err.message });
  }
});

// GET /api/alerts ??? Alert and recovery history
app.get('/api/alerts', function(req, res) {
  try {
    var data = DashboardData.getAlerts();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/shift-stats ??? Current shift performance stats
app.get('/api/shift-stats', function(req, res) {
  try {
    var data = DashboardData.getShiftStats();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/agent-trends ??? Per-agent availability across recent shifts
app.get('/api/agent-trends', function(req, res) {
  try {
    var data = DashboardData.getAgentTrends();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/downtime ??? Agent offline periods
app.get('/api/downtime', function(req, res) {
  try {
    var data = DashboardData.getDowntime();
    if (data && data.downtime && data.downtime.length > 3) {
      res.json(data);
    } else {
      proxyFromVPS('/api/downtime', res);
    }
  } catch (err) {
    proxyFromVPS('/api/downtime', res);
  }
});

// ============================================================
// API ROUTES ??? Placeholder (future tab integration)
// ============================================================

// GET /api/agent-chatflow ??? Current chat loads per-group + agent status (old dashboard Tab 2)
app.get('/api/agent-chatflow', function(req, res) {
  try {
    var agentChatCounts = cachedChatLoads.agentChatCounts || {};
    var rawAgentCounts = cachedChatLoads.rawAgentCounts || {};
    var groupChatCounts = cachedChatLoads.groupChatCounts || {};
    var platformCounts = cachedChatLoads.platformCounts || {};
    var totalActive = cachedChatLoads.totalActiveChats || 0;
    var rawTotalActive = cachedChatLoads.rawTotalActiveChats || totalActive;
    var engageTotal = cachedChatLoads.engageTotalActiveChats || rawTotalActive;

    // Use scraper data if available (VPS), otherwise show status-only (Render)
    var result = {
      timestamp: Date.now(),
      scrapeTimestamp: cachedChatLoads.timestamp,
      groups: [], totalActiveChats: engageTotal, mappedActiveChats: cachedChatLoads.mappedActiveChats || 0, totalOnline: 0,
      rawTotalActiveChats: rawTotalActive,
      engageTotalActiveChats: engageTotal,
      monitoredActiveChats: totalActive,
      rawAgents: [], platformCounts: [],
    };

    Object.keys(rawAgentCounts).sort(function(a,b) { return rawAgentCounts[b] - rawAgentCounts[a]; }).forEach(function(name) {
      result.rawAgents.push({ name: name, chats: rawAgentCounts[name] });
    });
    Object.keys(platformCounts).sort(function(a,b) { return platformCounts[b] - platformCounts[a]; }).forEach(function(p) {
      result.platformCounts.push({ name: p, chats: platformCounts[p] });
    });

    // Use DashboardData cached status as primary source
    var statusData = DashboardData.getStatusData();
    if (statusData && statusData.groups && statusData.groups.length > 0) {
      statusData.groups.forEach(function(sg) {
        result.groups.push({
          group: sg.group,
          agents: (sg.agents || []).map(function(a) {
            return { name: a.name, status: a.status || 'unknown', chats: agentChatCounts[a.name] || 0, isOnline: a.isOnline || false };
          }),
          activeChats: groupChatCounts[sg.group] || 0
        });
        result.totalOnline += sg.agents.filter(function(a) { return a.isOnline; }).length;
      });
      res.json(result);
    } else {
      // Fallback: try LiveChat API directly for agent statuses
      var https3 = require('https');
      var opts3 = { hostname: 'api.livechatinc.com', path: '/v2/agents', method: 'GET', headers: { 'Authorization': 'Bearer ' + API_TOKEN, 'X-API-Version': '2', 'Accept': 'application/json' } };
      var groupsData = require('./shared/read_groups');
      var allGroups = groupsData.getAllGroups();
      var groupAgentsMap = {};
      allGroups.forEach(function(g) { groupAgentsMap[g] = groupsData.getAgentsForGroup(g) || []; });
      var req3 = https3.request(opts3, function(rp) {
        var d = ''; rp.on('data', function(c) { d += c; }); rp.on('end', function() {
          try {
            var agents = JSON.parse(d);
            if (!Array.isArray(agents)) agents = [];
            var statusMap = {};
            agents.forEach(function(a) { if (a.name) statusMap[a.name] = a.status || 'offline'; });
            allGroups.forEach(function(g) {
              var agentsList = groupAgentsMap[g] || [];
              var gAgents = agentsList.map(function(n) {
                var isOnline = (statusMap[n] === 'accepting chats' || statusMap[n] === 'online');
                if (isOnline) result.totalOnline++;
                return { name: n, status: statusMap[n] || 'unknown', chats: agentChatCounts[n] || 0, isOnline: isOnline };
              });
              result.groups.push({ group: g, agents: gAgents, activeChats: groupChatCounts[g] || 0 });
            });
            res.json(result);
          } catch(e) { res.json(result); }
        });
      });
      req3.on('error', function() { res.json(result); });
      req3.end();
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/chat-trends ??? Daily chat totals per platform (last 7 days)
app.get('/api/chat-trends', function(req, res) {
  try {
    var dataFile = path.join(CONFIG.dashboard.dataDir, 'chat_totals_history.json');
    if (!fs.existsSync(dataFile)) {
      dataFile = path.join(__dirname, 'data_cache', 'chat_totals_history.json');
    }
    if (fs.existsSync(dataFile)) {
      var raw = fs.readFileSync(dataFile, 'utf8');
      var history = JSON.parse(raw);
      var days = (history.days || []).sort(function(a, b) { return a.date > b.date ? 1 : -1; });
      var recent = days.slice(-7);

      // Load platform code mapping
      var mappingFile = path.join(CONFIG.paths.config, 'platforms_mapping.json');
      var codeToGroup = {}; // code -> { group, platform }
      var groupToCodes = {}; // group -> [{ code, platform }]
      if (fs.existsSync(mappingFile)) {
        var mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
        Object.keys(mapping).forEach(function(code) {
          var entry = mapping[code];
          codeToGroup[code] = { group: entry.group, platform: entry.platform };
          if (!groupToCodes[entry.group]) groupToCodes[entry.group] = [];
          groupToCodes[entry.group].push({ code: code, platform: entry.platform });
        });
      }

      var groupsData = require('./shared/read_groups');
      var allGroups = groupsData.getAllGroups().sort();
      var yesterday = recent.length > 0 ? recent[recent.length - 1] : null;
      var dayBefore = recent.length > 1 ? recent[recent.length - 2] : null;
      var result = { days: recent.map(function(d) { return d.date; }), yesterdayDate: yesterday ? yesterday.date : null, totalsByGroup: {} };

      allGroups.forEach(function(gName) {
        // Get platform codes for this group from mapping
        var gPlatforms = groupToCodes[gName] || [];
        var platformData = [];
        var gTotalYesterday = 0, gTotalDayBefore = 0;

        gPlatforms.forEach(function(p) {
          var code = p.code;
          var yCount = yesterday && yesterday.totals && yesterday.totals[code] ? yesterday.totals[code].count : 0;
          var dbCount = dayBefore && dayBefore.totals && dayBefore.totals[code] ? dayBefore.totals[code].count : 0;
          var trend = recent.map(function(d) { return d.totals && d.totals[code] ? d.totals[code].count : 0; });
          gTotalYesterday += yCount;
          gTotalDayBefore += dbCount;
          platformData.push({ code: p.platform, yesterday: yCount, dayBefore: dbCount, trend: trend });
        });

        // Also include platforms from groups.json that aren't in mapping (fallback)
        if (gPlatforms.length === 0) {
          var altPlatforms = groupsData.getPlatformsForGroup(gName) || [];
          altPlatforms.forEach(function(code) {
            var yCount = yesterday && yesterday.totals && yesterday.totals[code] ? yesterday.totals[code].count : 0;
            var dbCount = dayBefore && dayBefore.totals && dayBefore.totals[code] ? dayBefore.totals[code].count : 0;
            var trend = recent.map(function(d) { return d.totals && d.totals[code] ? d.totals[code].count : 0; });
            gTotalYesterday += yCount;
            gTotalDayBefore += dbCount;
            platformData.push({ code: code, yesterday: yCount, dayBefore: dbCount, trend: trend });
          });
        }

        result.totalsByGroup[gName] = { totalYesterday: gTotalYesterday, totalDayBefore: gTotalDayBefore, platforms: platformData };
      });

      // Also include any platforms from data not in any known group (e.g. GRP_ added by scraper)
      var mappedCodes = {};
      Object.keys(groupToCodes).forEach(function(g) {
        groupToCodes[g].forEach(function(p) { mappedCodes[p.code] = true; });
      });
      var otherPlatforms = [];
      var otherYesterday = 0, otherDayBefore = 0;
      if (yesterday && yesterday.totals) {
        Object.keys(yesterday.totals).forEach(function(code) {
          if (!mappedCodes[code]) {
            var yCount = yesterday.totals[code].count || 0;
            var dbCount = dayBefore && dayBefore.totals && dayBefore.totals[code] ? dayBefore.totals[code].count : 0;
            var trend = recent.map(function(d) { return d.totals && d.totals[code] ? d.totals[code].count : 0; });
            otherYesterday += yCount;
            otherDayBefore += dbCount;
            otherPlatforms.push({ code: code, yesterday: yCount, dayBefore: dbCount, trend: trend });
          }
        });
      }
      if (otherPlatforms.length > 0) {
        result.totalsByGroup['Other'] = { totalYesterday: otherYesterday, totalDayBefore: otherDayBefore, platforms: otherPlatforms };
      }

      res.json(result);

      // Auto-backfill: if less than 7 days, trigger background scrape
      var uniqueDates = {};
      (history.days || []).forEach(function(d) { if (d.date) uniqueDates[d.date] = true; });
      if (Object.keys(uniqueDates).length < 7) {
        try {
          var totalsScraper = require('./tab3-daily-chat-trends/chat_totals_scraper');
          totalsScraper.scrapeAll().catch(function() {});
        } catch (e) {}
      }
    } else {
      res.json({ days: [], totalsByGroup: {} });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/daily-report ??? Generate daily chat report (Tab 3)
app.get('/api/daily-report', function(req, res) {
  try {
    var reportGen = require('./tab3-daily-chat-trends/daily_report');
    var report = reportGen.computeDailyReport();
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/daily-report/scrape ??? Scrape yesterday's chat totals (fast) + background tasks
app.post('/api/daily-report/scrape', function(req, res) {
  try {
    // Step 1: Fast API-based chat totals (now with X-Region fix ??? responds in seconds)
    var totalsScraper = require('./tab3-daily-chat-trends/chat_totals_scraper');
    totalsScraper.scrapeAll(API_TOKEN).then(function(totalsResult) {
      if (totalsResult) {
        // Respond to browser immediately ??? don't wait for slow Puppeteer steps
        res.json({ status: 'ok', data: totalsResult });

        // Background: Steps 2 & 3 (fire-and-forget, no await)
        var yesterdayStr = new Date(Date.now() - 86400000).toISOString().split('T')[0];

        // Step 2: Chat Forms (Puppeteer ??? slow, run in background)
        try {
          var cfScraper = require('./tab3-daily-chat-trends/chat_forms_scraper');
          cfScraper.scrapeAllGroupsChatForms(yesterdayStr).catch(function() {});
        } catch (e) {}

        // Step 3: Read actual conversations (API-based ??? X-Region fixed, runs in background)
        try {
          var chatReader = require('./tab3-daily-chat-trends/chat_reader');
          chatReader.readAllPlatformConversations(yesterdayStr, 50, 20).catch(function() {});
        } catch (e) {}
      } else {
        res.json({ status: 'failed', message: 'Could not scrape chat totals. Check logs.' });
      }
    }).catch(function(err) {
      res.json({ status: 'error', message: err.message });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/daily-report/send ??? Generate and send Chat Trend report to Telegram
app.post('/api/daily-report/send', function(req, res) {
  try {
    var reportGen = require('./tab3-daily-chat-trends/daily_report');
    var report = reportGen.computeDailyReport();
    if (report.error) { res.json({ error: report.error }); return; }
    // Run async ??? don't wait
    reportGen.sendDailyChatTrendReport();
    res.json({ status: 'generating', report: report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// QC REPORT ??? Proxy to old QC Dashboard API (Tab 4)
// ============================================================

// Severity mapping matching old QC Dashboard's 19 categories
const QC_SEVERITY_MAP = {
  'delayed response time': { level: 3, label: 'Major', badge: 'badge-major' },
  'inactive in chat': { level: 2, label: 'High', badge: 'badge-high' },
  'inactive in the chat': { level: 2, label: 'High', badge: 'badge-high' },
  'intentional avoidance': { level: 2, label: 'High', badge: 'badge-high' },
  'missed the chat': { level: 2, label: 'High', badge: 'badge-high' },
  'typo error': { level: 5, label: 'Low', badge: 'badge-low' },
  'typo error with a lowercase letter': { level: 5, label: 'Low', badge: 'badge-low' },
  'lowercase letter': { level: 5, label: 'Low', badge: 'badge-low' },
  'repeated message': { level: 4, label: 'Minor', badge: 'badge-minor' },
  'repeated message with identical content': { level: 4, label: 'Minor', badge: 'badge-minor' },
  'short reply': { level: 5, label: 'Low', badge: 'badge-low' },
  'spam message': { level: 5, label: 'Low', badge: 'badge-low' },
  'close without waiting 3 min': { level: 3, label: 'Major', badge: 'badge-major' },
  'closes the chat without waiting 3 minutes': { level: 3, label: 'Major', badge: 'badge-major' },
  'close without anything else': { level: 3, label: 'Major', badge: 'badge-major' },
  'close without thank-you': { level: 3, label: 'Major', badge: 'badge-major' },
  'incorrect information': { level: 2, label: 'High', badge: 'badge-high' },
  'incomplete information': { level: 3, label: 'Major', badge: 'badge-major' },
  'request cancel bad rating': { level: 3, label: 'Major', badge: 'badge-major' },
  'close without solving': { level: 1, label: 'Critical', badge: 'badge-critical' },
  'sent [recipient name]': { level: 1, label: 'Critical', badge: 'badge-critical' },
  'rude response': { level: 1, label: 'Critical', badge: 'badge-critical' },
  'other error': { level: 5, label: 'Low', badge: 'badge-low' },
};

// Extended violation mappings from actual QC data
const QC_EXTRA_MAP = {
  'providing (anything else) message inappropriate time': { level: 3, label: 'Major' },
  'failure to follow standard chat scripts || chat rules': { level: 3, label: 'Major' },
  'failure to follow standard chat scripts': { level: 3, label: 'Major' },
  'providing incorrect information to players': { level: 2, label: 'High' },
  'providing incomplete information to players': { level: 3, label: 'Major' },
  'failed to follow up the player\'s concerns in tg group': { level: 3, label: 'Major' },
  'failure to follow standard chat procedures': { level: 3, label: 'Major' },
  'failure to review and solve the player\'s concerns': { level: 3, label: 'Major' },
  'failur to review and solve the player\'s concerns': { level: 3, label: 'Major' },
  'ignoring to scroll up to see the conversation above in chatbot / livechat': { level: 3, label: 'Major' },
  'late clock-in without valid reason': { level: 3, label: 'Major' },
  'average response time not meet the standardize': { level: 3, label: 'Major' },
  'overbreak 2h (12h shift)': { level: 3, label: 'Major' },
  'exceeded long break 1 hour': { level: 3, label: 'Major' },
  'absence without prior notice': { level: 2, label: 'High' },
  'unprofessional language': { level: 3, label: 'Major' },
  'serious misconduct || policy violation': { level: 1, label: 'Critical' },
  'failure to use player\'s preferred language': { level: 3, label: 'Major' },
  'failure in sharing the live screen without authorize': { level: 3, label: 'Major' },
  'improper chat closure / failure to follow chat closure procedure': { level: 3, label: 'Major' },
  'improper chat closure': { level: 3, label: 'Major' },
  'failure to understand and address the actual concern': { level: 3, label: 'Major' },
  'failure to understand and address actual concern': { level: 3, label: 'Major' },
  'failure to respond in a timely manner': { level: 2, label: 'High' },
  'failure to acknowledge and apologize for the delay': { level: 3, label: 'Major' },
  'providing incorrect guidance || instructions': { level: 2, label: 'High' },
  'failure to provide proper guidance': { level: 3, label: 'Major' },
};

// Parse violation text to extract short violation name only
function parseViolationName(violationText) {
  if (!violationText) return 'Other error';
  // Extract the line after "VIOLATION:"
  var match = violationText.match(/VIOLATION:\s*\n([^\n]+)/i);
  if (match) {
    return match[1].trim();
  }
  // If no "VIOLATION:" prefix, use the first line || full text (truncated)
  var firstLine = violationText.split('\n')[0].trim();
  return firstLine || 'Other error';
}

// Map violation name to severity level
function getViolationSeverity(name) {
  if (!name) return { level: 5, label: 'Low' };
  var key = name.toLowerCase().trim();
  // Remove trailing period
  if (key.endsWith('.')) key = key.slice(0, -1);

  var mapped = QC_SEVERITY_MAP[key];
  if (mapped) return mapped;

  mapped = QC_EXTRA_MAP[key];
  if (mapped) return mapped;

  // Try partial matching for common patterns
  if (key.indexOf('typo') !== -1) return { level: 5, label: 'Low' };
  if (key.indexOf('lowercase') !== -1) return { level: 5, label: 'Low' };
  if (key.indexOf('repeated') !== -1) return { level: 4, label: 'Minor' };
  if (key.indexOf('inactive') !== -1) return { level: 2, label: 'High' };
  if (key.indexOf('incorrect information') !== -1) return { level: 2, label: 'High' };
  if (key.indexOf('incomplete information') !== -1) return { level: 3, label: 'Major' };
  if (key.indexOf('anything else') !== -1 || key.indexOf('anything online') !== -1) return { level: 3, label: 'Major' };
  if (key.indexOf('close without') !== -1) return { level: 3, label: 'Major' };
  if (key.indexOf('missed') !== -1) return { level: 2, label: 'High' };
  if (key.indexOf('avoidance') !== -1) return { level: 2, label: 'High' };
  if (key.indexOf('rude') !== -1) return { level: 1, label: 'Critical' };
  if (key.indexOf('sent [') !== -1) return { level: 1, label: 'Critical' };
  if (key.indexOf('spam') !== -1) return { level: 5, label: 'Low' };
  if (key.indexOf('short reply') !== -1) return { level: 5, label: 'Low' };
  if (key.indexOf('absence') !== -1) return { level: 2, label: 'High' };
  if (key.indexOf('overbreak') !== -1) return { level: 3, label: 'Major' };
  if (key.indexOf('attendance') !== -1 || key.indexOf('clock-in') !== -1 || key.indexOf('late') !== -1) return { level: 3, label: 'Major' };
  if (key.indexOf('response time') !== -1) return { level: 3, label: 'Major' };
  if (key.indexOf('misconduct') !== -1) return { level: 1, label: 'Critical' };

  return { level: 5, label: 'Low' };
}

// Format PH date to "Month DD, YYYY" for QC API sheet name
function formatPHSheetDate(date) {
  var d = date || new Date();
  var str = d.toLocaleString('en-US', { timeZone: 'Asia/Manila', month: 'long', day: 'numeric', year: 'numeric' });
  return str;
}

// QC Dashboard API base URL
var QC_API_BASE = 'https://vps-faf8418b.vps.ovh.net/qc-point/api';

// Fetch QC reports from old dashboard API, supports date range
function fetchQcReports(days, offset) {
  days = days || 1;
  offset = offset || 0;
  return new Promise(function(resolve, reject) {
    var allViolations = [];
    var totalSevCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    var totalAgentsSet = {};
    var dateLabels = [];
    var fetchErrors = [];
    var completed = 0;

    for (var d = 0; d < days; d++) {
      (function(dayOffset) {
        var date = new Date();
        date.setDate(date.getDate() - dayOffset - offset);
        var sheetName = formatPHSheetDate(date);
        dateLabels.push(sheetName);
        var url = QC_API_BASE + '/reports/sheet?name=' + encodeURIComponent(sheetName);

        var https = require('https');
        https.get(url, function(response) {
          var data = '';
          response.on('data', function(chunk) { data += chunk; });
          response.on('end', function() {
            try {
              var parsed = JSON.parse(data);
              var reports = parsed.reports || [];

              reports.forEach(function(r) {
                var vName = parseViolationName(r.violation);
                var sev = getViolationSeverity(vName);

                totalSevCounts[sev.level] = (totalSevCounts[sev.level] || 0) + 1;
                if (r.individual) totalAgentsSet[r.individual] = true;

                allViolations.push({
                  id: r.id,
                  time: r.time || '-',
                  group: r.group || '-',
                  platform: r.channel || 'Livechat',
                  agent: r.individual || '-',
                  violation: vName,
                  severity: sev.level,
                  severityLabel: sev.label,
                  points: parseInt(r.points) || 0,
                  details: r.details || '',
                  qc: r.qc || '',
                  photos: r.photos || [],
                  dateLabel: sheetName,
                });
              });
            } catch (e) {
              fetchErrors.push(sheetName + ': ' + e.message);
            }
            completed++;
            tryDone();
          });
        }).on('error', function(err) {
          fetchErrors.push(sheetName + ': ' + err.message);
          completed++;
          tryDone();
        });
      })(d);
    }

    function tryDone() {
      if (completed < days) return;
      var total = allViolations.length;
      var result = {
        status: fetchErrors.length >= days ? 'error' : 'ok',
        violationsToday: total,
        criticalCount: totalSevCounts[1] || 0,
        highCount: totalSevCounts[2] || 0,
        majorCount: totalSevCounts[3] || 0,
        lowCount: (totalSevCounts[4] || 0) + (totalSevCounts[5] || 0),
        agentsFlagged: Object.keys(totalAgentsSet).length,
        dateRange: dateLabels,
        violations: allViolations,
        lastUpdated: new Date().toISOString(),
      };
      if (fetchErrors.length > 0 && fetchErrors.length < days) {
        result.warning = 'Some dates had errors: ' + fetchErrors.join('; ');
      }
      resolve(result);
    }
  });
}

// GET /api/qc-report ??? QC violation reports from QC Point Dashboard (Tab 4)
// Query params: ?days=N (default 1), ?offset=N (default 0, 1=yesterday)
app.get('/api/qc-report', function(req, res) {
  var days = parseInt(req.query.days) || 1;
  var offset = parseInt(req.query.offset) || 0;
  fetchQcReports(days, offset).then(function(data) {
    res.json(data);
  }).catch(function(err) {
    console.error('[QC-REPORT] Error:', err.message);
    res.json({
      status: 'error',
      message: err.message,
      violationsToday: 0,
      criticalCount: 0,
      highCount: 0,
      majorCount: 0,
      lowCount: 0,
      agentsFlagged: 0,
      violations: [],
      lastUpdated: new Date().toISOString(),
    });
  });
});

// ============================================================
// BREAK TRACKER ??? Google Apps Script proxy (Tab 5)
// Fetches live break data from Project 3's Node.js API (port 3003).
// ============================================================
var BREAK_API_URL = 'http://localhost:3004/api/breaks/dashboard';

var breakTrackerCache = {
  data: null,
  timestamp: 0,
  ttlMs: 30000, // 30-second cache
};

function fetchBreakTrackerData(callback) {
  var url = BREAK_API_URL + '?_=' + Date.now();
  var httpMod = require('http');
  var called = false;

  httpMod.get(url, function(response) {
    var body = '';
    response.on('data', function(chunk) { body += chunk; });
    response.on('end', function() {
      try {
        var parsed = JSON.parse(body);
        // Map Project 3 field names to match what tab5.html expects
        if (called) return; called = true;
        callback(null, {
          onBreak: parsed.onBreak || [],
          dailySummary: parsed.dailySummary || [],
          breakHistory: parsed.breakHistory || [],
          timeAlerts: (parsed.onBreak || []).filter(function(b) {
            return b.startTime && b.startTime !== '';
          }).map(function(b) {
            return { userName: b.userName, type: 'onbreak', message: b.breakType + ' since ' + b.startTime };
          }),
          violationHistory: (parsed.violations || []).map(function(v) {
            return { userName: v.userName, type: v.type, start: v.start, end: v.end, duration: v.duration, remark: v.remark };
          })
        });
      } catch (e) {
        if (called) return; called = true;
        callback(e, null);
      }
    });
  }).on('error', function(err) {
    if (called) return; called = true;
    callback(err, null);
  }).setTimeout(35000, function() {
    this.destroy();
    if (called) return; called = true;
    callback(new Error('Timeout'), null);
  });
}

app.get('/api/break-tracker', function(req, res) {
  var now = Date.now();

  // Return cached data if fresh
  if (breakTrackerCache.data && (now - breakTrackerCache.timestamp) < breakTrackerCache.ttlMs) {
    return res.json(breakTrackerCache.data);
  }

  // Force refresh
  var force = req.query.force === '1';
  if (force) {
    breakTrackerCache.ttlMs = 5000; // Shorten TTL for forced refresh
  }

  fetchBreakTrackerData(function(err, data) {
    if (err) {
      console.log('[BREAK-TRACKER] Fetch error: ' + err.message + ' ??? using ' + (breakTrackerCache.data ? 'stale' : 'empty') + ' data');
      if (breakTrackerCache.data) {
        return res.json(breakTrackerCache.data);
      }
      // Return empty structure
      return res.json({
        ok: true,
        data: {
          onBreak: [],
          dailySummary: [],
          timeAlerts: [],
          breakHistory: [],
          violationHistory: [],
        },
        fromCache: false,
        error: err.message,
        timestamp: new Date().toISOString(),
      });
    }

    breakTrackerCache.data = { ok: true, data: data, fromCache: false, timestamp: new Date().toISOString() };
    breakTrackerCache.timestamp = now;
    if (force) breakTrackerCache.ttlMs = 30000; // Reset TTL

    res.json(breakTrackerCache.data);
  });
});

// ============================================================
// Attendance cache — 60s TTL (avoids ~7s Python calls per switch)
// ============================================================
var attendanceCache = { data: null, timestamp: 0, ttlMs: 60000 };

// GET /api/attendance ??? Lark attendance data (Tab 6)
app.get('/api/attendance', function(req, res) {
  try {
    var now = Date.now();
    // Return cached response if still fresh
    if (attendanceCache.data && (now - attendanceCache.timestamp) < attendanceCache.ttlMs) {
      attendanceCache.data._cached = true;
      return res.json(attendanceCache.data);
    }

    var month = req.query.month || '';
    var GSCRIPT = path.join(__dirname, '..', 'scripts', 'gsheet_reader.py');

    function runPython(action, arg) {
      var cmd = 'python3';
      var args = [GSCRIPT, action];
      if (arg) args.push(arg);
      try {
        var out = execSync(cmd + ' ' + args.map(function(a) { return "'" + a.replace(/'/g, "'\\''") + "'"; }).join(' '), { timeout: 30000 });
        return JSON.parse(out.toString().trim());
      } catch (e) {
        console.error('[ATTENDANCE] Python error (' + action + '):', e.message);
        return null;
      }
    }

    // Get available month tabs
    var tabs = runPython('tabs');

    // Determine current month
    var phNow = new Date().toLocaleString('en-US', {timeZone:'Asia/Manila'});
    var phDate = new Date(phNow);
    var monthShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var monthFull = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    var currentMonthShort = monthShort[phDate.getMonth()] + phDate.getFullYear();
    var currentMonthFull = monthFull[phDate.getMonth()] + phDate.getFullYear();
    var monthTabs = tabs ? tabs.filter(function(t) { return /[A-Z][a-z]+202[0-9]/.test(t); }).sort() : [];

    function resolveMonthTab(requested) {
        if (!requested || !monthTabs) return null;
        var lower = requested.toLowerCase();
        for (var i = 0; i < monthTabs.length; i++) {
            if (monthTabs[i].toLowerCase() === lower) return monthTabs[i];
            if (monthTabs[i].toLowerCase().indexOf(lower) !== -1) return monthTabs[i];
            if (lower.indexOf(monthTabs[i].toLowerCase()) !== -1) return monthTabs[i];
        }
        return null;
    }

    var activeMonth = month || currentMonthShort;
    var resolvedTab = resolveMonthTab(activeMonth);
    if (!resolvedTab) resolvedTab = resolveMonthTab(currentMonthFull);
    if (!resolvedTab && monthTabs && monthTabs.length > 0) resolvedTab = monthTabs[monthTabs.length - 1];
    activeMonth = resolvedTab || activeMonth;

    // Read monthly data, summary, and tag list
    var rawMonthly = runPython('monthly', activeMonth);
    var rawSummary = runPython('summary');
    var rawTagList = runPython('taglist');
    var rawToday = runPython('lark-today');

    // Process monthly sheet data
    var monthly = { dateHeaders: [], staff: [], groups: [] };
    if (rawMonthly && Array.isArray(rawMonthly)) {
      var currentGroup = '';
      rawMonthly.forEach(function(row) {
        if (!row || !row[0]) {
          if (row && row[1]) currentGroup = row[1];
          return;
        }
        var cellA = String(row[0]).trim();
        if (cellA === '日期/花名') {
          monthly.dateHeaders = row.slice(1);
          return;
        }
        if (cellA == '日期/花名' || cellA.startsWith('客服') || cellA.startsWith('原有')) return;
        var daily = {};
        monthly.dateHeaders.forEach(function(h, idx) {
          if (idx < row.length - 1) daily[h] = row[idx + 1] || '';
        });
        monthly.staff.push({ name: cellA, group: currentGroup, daily: daily });
      });
      var gSet = {};
      monthly.staff.forEach(function(s) { if (s.group) gSet[s.group] = true; });
      monthly.groups = Object.keys(gSet).sort();
    }

    // Process summary sheet
    var summaryHeaders = [];
    var summaryRows = [];
    if (rawSummary && Array.isArray(rawSummary)) {
      var curGroup = '';
      rawSummary.forEach(function(row) {
        if (!row || !row[0]) return;
        var a = String(row[0]).trim();
        if (a === 'Employee') {
          summaryHeaders = row.slice(1).map(String);
          return;
        }
        if (a.startsWith('MONTHLY')) return;
        var isSection = /ONSITE|WFH|INDIA|INDONESIA|MYANMAR|PHILIPPINE|LAOS|BANGLADESH|ORIGIN|客服/.test(a);
        if (isSection) {
          curGroup = a;
          summaryRows.push({ type: 'section', name: a });
          return;
        }
        var counts = {};
        summaryHeaders.forEach(function(h, idx) {
          counts[h] = row[idx + 1] ? parseInt(String(row[idx + 1]).trim()) || 0 : 0;
        });
        summaryRows.push({ type: 'staff', name: a, group: curGroup, counts: counts });
      });
    }

    // Compute summary counts from monthly data if summary sheet has zeros
    summaryRows.forEach(function(row) {
      if (row.type === 'staff' && row.counts) {
        var hasData = Object.values(row.counts).some(function(v) { return v > 0; });
        if (!hasData) {
          var staff = monthly.staff.find(function(s) { return s.name === row.name; });
          if (staff) {
            var c = { Present: 0, 'Day Off': 0, 'Shift Change': 0, 'Annual Leave': 0, 'Sick Leave': 0, 'Emergency Leave': 0, 'Unpaid Leave': 0, Late: 0, Absent: 0 };
            Object.values(staff.daily).forEach(function(tag) {
              var t = String(tag || '').trim();
              if (t === '上班') c.Present++;
              else if (t === '休息') c['Day Off']++;
              else if (t === '年假') c['Annual Leave']++;
              else if (t === '生病') c['Sick Leave']++;
              else if (t === '紧急休假') c['Emergency Leave']++;
              else if (t === '无薪假') c['Unpaid Leave']++;
              else if (t === '迟到') { c.Late++; c.Present++; }
              else if (t === '换班') c.Present++;
              else if (t === '旷工') c.Absent++;
              else if (t === '离职' || t === '还没进公司') c.Absent++;
              else if (t === '' || !t) c.Absent++;
              else c.Absent++;
            });
            row.counts = c;
          }
        }
      }
    });

    // Process tag list
    var tagList = {};
    if (rawTagList && Array.isArray(rawTagList)) {
      rawTagList.forEach(function(row) {
        if (row && row[0] && row[0] !== '标记') {
          tagList[row[0]] = { condition: row[1] || '', note: row[2] || '' };
        }
      });
    }

    // Process today's Lark data
    var today = rawToday && rawToday.employees ? rawToday.employees : {};
    var todayDate = rawToday && rawToday.date ? rawToday.date : '';
    // Fallback: compute PH date string if sheet data unavailable
    if (!todayDate) {
      var phD = new Date(new Date().toLocaleString('en-US', {timeZone:'Asia/Manila'}));
      todayDate = phD.toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'});
    }

    var result = {
      status: 'ok',
      todayDate: todayDate,
      currentMonth: currentMonthShort,
      activeMonth: activeMonth,
      monthTabs: monthTabs,
      today: today,
      monthly: monthly,
      monthlySummary: { headers: summaryHeaders, rows: summaryRows },
      tagList: tagList,
      joinDates: larkJoinDates,
      lastUpdated: new Date().toISOString(),
    };

    // Merge Lark realtime data (overrides sheet tags with live clock-in/out)
    var larkKeys = Object.keys(larkRealtimeCache);
    if (larkKeys.length > 0) {
      Object.keys(today).forEach(function(name) {
        var larkEntry = larkRealtimeCache[name];
        if (larkEntry) {
          // Update tag based on Lark check_in_result
          var lcir = (larkEntry.check_in_result || '').trim();
          if (lcir === 'Pending') today[name].tag = '待审批';
          else if (larkEntry.has_check_in) today[name].tag = '上班'; // late status goes to is_late field, not tag
          if (larkEntry.has_check_in) {
            today[name].has_check_in = true;
            today[name].clock_in = larkEntry.clock_in;
            today[name].clock_in_display = new Date(larkEntry.clock_in * 1000).toLocaleTimeString('en-US', {timeZone:'Asia/Manila', hour:'2-digit', minute:'2-digit', hour12:true});
            today[name].shift_start = larkEntry.shift_start;
            today[name].shift_end = larkEntry.shift_end;
            today[name].is_late = larkEntry.is_late;
            today[name].late_minutes = larkEntry.late_minutes;
            today[name].source = 'lark';
            today[name].check_out_result = larkEntry.check_out_result || 'Todo';
            today[name].check_in_result = larkEntry.check_in_result || 'None';
          }
          if (larkEntry.has_check_out) {
            today[name].has_check_out = true;
            today[name].clock_out = larkEntry.clock_out;
            today[name].clock_out_display = new Date(larkEntry.clock_out * 1000).toLocaleTimeString('en-US', {timeZone:'Asia/Manila', hour:'2-digit', minute:'2-digit', hour12:true});
          }
        }
      });
      // Determine shift type and early/no clockout status
      // (runs again after CS group filter fallback below)
    }

    // Filter to only CS group members (线上客服部 + 斯里兰卡客服)
    if (larkAllowedNames.length > 0) {
      // Filter today data
      var filteredToday = {};
      Object.keys(today).forEach(function(name) {
        if (larkAllowedNames.indexOf(name.trim()) !== -1) {
          filteredToday[name] = today[name];
        }
      });
      today = filteredToday;

      // Add ALL CS group members from Lark cache — ensures every staff member
      // appears in the dashboard even before clocking in (e.g. after 12AM new day).
      // Staff without clock-in records will show as "Absent" (旷工) in the frontend.
      larkAllowedNames.forEach(function(name) {
        if (!today[name]) {
          var l = larkRealtimeCache[name];
          if (l) {
            // Derive tag from Lark check_in_result
            var larkTag = '';
            var cir = (l.check_in_result || '').trim();
            if (cir === 'Pending') larkTag = '待审批';
            else if (l.has_check_in) larkTag = '上班'; // late goes to is_late field, not tag
            // else: no check-in → empty tag → frontend shows "旷工"
            today[name] = {
              tag: larkTag,
              group: '',
              has_check_in: l.has_check_in || false,
              clock_in: l.clock_in || 0,
              clock_in_display: l.clock_in ? new Date(l.clock_in * 1000).toLocaleTimeString('en-US', {timeZone:'Asia/Manila', hour:'2-digit', minute:'2-digit', hour12:true}) : '',
              has_check_out: l.has_check_out || false,
              clock_out: l.clock_out || 0,
              clock_out_display: l.clock_out ? new Date(l.clock_out * 1000).toLocaleTimeString('en-US', {timeZone:'Asia/Manila', hour:'2-digit', minute:'2-digit', hour12:true}) : '',
              is_late: l.is_late || false,
              late_minutes: l.late_minutes || 0,
              shift_start: l.shift_start || 0,
              shift_end: l.shift_end || 0,
              shift_type: l.shift_type || 'unknown',
              is_early: l.is_early || false,
              is_no_clockout: l.check_out_result === 'Todo' || l.check_out_result === 'None' || !l.has_check_out,
              check_in_result: l.check_in_result || 'None',
              check_out_result: l.check_out_result || 'Todo',
              source: 'lark'
            };
          } else {
            // Staff not yet in Lark cache — show as absent placeholder
            today[name] = {
              tag: '', group: '',
              has_check_in: false, has_check_out: false,
              is_late: false, late_minutes: 0,
              clock_in: 0, clock_out: 0,
              shift_start: 0, shift_end: 0,
              shift_type: 'unknown',
              is_early: false, is_no_clockout: false,
              check_in_result: 'None', check_out_result: 'None',
              source: 'lark'
            };
          }
        }
      });

      // Determine shift type and early/no clockout status for all staff in today
      Object.keys(today).forEach(function(name) {
        var s = today[name];
        var ss = s.shift_start;
        if (ss && ss > 0) {
          var secsUTC = ss % 86400;
          if (secsUTC >= 10000 && secsUTC <= 22000) s.shift_type = 'day';
          else if (secsUTC >= 50000 || secsUTC <= 3000) s.shift_type = 'night';
          else s.shift_type = 'unknown';
        } else {
          s.shift_type = 'unknown';
        }
        s.is_early = s.check_out_result === 'Early';
        s.is_no_clockout = s.check_out_result === 'Todo' || s.check_out_result === 'None' || !s.has_check_out;
      });

      // Filter monthly staff
      monthly.staff = monthly.staff.filter(function(s) {
        return larkAllowedNames.indexOf(s.name.trim()) !== -1;
      });

      // Recompute groups from filtered staff
      var gSet = {};
      monthly.staff.forEach(function(s) { if (s.group) gSet[s.group] = true; });
      monthly.groups = Object.keys(gSet).sort();

      // Fallback: if monthly staff is empty (no Google Sheets data), use Lark staff list
      if (monthly.staff.length === 0 && larkAllowedNames.length > 0) {
        console.log('[LARK] Monthly staff empty — using Lark CS group list as fallback (' + larkAllowedNames.length + ' staff)');
        larkAllowedNames.forEach(function(name) {
          monthly.staff.push({ name: name, group: '', daily: {} });
        });
        monthly.groups = [''];
      }

      // Filter summary rows (keep section headers, filter staff)
      summaryRows = summaryRows.filter(function(r) {
        if (r.type === 'section') return true;
        return larkAllowedNames.indexOf(r.name.trim()) !== -1;
      });

      // Update result object references since they were set before filtering
      result.today = today;
      result.monthly = monthly;
      result.monthlySummary.rows = summaryRows;
    }
    // Cache fresh response for 60s (avoids slow Python calls on re-switch)
    attendanceCache.data = result;
    attendanceCache.timestamp = Date.now();
    attendanceCache.data._cached = false;
    res.json(result);
  } catch (err) {
    console.error('[ATTENDANCE] Error:', err.message);
    res.json({
      status: 'error',
      message: err.message,
      monthly: { dateHeaders: [], staff: [], groups: [] },
      monthlySummary: { headers: [], rows: [] },
      today: {},
      tagList: {},
      lastUpdated: new Date().toISOString(),
    });
  }
});

// GET /api/attendance-date ? Historical Lark attendance for a past date (YYYYMMDD)
app.get('/api/attendance-date', function(req, res) {
  var dateStr = (req.query.date || '').trim();
  if (!dateStr || !/^\d{8}$/.test(dateStr)) {
    return res.json({ status: 'error', message: 'Invalid date format (use YYYYMMDD)', employees: {} });
  }
  larkAttendance.getCsGroupMembers(larkEmailMap).then(function(csMembers) {
    return larkAttendance.fetchRealtimeData(larkEmailMap, dateStr, csMembers.userIds, csMembers.userIdToName || {}).then(function(larkData) {
      res.json({ status: 'ok', date: dateStr, employees: larkData || {} });
    });
  }).catch(function(err) {
    console.error('[ATTENDANCE-DATE] Error:', err.message);
    res.json({ status: 'error', message: err.message, employees: {} });
  });
});

// GET /api/shift ??? Current shift info (from old dashboard)
app.get('/api/shift', function(req, res) {
  try {
    res.json({ shiftLabel: DashboardData.getCurrentShift().label, timestamp: Date.now() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/shift-changes ??? Cached shift change data from Google Sheet sync
// Optional ?tab=August+Shift to sync a specific month tab
app.get('/api/shift-changes', function(req, res) {
  try {
    var tab = (typeof req.query.tab === "string" ? req.query.tab : "").trim();
    if (tab === "[object Object]") {
      console.log("[SHIFT_SYNC] DEBUG BAD TAB — raw query:", JSON.stringify(req.query), "raw url:", req.originalUrl);
    }
    if (tab) {
      // Fast path: read sheet WITHOUT pushing to Lark (used for month-switching)
      shiftChangeSync.readSheetTab(tab).then(function(data) {
        res.json(data);
      }).catch(function(err) {
        res.json({ error: err.message, staff: [], month: tab });
      });
    } else {
      res.json(shiftChangeSync.getCachedShiftData());
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/shift-changes/tabs ??? List available month tabs from the sheet
app.get('/api/shift-changes/tabs', function(req, res) {
  shiftChangeSync.getTabs().then(function(tabs) {
    res.json({ tabs: tabs });
  }).catch(function(err) {
    res.status(500).json({ error: err.message });
  });
});

// POST /api/shift-changes/sync-now — Force a full re-sync from Google Sheet to Lark
// Resets the snapshot hash so Lark API push runs even if data looks unchanged.
// Call this after editing the Google Sheet to push changes immediately.
app.post('/api/shift-changes/sync-now', function(req, res) {
  try {
    var tab = '';
    if (typeof req.query.tab === 'string') tab = req.query.tab.trim();

    function doSync(t, force) {
      return shiftChangeSync.syncShiftChanges(t, force).then(function(result) {
        if (result && result.status === 'skipped') {
          // Sync was skipped (another sync in progress) — tell frontend to retry
          res.json({ status: 'queued', message: 'Sync queued — another sync in progress. Please wait...', result: result });
        } else {
          res.json({ status: 'ok', message: 'Sync completed' + (tab ? ' for ' + tab : ''), result: result });
        }
      }).catch(function(err) {
        res.status(500).json({ error: err.message });
      });
    }

    // Reset snapshot first so sync detects data as changed
    shiftChangeSync.forceNextSync();

    if (!tab) {
      doSync('', true);
    } else {
      doSync(tab, true);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Broadcast event to all connected SSE clients
function broadcastSSE(eventType, data) {
  var msg = 'event: ' + eventType + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (var i = sseClients.length - 1; i >= 0; i--) {
    try { sseClients[i].write(msg); } catch (e) { sseClients.splice(i, 1); }
  }
}

// ============================================================
// SSE ENDPOINT ??? Server-Sent Events for real-time push
// ============================================================
app.get('/events', function(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  sseClients.push(res);

  // Heartbeat every 15s
  var heartbeat = setInterval(function() {
    try { res.write(': heartbeat\n\n'); } catch (e) {}
  }, 15000);

  // Register callbacks
  var onAlertFn = function(alertData) {
    try { res.write('event: alert\ndata: ' + JSON.stringify(alertData) + '\n\n'); } catch (e) {}
  };
  var onRecoveryFn = function(recoveryData) {
    try { res.write('event: recovery\ndata: ' + JSON.stringify(recoveryData) + '\n\n'); } catch (e) {}
  };
  var onStatusFn = function(statusData) {
    try { res.write('event: status\ndata: ' + JSON.stringify(statusData) + '\n\n'); } catch (e) {}
  };

  DashboardData.onAlert(onAlertFn);
  DashboardData.onRecovery(onRecoveryFn);
  DashboardData.onStatus(onStatusFn);

  req.on('close', function() {
    clearInterval(heartbeat);
    DashboardData.removeAlertListener(onAlertFn);
    DashboardData.removeRecoveryListener(onRecoveryFn);
    DashboardData.removeStatusListener(onStatusFn);
    var idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

// ============================================================
// DASHBOARD HTML
// ============================================================
app.get('/', function(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(DASHBOARD_HTML);
});

// ============================================================
// START
// ============================================================
function startDashboard() {
  var server = app.listen(PORT, '0.0.0.0', function() {
    console.log('==============================================================');
    console.log('  Project2 CS System Dashboard');
    console.log('==============================================================');
    console.log('  Server    : http://0.0.0.0:' + PORT);
    console.log('  Dashboard : http://localhost:' + PORT + '/');
    console.log('  API       : http://localhost:' + PORT + '/api/status');
    console.log('  SSE       : http://localhost:' + PORT + '/events');
    console.log('  Poll      : every ' + (POLL_INTERVAL_MS / 1000) + 's');
    console.log('  Data dir  : ' + CONFIG.dashboard.dataDir);
    console.log('  Tabs      : src/tab{1..6}-*/');
    console.log('==============================================================');

    // Start polling LiveChat API with auto-fallback to scraper
    DashboardData.startPolling(function() {
      return fetchAgentStatuses(API_TOKEN, CONFIG.livechat.email, CONFIG.livechat.password, CONFIG.livechat.organization);
    }, POLL_INTERVAL_MS);

    // ===== Tab 1 — All-Offline Telegram Alerts (via DashboardData callbacks) =====
    try {
      var setupTab1Alerts = require('./tab1-live-activity/scheduler').setupDashboardAlerting;
      setupTab1Alerts(DashboardData);
    } catch (err) {
      console.error('[DASHBOARD] Tab1 alert setup failed:', err.message);
    }

    // ============================================================
    // LARK REALTIME ATTENDANCE CACHE (refreshes every 60s)
    // ============================================================

    function refreshLarkCache() {
      try {
        var emailMapRaw = require('child_process').execSync(
          'python3 "' + LARK_EMAIL_MAP_SCRIPT + '"',
          { timeout: 15000, encoding: 'utf-8' }
        );
        var emailMap = JSON.parse(emailMapRaw.trim());
        larkEmailMap = emailMap; // save for historical date queries
        console.log('[LARK] Refreshing cache with ' + Object.keys(emailMap).length + ' staff emails');

        // Get allowed CS group members first, then fetch realtime data filtered to those groups
        larkAttendance.getCsGroupMembers(emailMap).then(function(csMembers) {
          larkAllowedNames = csMembers.names.map(function(n) { return n.trim(); }) || [];
          // Build join dates map: staff_name -> join_time
          var jd = {};
          Object.keys(csMembers.userIdToJoinDate || {}).forEach(function(uid) {
            var name = csMembers.userIdToName[uid];
            if (name) jd[name.trim()] = csMembers.userIdToJoinDate[uid];
          });
          larkJoinDates = jd;

          // Build name→user_id map for shift change sync (sheet UIDs are not Lark user_ids)
          var n2u = {};
          Object.keys(csMembers.userIdToName || {}).forEach(function(uid) {
            var n = csMembers.userIdToName[uid];
            if (n) n2u[n.trim()] = uid;
          });
          shiftChangeSync.setNameToUserIdMap(n2u);
          console.log('[LARK] Filtering to ' + larkAllowedNames.length + ' CS group members, ' + Object.keys(jd).length + ' join dates');
          return larkAttendance.fetchRealtimeData(emailMap, null, csMembers.userIds, csMembers.userIdToName || {}).then(function(larkData) {
            var keys = Object.keys(larkData);
            console.log('[LARK] Cache refreshed: ' + keys.length + ' CS staff with real-time data');
            if (keys.length > 0) {
              larkRealtimeCache = larkData;
              larkCacheLastRefresh = Date.now();
            }
          });
        }).catch(function(err) {
          console.error('[LARK] Cache refresh error:', err.message);
          // Fallback: fetch without filter if CS group query fails
          larkAttendance.fetchRealtimeData(emailMap).then(function(larkData) {
            var keys = Object.keys(larkData);
            if (keys.length > 0) {
              larkRealtimeCache = larkData;
              larkCacheLastRefresh = Date.now();
            }
          });
        });
      } catch (err) {
        console.error('[LARK] Email map error:', err.message);
      }
    }

    // Initial fetch after 3s delay, then every 60s
    setTimeout(refreshLarkCache, 3000);
    setInterval(refreshLarkCache, 60000);
    console.log('[LARK] Realtime attendance cache initialized (every 60s)');

    // Start persistent scraper for agent chat loads (Tab 2 Chatflow)
    startChatLoadScraper();

    // Init Telegram for 12+ chat alerts
    try {
      var telegram = require('./shared/telegram_sender');
      telegram.initTelegram(CONFIG.telegram.botToken, CONFIG.telegram.chatId);
      console.log('[DASHBOARD] Telegram initialized for chat alerts');
    } catch (err) {
      console.error('[DASHBOARD] Telegram init failed:', err.message);
    }

    // Token auto-refresh every ~5 minutes (Bearers expire)
    async function refreshAPIToken() {
      try {
        var refresher = require('./shared/refresh_token');
        var newToken = await refresher.refreshToken();
        if (newToken) {
          API_TOKEN = newToken;
          console.log('[DASHBOARD] API token refreshed');
          return;
        }
      } catch (err) {
        console.error('[DASHBOARD] Token refresh failed:', err.message);
      }
      // Fallback: check persisted token file in case refresh failed but token was saved
      try {
        var tf = path.join(CONFIG.dashboard.dataDir, '.livechat_token');
        if (fs.existsSync(tf)) {
          var pt = fs.readFileSync(tf, 'utf8').trim();
          if (pt && pt.length > 10 && pt !== API_TOKEN) {
            API_TOKEN = pt;
            console.log('[DASHBOARD] Using persisted token from file (fallback)');
          }
        }
      } catch (e) {}
    }
    // Run refresh on startup and every 15 min
    setTimeout(refreshAPIToken, 60000); // 1 min delay for startup
    setInterval(refreshAPIToken, 300000); // every 5 min (takes ~40s, tokens last 1-2h)

    // ====================================================================
    // DAILY SCHEDULE (PH Time):
    // 12:00 AM ??? Scrape yesterday's chat totals + Chat Forms data
    // 01:00 PM ??? Send Chat Trend report to Telegram
    // ====================================================================
    var lastScrapeDate = '';
    var lastReportDate = '';
    async function checkDailySchedule() {
      var phNow = new Date().toLocaleString('en-US', {timeZone:'Asia/Manila', hour12:false});
      var phHour = parseInt(phNow.split(',')[1].trim().split(':')[0], 10);
      var phMinute = parseInt(phNow.split(',')[1].trim().split(':')[1], 10);
      var phDay = new Date().toLocaleString('en-US', {timeZone:'Asia/Manila', day:'2-digit'});

      // SCHEDULE 1: 12:05 AM PH — Scrape data (runs only once per day)
      if (((phHour === 0 && phMinute >= 5) || phHour === 1) && lastScrapeDate !== phDay) {
        lastScrapeDate = phDay;
        console.log('[DASHBOARD] ??? 12AM ??? Running daily data scrape (totals + Chat Forms)...');
        try {
          var reportGen = require('./tab3-daily-chat-trends/daily_report');
          await reportGen.scrapeAllData(null, API_TOKEN);
          console.log('[DASHBOARD] ??? Daily data scrape complete');
        } catch (err) {
          console.error('[DASHBOARD] Daily scrape failed:', err.message);
        }
      }

      // SCHEDULE 2: 01:00 PM ??? Send Chat Trend report
      if (phHour === 13 && lastReportDate !== phDay) {
        lastReportDate = phDay;
        console.log('[DASHBOARD] ??? 1PM ??? Sending Chat Trend report...');
        try {
          var reportGen2 = require('./tab3-daily-chat-trends/daily_report');
          await reportGen2.sendDailyChatTrendReport();
          console.log('[DASHBOARD] ??? Chat Trend report sent');
        } catch (err) {
          console.error('[DASHBOARD] Chat Trend report failed:', err.message);
        }
      }
    }
    setInterval(checkDailySchedule, 600000); // check every 10 min (was 1hr - missed 1PM window)
    // Also run once on startup (delayed)
    setTimeout(checkDailySchedule, 120000);
  });

  // Let EADDRINUSE crash the process ??? PM2 will restart cleanly
  server.on('error', function(err) {
    if (err.code === 'EADDRINUSE') {
      console.error('[DASHBOARD] Port ' + PORT + ' already in use. Exiting for PM2 restart...');
    process.exit(1);
    } else {
      console.error('[DASHBOARD] Server error:', err.message);
    }
  });
}

// Background scraper for agent chat loads (used by /api/agent-chatflow)
// Uses persistent browser mode ??? first cycle logs in, subsequent cycles just refresh
function startChatLoadScraper() {
  function onScrapeResult(result) {
    try { if (result && result.totalActiveChats !== undefined) {
      var offset = CONFIG.dashboard.engageOffset || 0;
      // REPLACE all counts with fresh scrape data whenever the scraper found real agents.
      // Removed the old merge path (which depended on engageTotalActiveChats) — it caused
      // stale per-agent counts to persist when the header text regex didn't match.
      if (result.rawTotalActiveChats > 0) {
        cachedChatLoads.groupChatCounts = result.groupChatCounts || {};
        cachedChatLoads.agentChatCounts = result.agentChatCounts || {};
        cachedChatLoads.rawAgentCounts = result.rawAgentCounts || {};
        cachedChatLoads.platformCounts = result.platformCounts || {};
        cachedChatLoads.totalActiveChats = result.totalActiveChats || 0;
        cachedChatLoads.rawTotalActiveChats = result.rawTotalActiveChats || 0;
        cachedChatLoads.engageTotalActiveChats = (result.engageTotalActiveChats || 0) + offset;
        cachedChatLoads.mappedActiveChats = result.mappedActiveChats || 0;
        cachedChatLoads.timestamp = Date.now();
        cachedChatLoads.lastError = null;
        console.log('[DASHBOARD] Scrape: ' + Object.keys(result.agentChatCounts || {}).length + ' agents, raw=' + (result.rawTotalActiveChats || 0) + ', Engage=' + (result.engageTotalActiveChats || '?') + (offset ? ' +' + offset + ' offset' : ''));
      } else {
        console.log('[DASHBOARD] Scrape SKIPPED (rawTotalActiveChats=0 — preserving cached data)');
      }

      // ============================================================
      // 12+ CHAT ALERT — State-based, batched, image+text in one message
      // Rules:
      //   - 1 agent at 12+ → notify that 1
      //   - 3 agents at 12+ → notify all 3 together in 1 message
      //   - Notify only once until agent drops below 12
      //   - When below 12 and back to 12+ → re-notify
      // ============================================================
      if (result.agentChatCounts) {
          var now = Date.now();
          var groupsData = require('./shared/read_groups');
          var telegram = require('./shared/telegram_sender');
          var newlyAlerted = []; // agents triggering alert this cycle
          var allAt12Plus = {};  // all agents currently at 12+

          // Check which agents are at 12+
          Object.keys(result.agentChatCounts).forEach(function(agent) {
            var chatCount = result.agentChatCounts[agent];
            if (chatCount >= 12) {
              allAt12Plus[agent] = chatCount;
              // State-based: only alert if NOT already in alerted state
              if (!ALERTED_AGENTS[agent]) {
                ALERTED_AGENTS[agent] = true;
                newlyAlerted.push(agent);
              }
            } else {
              // Below 12 — clear alerted state so they can be re-notified
              if (ALERTED_AGENTS[agent]) {
                delete ALERTED_AGENTS[agent];
              }
            }
          });

          // Send ONE batched Telegram alert for ALL newly alerted agents
          if (newlyAlerted.length > 0) {
            var agentLines = [];
            newlyAlerted.forEach(function(a) {
              var ag = groupsData.getGroupForAgent(a) || 'Unknown';
              agentLines.push('\u{1F464} Agent: ' + a + ' (' + ag + ')\n\u{1F4AC} Active Chats: ' + allAt12Plus[a] + ' (exceeds 12-chat threshold)');
            });
            var batchAlertMsg = '\u{1F6A8} HIGH CHATFLOW ALERT \u{1F6A8}\n\n' + agentLines.join('\n\n') + '\n\nHi Team Leaders,\n\nOne or more agents are currently handling an unusually high volume of chats. Kindly check with the team to identify any potential issues affecting the increased chatflow and provide immediate assistance if needed.\n\n\u{1F4F1} @Micheal_CSMAdmin @Oliver_CSMAdmin\n\n\u{1F4AA} Thank you for your prompt attention to this matter.';

            try {
              // Send text-only with @mentions (no image — per Tab2 requirement)
              telegram.sendTelegramText(batchAlertMsg);
              console.log('[DASHBOARD] Telegram alert sent for ' + newlyAlerted.length + ' agent(s): ' + newlyAlerted.join(', '));
            } catch (e) {
              console.error('[DASHBOARD] Telegram alert failed:', e.message);
            }

            // SSE broadcast for each newly alerted agent
            newlyAlerted.forEach(function(agent) {
              try {
                broadcastSSE('highchat', { agents: [{ name: agent, chats: allAt12Plus[agent], group: groupsData.getGroupForAgent(agent) || 'Unknown' }], timestamp: now });
              } catch (e) {}
            });
          }

          // Broadcast full list of all agents currently at 12+ chats
          try { broadcastSSE('highchat-list', { agents: allAt12Plus, timestamp: now }); } catch (e) {}
      }
    }
    } catch (err) {
      cachedChatLoads.lastError = err.message;
      console.error('[DASHBOARD] Scrape error:', err.message);
    }
  }

  // Start persistent scraper (keeps browser open, first run logs in, rest just refresh)
  try {
    var scraper = require('./tab2-chatflow/scrape_chat_load');
    scraper.startPersistent(onScrapeResult, function(engageCount) {
      // Fast header update ??? refresh engage count only
      if (engageCount > 0) {
        var offset = CONFIG.dashboard.engageOffset || 0;
        var adjusted = engageCount + offset;
        cachedChatLoads.engageTotalActiveChats = adjusted;
        cachedChatLoads.timestamp = Date.now();
        console.log('[DASHBOARD] Engage header update: ' + engageCount + (offset ? ' +' + offset + ' offset = ' + adjusted : '') + ' active chats');
      }
    }).catch(function(err) {
      console.error('[DASHBOARD] Scraper persistent loop crashed:', err.message);
    });
    console.log('[DASHBOARD] Persistent scraper started (fast header every 15s, full scroll every 3min)');
  } catch (err) {
    console.error('[DASHBOARD] Persistent scraper failed:', err.message);
  }
}

// Auto-start when run directly via `node src/dashboard_server.js`
if (require.main === module) {
  startDashboard();

  // ============================================================
  // GRACEFUL SHUTDOWN (only for standalone mode)
  // ============================================================
  process.on('SIGINT', function() {
    console.log('\n[DASHBOARD] Shutting down...');
    DashboardData.stopPolling();
    DashboardData.savePersistedData();
    process.exit(0);
  });

  process.on('SIGTERM', function() {
    DashboardData.stopPolling();
    DashboardData.savePersistedData();
    process.exit(0);
  });

  // Catch crashes — log the reason instead of silently restarting
  process.on('uncaughtException', function(err) {
    console.error('[DASHBOARD] UNCAUGHT EXCEPTION:', err.message);
    console.error(err.stack);
    // Do NOT exit - see comment above
    // process.exit(1);
  });
  process.on('unhandledRejection', function(reason) {
    console.error('[DASHBOARD] UNHANDLED REJECTION:', reason && reason.message ? reason.message : reason);
    if (reason && reason.stack) console.error(reason.stack);
    // Do NOT exit - see comment above
    // process.exit(1);
  });
}

module.exports = { app, startDashboard };
