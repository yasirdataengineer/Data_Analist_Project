// Profil: linked accounts (Telegram / WhatsApp) and notification channels for the current user.
const express = require('express');
const { badRequest } = require('../lib/errors');
const { channelsFor, telegramChatId } = require('../lib/notifier');

module.exports = ({ store, config }) => {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.render('profile/index', {
      telegramLinked: !!telegramChatId(req.user),
      channels: channelsFor(req.user),
      waAvailable: !!(config.whatsapp?.enabled && config.whatsapp.businessNumber),
    });
  });

  router.post('/notifikasi', (req, res) => {
    const notify = { telegram: req.body.telegram === '1', whatsapp: req.body.whatsapp === '1' };
    if (!notify.telegram && !notify.whatsapp && (telegramChatId(req.user) || req.user.phone)) {
      throw badRequest('Pilih minimal satu saluran notifikasi.');
    }
    store.update('users', req.user.id, { notify });
    res.redirect('/profil?ok=Pengaturan notifikasi tersimpan');
  });

  router.post('/whatsapp/lepas', (req, res) => {
    // Accounts created through WhatsApp have no other way to log in.
    if (req.user.id.startsWith('wa:')) throw badRequest('Akun ini masuk lewat WhatsApp, jadi nomornya tidak bisa dilepas.');
    store.update('users', req.user.id, { phone: null });
    res.redirect('/profil?ok=WhatsApp dilepas');
  });

  return router;
};
