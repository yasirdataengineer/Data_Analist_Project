// One place to send notifications, so every event reaches people on the channels they chose.
// - Telegram: users who logged in through Telegram (their Telegram id is their private chat id).
// - WhatsApp: users with a verified number, via the approved notification template.
// Failures are logged and swallowed; a messaging outage must never break a request.
const { callBotApi } = require('./telegram');
const wa = require('./whatsapp');

// Users created through Telegram are keyed by their numeric Telegram id.
const telegramChatId = (user) => user?.telegramId || (/^\d+$/.test(user?.id || '') ? user.id : null);

function channelsFor(user) {
  const prefs = user?.notify || {};
  return {
    telegram: !!telegramChatId(user) && prefs.telegram !== false,
    whatsapp: !!user?.phone && prefs.whatsapp !== false,
  };
}

function createNotifier(config, store) {
  const log = (channel) => (err) => console.error(`[notify:${channel}]`, err.message);

  const telegram = (chatId, text) => {
    if (!config.botToken || !chatId) return;
    callBotApi(config.botToken, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' }).catch(log('telegram'));
  };
  const whatsapp = (phone, text) => {
    if (!config.whatsapp?.enabled || !phone) return;
    wa.sendTemplate(config.whatsapp, phone, text).catch(log('whatsapp'));
  };

  const user = (userOrId, text) => {
    const u = typeof userOrId === 'string' ? store.find('users', (x) => x.id === userOrId) : userOrId;
    if (!u) return;
    const ch = channelsFor(u);
    if (ch.telegram) telegram(telegramChatId(u), text);
    if (ch.whatsapp) whatsapp(u.phone, text);
  };

  return {
    user,
    // The team's Telegram group (WhatsApp Cloud API can't post to groups).
    group: (text) => telegram(config.notifyChatId, text),
    owners: (text) => store.filter('users', (u) => u.role === 'owner' && u.active).forEach((u) => user(u, text)),
  };
}

module.exports = { createNotifier, channelsFor, telegramChatId };
