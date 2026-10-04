// Telegram Mini App helpers: initData validation and Bot API calls.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
const crypto = require('crypto');

function validateInitData(initData, botToken, maxAgeSeconds = 24 * 60 * 60) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) return null;

  try {
    return JSON.parse(params.get('user'));
  } catch {
    return null;
  }
}

async function callBotApi(botToken, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`${method} failed: ${body.description}`);
  return body.result;
}

// Fire-and-forget notification; never let a Telegram outage break a request.
function notify(config, chatId, text) {
  if (!config.botToken || !chatId) return;
  callBotApi(config.botToken, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' }).catch((err) =>
    console.error('[telegram] notify:', err.message)
  );
}

module.exports = { validateInitData, callBotApi, notify };
