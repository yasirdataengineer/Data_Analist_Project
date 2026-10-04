# TJP-EJS One Hub

Telegram Mini App ("satu pintu untuk pekerjaan Anda") untuk tim TJP / EJS, dibangun dengan **Node.js + Express + EJS**.

| Modul | Fitur |
|---|---|
| **Monitoring Progres** | Daftar proyek dengan persentase, foto terbaru, PIC; update progres + catatan + foto; riwayat update per PIC; notifikasi ke grup Telegram |
| **Sistem Absensi** | Absen masuk/pulang (jam, lokasi GPS, selfie opsional), rencana pekerjaan harian, laporan progres harian (checklist dari rencana + foto), pengajuan lembur dengan persetujuan admin, riwayat absensi |

Login otomatis memakai akun Telegram. `initData` dari Mini App diverifikasi di server dengan HMAC token bot, jadi tidak perlu username/password.

## Menjalankan

Butuh Node.js 22.9 atau lebih baru.

```bash
npm install
cp .env.example .env      # isi TELEGRAM_BOT_TOKEN, SESSION_SECRET, dll.
npm start                 # web app (port 3000)
npm run bot               # bot Telegram: tombol menu "One Hub" + /start
```

Pengembangan lokal tanpa Telegram: `npm run dev`, lalu buka http://localhost:3000. Form login dev aktif karena `DEV_LOGIN=1`. **Jangan aktifkan di produksi.**

Tes: `npm test`

## Menghubungkan ke Telegram

1. Buat bot di [@BotFather](https://t.me/BotFather) dan salin tokennya ke `TELEGRAM_BOT_TOKEN`.
2. Deploy `server.js` ke URL **HTTPS** publik (syarat Telegram Mini App) dan isi `WEBAPP_URL`.
3. Jalankan `npm run bot`. Bot memasang tombol menu **One Hub** dan membalas `/start` dengan tombol untuk membuka aplikasi.
4. Notifikasi: tambahkan bot ke grup, kirim `/id`, lalu isi `TELEGRAM_NOTIFY_CHAT_ID` dengan ID tersebut.
5. Admin (boleh menyetujui lembur dan update semua proyek): isi `ADMIN_TELEGRAM_IDS` dengan ID Telegram admin, dipisahkan koma.

## Struktur

```
server.js            entry point + konfigurasi dari env
app.js               Express app, auth Telegram, routing
bot.js               bot long-polling (menu button, /start, /id)
routes/progress.js   Monitoring Progres
routes/attendance.js Sistem Absensi
lib/                 store JSON, validasi Telegram, sesi, tanggal (WIB)
views/               template EJS
public/              CSS + script Mini App
data/                db.json & foto upload (dibuat otomatis, tidak di-commit)
```

Data disimpan di `data/db.json` (cukup untuk tim kecil). Untuk skala lebih besar, `lib/store.js` bisa diganti dengan database seperti PostgreSQL tanpa mengubah route.
