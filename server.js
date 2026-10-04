const path = require('path');
const crypto = require('crypto');
const { createApp } = require('./app');
const { Store } = require('./lib/store');

const config = {
  appName: process.env.APP_NAME || 'TJP-EJS One Hub',
  port: Number(process.env.PORT) || 3000,
  botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  // Optional: looked up with getMe on first "Masuk dengan Telegram" if not set.
  botUsername: (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, ''),
  notifyChatId: process.env.TELEGRAM_NOTIFY_CHAT_ID || '',
  ownerIds: (process.env.OWNER_TELEGRAM_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  devLogin: process.env.DEV_LOGIN === '1',
  dataFile: process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json'),
  uploadDir: process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'uploads'),
};

if (!process.env.SESSION_SECRET) console.warn('[warn] SESSION_SECRET not set; sessions reset on restart.');
if (!config.ownerIds.length) console.warn('[warn] OWNER_TELEGRAM_IDS not set; nobody can grant access.');
if (!config.botToken && !config.devLogin) console.warn('[warn] TELEGRAM_BOT_TOKEN not set; Telegram login will fail.');

const app = createApp(config, new Store(config.dataFile));
app.listen(config.port, () => console.log(`${config.appName} listening on :${config.port}`));
