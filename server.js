const path = require('path');
const crypto = require('crypto');
const { createApp } = require('./app');
const { Store } = require('./lib/store');
const { normalizePhone } = require('./lib/whatsapp');

const config = {
  appName: process.env.APP_NAME || 'TJP-EJS One Hub',
  port: Number(process.env.PORT) || 3000,
  botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  // Optional: looked up with getMe on first "Masuk dengan Telegram" if not set.
  botUsername: (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, ''),
  notifyChatId: process.env.TELEGRAM_NOTIFY_CHAT_ID || '',
  ownerIds: (process.env.OWNER_TELEGRAM_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  ownerPhones: (process.env.OWNER_WHATSAPP_NUMBERS || '').split(',').map(normalizePhone).filter(Boolean),
  whatsapp: {
    enabled: !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID),
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    businessNumber: normalizePhone(process.env.WHATSAPP_BUSINESS_NUMBER) || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v22.0',
    notifyTemplate: process.env.WHATSAPP_TEMPLATE_NOTIFY || 'onehub_notifikasi',
    templateLang: process.env.WHATSAPP_TEMPLATE_LANG || 'id',
  },
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  devLogin: process.env.DEV_LOGIN === '1',
  dataFile: process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json'),
  uploadDir: process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'uploads'),
};

if (!process.env.SESSION_SECRET) console.warn('[warn] SESSION_SECRET not set; sessions reset on restart.');
if (!config.ownerIds.length && !config.ownerPhones.length) console.warn('[warn] OWNER_TELEGRAM_IDS not set; nobody can grant access.');
if (config.whatsapp.enabled && (!config.whatsapp.businessNumber || !config.whatsapp.appSecret || !config.whatsapp.verifyToken)) {
  console.warn('[warn] WhatsApp needs WHATSAPP_BUSINESS_NUMBER, WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN for login and webhooks.');
}
if (!config.botToken && !config.devLogin) console.warn('[warn] TELEGRAM_BOT_TOKEN not set; Telegram login will fail.');

const app = createApp(config, new Store(config.dataFile));
app.listen(config.port, () => console.log(`${config.appName} listening on :${config.port}`));
