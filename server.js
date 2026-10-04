const path = require('path');
const crypto = require('crypto');
const { createApp } = require('./app');
const { Store } = require('./lib/store');

const config = {
  appName: process.env.APP_NAME || 'TJP-EJS One Hub',
  port: Number(process.env.PORT) || 3000,
  botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  notifyChatId: process.env.TELEGRAM_NOTIFY_CHAT_ID || '',
  adminIds: (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  devLogin: process.env.DEV_LOGIN === '1',
  dataFile: process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json'),
  uploadDir: process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'uploads'),
};

if (!process.env.SESSION_SECRET) console.warn('[warn] SESSION_SECRET not set; sessions reset on restart.');
if (!config.botToken && !config.devLogin) console.warn('[warn] TELEGRAM_BOT_TOKEN not set; Telegram login will fail.');

const app = createApp(config, new Store(config.dataFile));
app.listen(config.port, () => console.log(`${config.appName} listening on :${config.port}`));
