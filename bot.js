// Telegram bot that opens the One Hub Mini App. Runs with long polling; no webhook needed.
//   TELEGRAM_BOT_TOKEN=... WEBAPP_URL=https://hub.example.com node bot.js
const { callBotApi } = require('./lib/telegram');

const token = process.env.TELEGRAM_BOT_TOKEN;
const webAppUrl = process.env.WEBAPP_URL;
if (!token || !webAppUrl) {
  console.error('TELEGRAM_BOT_TOKEN and WEBAPP_URL (https) are required.');
  process.exit(1);
}

const api = (method, payload = {}) => callBotApi(token, method, payload);
const openButton = (text, path = '') => ({ text, web_app: { url: webAppUrl.replace(/\/$/, '') + path } });

async function handle(msg) {
  const text = (msg.text || '').trim();
  const chatId = msg.chat.id;
  if (text.startsWith('/start') || text.startsWith('/hub')) {
    await api('sendMessage', {
      chat_id: chatId,
      text: 'Selamat datang di <b>TJP-EJS One Hub</b>.\nSatu pintu untuk pekerjaan Anda.',
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [openButton('Buka One Hub')],
          [openButton('📈 Monitoring Progres', '/progres'), openButton('🗓️ Absensi', '/absensi')],
        ],
      },
    });
  } else if (text.startsWith('/id')) {
    await api('sendMessage', { chat_id: chatId, text: `Chat ID: <code>${chatId}</code>`, parse_mode: 'HTML' });
  }
}

async function main() {
  await api('setChatMenuButton', { menu_button: { type: 'web_app', text: 'One Hub', web_app: { url: webAppUrl } } });
  await api('setMyCommands', {
    commands: [
      { command: 'start', description: 'Buka TJP-EJS One Hub' },
      { command: 'id', description: 'Tampilkan chat ID (untuk notifikasi)' },
    ],
  });
  console.log('Bot running. Menu button ->', webAppUrl);

  let offset = 0;
  for (;;) {
    try {
      const updates = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) await handle(u.message).catch((e) => console.error('[bot]', e.message));
      }
    } catch (err) {
      console.error('[bot] polling:', err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main();
