// Telegram bot that opens the One Hub Mini App. Runs with long polling; no webhook needed.
//   TELEGRAM_BOT_TOKEN=... WEBAPP_URL=https://hub.example.com node bot.js
const { callBotApi, signBotPayload } = require('./lib/telegram');

const token = process.env.TELEGRAM_BOT_TOKEN;
const webAppUrl = process.env.WEBAPP_URL;
if (require.main === module && (!token || !webAppUrl)) {
  console.error('TELEGRAM_BOT_TOKEN and WEBAPP_URL (https) are required.');
  process.exit(1);
}

// Where bot.js reaches the web server for "Masuk dengan Telegram". Defaults to the public URL; set
// APP_INTERNAL_URL (e.g. http://localhost:3000) when both run on the same machine.
const serverUrl = (process.env.APP_INTERNAL_URL || webAppUrl || '').replace(/\/$/, '');

const api = (method, payload = {}) => callBotApi(token, method, payload);

async function callServer(path, payload) {
  const res = await fetch(serverUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signBotPayload(token, payload)),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const tgUserFields = (u) => ({ id: u.id, first_name: u.first_name || '', last_name: u.last_name || '', username: u.username || '' });

async function startLogin(msg, loginToken) {
  const chatId = msg.chat.id;
  if (msg.chat.type !== 'private') return;
  const { status, body } = await callServer('/auth/bot/lookup', { token: loginToken });
  if (status !== 200) {
    await api('sendMessage', { chat_id: chatId, text: 'Link login sudah kedaluwarsa atau sudah dipakai. Tekan lagi "Masuk dengan Telegram" di aplikasi.' });
    return;
  }
  await api('sendMessage', {
    chat_id: chatId,
    text: `🔐 Permintaan masuk ke <b>TJP-EJS One Hub</b>.\n\nPastikan kode di layar aplikasi adalah <b>${body.code}</b>.\nJika Anda tidak sedang login, tekan "Bukan saya".`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: `✅ Ya, ini saya (${body.code})`, callback_data: `lg:y:${loginToken}` },
        { text: '❌ Bukan saya', callback_data: `lg:n:${loginToken}` },
      ]],
    },
  });
}

async function handleCallback(cb) {
  const m = /^lg:([yn]):([0-9a-f]{32})$/.exec(cb.data || '');
  if (!m) return api('answerCallbackQuery', { callback_query_id: cb.id });
  const approve = m[1] === 'y';
  const { status, body } = await callServer('/auth/bot/confirm', { token: m[2], approve, user: tgUserFields(cb.from) });
  let text;
  if (status !== 200) text = 'Link login sudah kedaluwarsa. Ulangi dari aplikasi.';
  else if (!approve) text = 'Permintaan login ditolak. Tidak ada yang masuk ke akun Anda.';
  else if (body.active) text = '✅ Login berhasil. Silakan kembali ke aplikasi One Hub.';
  else text = '✅ Akun terhubung. Akses Anda menunggu persetujuan pemilik/admin.';
  await api('answerCallbackQuery', { callback_query_id: cb.id, text: approve && status === 200 ? 'Berhasil' : '' });
  if (cb.message) await api('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text });
}
const openButton = (text, path = '') => ({ text, web_app: { url: (webAppUrl || '').replace(/\/$/, '') + path } });

async function handle(msg) {
  const text = (msg.text || '').trim();
  const chatId = msg.chat.id;
  const login = /^\/start login_([0-9a-f]{32})$/.exec(text);
  if (login) return startLogin(msg, login[1]);
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
      const updates = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) await handle(u.message).catch((e) => console.error('[bot]', e.message));
        if (u.callback_query) await handleCallback(u.callback_query).catch((e) => console.error('[bot]', e.message));
      }
    } catch (err) {
      console.error('[bot] polling:', err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

if (require.main === module) main();

module.exports = { handle, handleCallback };
