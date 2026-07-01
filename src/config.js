/**
 * config.js — Break Bot Server configuration (standalone)
 * Only break-related config, loaded from .env
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const CONFIG = {
  // Break Bot Telegram (@CSBreakMonitoring_bot)
  breakBotToken: process.env.BREAK_BOT_TOKEN || '',
  breakSheetId: process.env.BREAK_SHEET_ID || '',
  breakGroupId: process.env.BREAK_GROUP_ID || '',

  // Break Bot Google Service Account (independent quota pool)
  breakServiceAccountPath: process.env.BREAK_SERVICE_ACCOUNT_PATH || '',

  // Server
  port: parseInt(process.env.BREAK_SERVER_PORT, 10) || 3004,
  host: process.env.BREAK_SERVER_HOST || '0.0.0.0',

  // Timezone
  timezone: 'Asia/Manila',
};

module.exports = CONFIG;
