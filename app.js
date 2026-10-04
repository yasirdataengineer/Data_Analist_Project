const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');

const { validateInitData, callBotApi, verifyBotPayload } = require('./lib/telegram');
const { createNotifier } = require('./lib/notifier');
const { setSession, clearSession, getSessionUserId, setSignedCookie, getSignedCookie, clearCookie } = require('./lib/session');
const { BotLoginRequests } = require('./lib/botLogin');
const { ROLES, can } = require('./lib/access');
const { badRequest } = require('./lib/errors');
const dates = require('./lib/dates');

const DEFAULT_PROC_TYPES = ['Operasional', 'Pembelian barang', 'Kebutuhan lainnya'];
const DEFAULT_PROC_CATEGORIES = [
  { name: 'Project', requiresProject: true },
  { name: 'Kantor', requiresProject: false },
  { name: 'Kendaraan', requiresProject: false },
  { name: 'Lainnya', requiresProject: false },
];

function seed(store) {
  if (!store.all('procTypes').length) DEFAULT_PROC_TYPES.forEach((name) => store.insert('procTypes', { name, active: true }));
  if (!store.all('procCategories').length) DEFAULT_PROC_CATEGORIES.forEach((c) => store.insert('procCategories', { ...c, active: true }));
}

function createApp(config, store) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('trust proxy', true);
  seed(store);
  const notifier = createNotifier(config, store);

  fs.mkdirSync(config.uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: config.uploadDir,
      filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype) || file.mimetype === 'application/pdf'),
  });

  app.use(express.urlencoded({ extended: false }));
  // Keep the raw body: WhatsApp webhooks are verified against an HMAC of the exact bytes.
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use('/public', express.static(path.join(__dirname, 'public')));
  // The service worker must be served from the root so its scope covers the whole app.
  app.get('/sw.js', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, 'public', 'sw.js'));
  });
  app.get('/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json').sendFile(path.join(__dirname, 'public', 'manifest.webmanifest'));
  });
  app.use('/uploads', express.static(config.uploadDir));

  // Owners listed in env are always active owners, so the first login can bootstrap everything else.
  const ownerPhones = config.ownerPhones || [];
  const applyOwner = (user) => {
    const isOwner = user && (config.ownerIds.includes(user.id) || (user.phone && ownerPhones.includes(user.phone)));
    if (isOwner && (user.role !== 'owner' || !user.active)) {
      return store.update('users', user.id, { role: 'owner', active: true, company: user.company || 'TJP' });
    }
    return user;
  };

  app.use((req, res, next) => {
    const userId = getSessionUserId(req, config.sessionSecret);
    req.user = applyOwner(userId ? store.find('users', (u) => u.id === userId) : null);
    req.can = (perm) => can(req.user, perm);
    Object.assign(res.locals, {
      user: req.user,
      can: req.can,
      ROLES,
      appName: config.appName,
      d: dates,
      path: req.path,
      flash: req.query.ok || null,
    });
    next();
  });

  // --- Auth -----------------------------------------------------------------

  app.get('/login', (req, res) => {
    if (req.user?.active) return res.redirect('/');
    res.render('login', { devLogin: config.devLogin, botLogin: !!config.botToken, waLogin: !!(config.whatsapp?.enabled && config.whatsapp.businessNumber) });
  });

  const afterLogin = (user, isNew) => {
    user = applyOwner(user);
    if (isNew && !user.active) {
      notifier.owners(`👤 ${user.name}${user.username ? ` (@${user.username})` : ''}${user.phone ? ` (+${user.phone})` : ''} membuka One Hub dan menunggu akses.`);
    }
    return user;
  };

  app.post('/auth/telegram', (req, res) => {
    const tgUser = validateInitData(req.body.initData, config.botToken);
    if (!tgUser) return res.status(401).json({ ok: false, error: 'initData tidak valid' });
    const isNew = !store.find('users', (u) => u.id === String(tgUser.id));
    const user = afterLogin(store.upsertUser(tgUser), isNew);
    setSession(res, user.id, config.sessionSecret);
    res.json({ ok: true });
  });

  // Local development without Telegram. Disabled unless DEV_LOGIN=1.
  app.post('/auth/dev', (req, res) => {
    if (!config.devLogin) return res.status(404).end();
    const id = (req.body.id || 'dev-1').trim();
    const isNew = !store.find('users', (u) => u.id === id);
    let user = store.upsertUser({ id, first_name: (req.body.name || 'Pak yasir').trim(), username: req.body.username || undefined });
    if (ROLES[req.body.role]) user = store.update('users', id, { role: req.body.role, active: true, company: req.body.company || 'TJP' });
    user = afterLogin(user, isNew);
    setSession(res, user.id, config.sessionSecret);
    res.redirect('/');
  });

  // --- Masuk dengan Telegram / WhatsApp (installed app / browser) ----------

  const botLogins = new BotLoginRequests({ ttlMs: config.botLoginTtlMs });
  const LOGIN_COOKIE = 'tjp_login';
  let botUsername = config.botUsername || null;
  const getBotUsername = async () => {
    if (!botUsername) botUsername = (await callBotApi(config.botToken, 'getMe', {})).username;
    return botUsername;
  };
  const waReady = () => !!(config.whatsapp?.enabled && config.whatsapp.businessNumber);

  // body.channel: "telegram" | "whatsapp". body.purpose: "login" (default) or "link" (attach a
  // WhatsApp number to the logged-in account).
  app.post('/auth/bot/start', async (req, res, next) => {
    try {
      const channel = req.body?.channel === 'whatsapp' ? 'whatsapp' : 'telegram';
      const purpose = req.body?.purpose === 'link' ? 'link' : 'login';
      if (channel === 'telegram' && !config.botToken) return res.status(503).json({ ok: false, error: 'Bot Telegram belum dikonfigurasi.' });
      if (channel === 'whatsapp' && !waReady()) return res.status(503).json({ ok: false, error: 'WhatsApp belum dikonfigurasi.' });
      if (purpose === 'link' && (channel !== 'whatsapp' || !req.user?.active)) return res.status(400).json({ ok: false, error: 'Masuk dulu untuk menghubungkan WhatsApp.' });
      if (botLogins.requests.size > 1000) return res.status(429).json({ ok: false, error: 'Terlalu banyak permintaan, coba lagi.' });

      const { token, ref, code, browserSecret } = botLogins.create({ purpose, userId: purpose === 'link' ? req.user.id : null });
      let link;
      if (channel === 'telegram') {
        link = `https://t.me/${await getBotUsername()}?start=login_${token}`;
      } else {
        const text = `${purpose === 'link' ? 'HUBUNGKAN' : 'MASUK'} ${ref}`;
        link = `https://wa.me/${config.whatsapp.businessNumber}?text=${encodeURIComponent(text)}`;
      }
      setSignedCookie(res, LOGIN_COOKIE, `${token}:${browserSecret}`, config.sessionSecret, Math.ceil(botLogins.ttlMs / 1000));
      res.json({ ok: true, code, link, expiresIn: Math.floor(botLogins.ttlMs / 1000) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/auth/bot/status', (req, res) => {
    const [token, browserSecret] = (getSignedCookie(req, LOGIN_COOKIE, config.sessionSecret) || '').split(':');
    const r = token && botLogins.consume(token, browserSecret);
    if (!r) {
      clearCookie(res, LOGIN_COOKIE);
      return res.json({ status: 'expired' });
    }
    if (r.status === 'pending') return res.json({ status: 'pending' });
    clearCookie(res, LOGIN_COOKIE);
    if (r.status === 'denied') return res.json({ status: 'denied' });
    if (r.purpose === 'link') return res.json({ status: 'linked' });
    setSession(res, r.userId, config.sessionSecret);
    res.json({ status: 'confirmed' });
  });

  // Called by bot.js (signed with the bot token). Returns the code so the bot can show it.
  app.post('/auth/bot/lookup', (req, res) => {
    if (!verifyBotPayload(config.botToken, req.body)) return res.status(401).json({ ok: false });
    const r = botLogins.get(String(req.body.token));
    if (!r || r.status !== 'pending' || r.purpose !== 'login') return res.status(404).json({ ok: false });
    res.json({ ok: true, code: r.code });
  });

  app.post('/auth/bot/confirm', (req, res) => {
    if (!verifyBotPayload(config.botToken, req.body)) return res.status(401).json({ ok: false });
    const tgUser = req.body.user;
    if (!tgUser || !tgUser.id) return res.status(400).json({ ok: false });
    const pending = botLogins.get(String(req.body.token));
    if (!pending || pending.status !== 'pending' || pending.purpose !== 'login') return res.status(404).json({ ok: false });
    if (req.body.approve !== true) {
      botLogins.resolve(pending.token, false);
      return res.json({ ok: true, status: 'denied' });
    }
    const isNew = !store.find('users', (u) => u.id === String(tgUser.id));
    const user = afterLogin(store.upsertUser(tgUser), isNew);
    botLogins.resolve(pending.token, true, user.id);
    res.json({ ok: true, status: 'confirmed', active: !!user.active });
  });

  // WhatsApp Cloud API webhook: login/link confirmations arrive here.
  app.use('/webhooks/whatsapp', require('./routes/whatsapp')({ store, config, botLogins, afterLogin }));

  app.post('/logout', (req, res) => {
    clearSession(res);
    res.redirect('/login');
  });

  app.use((req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (!req.user.active) return res.status(403).render('pending');
    next();
  });

  // Route guard: router.get('/x', need('perm.a', 'perm.b'), ...) passes if the user has any of them.
  const need = (...perms) => (req, res, next) => {
    if (perms.some((p) => req.can(p))) return next();
    const err = badRequest('Anda tidak punya akses ke halaman ini.');
    err.status = 403;
    next(err);
  };

  // --- Hub ------------------------------------------------------------------

  app.get('/', (req, res) => res.render('hub'));

  const deps = { store, upload, config, need, notifier };
  app.use('/progres', need('progress.view'), require('./routes/progress')(deps));
  app.use('/absensi', need('attendance.self', 'attendance.report'), require('./routes/attendance')(deps));
  app.use('/payroll', need('payroll.self', 'payroll.manage'), require('./routes/payroll')(deps));
  app.use('/proc', need('proc.request', 'proc.viewAll'), require('./routes/procurement')(deps));
  app.use('/kas', need('kas.view'), require('./routes/cash')(deps));
  app.use('/pengguna', need('users.manage'), require('./routes/users')(deps));
  app.use('/profil', require('./routes/profile')(deps));

  app.use((req, res) => res.status(404).render('error', { message: 'Halaman tidak ditemukan.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) Object.assign(err, { status: 400, expose: true, message: `Upload gagal: ${err.message}` });
    if (!err.expose) console.error(err);
    res.status(err.status || 500).render('error', { message: err.expose ? err.message : 'Terjadi kesalahan.' });
  });

  return app;
}

module.exports = { createApp };
