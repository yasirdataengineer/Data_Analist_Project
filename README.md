# TJP-EJS One Hub

Telegram Mini App ("satu pintu untuk pekerjaan Anda") untuk tim TJP / EJS, dibangun dengan **Node.js + Express + EJS**.

| Modul | Fitur |
|---|---|
| **Monitoring Progres** | Evaluasi & penugasan pekerjaan: pemilik membuat penugasan ke PIC, PIC mengisi persentase, hasil/kendala, dan foto terbaru; pemilik mengevaluasi lalu menetapkan Open/Closed |
| **Sistem Absensi** | Absen masuk/pulang (jam, GPS, selfie opsional), rencana pekerjaan, laporan progres harian, pengajuan lembur, riwayat; laporan absensi tim untuk pemilik & management |
| **Sistem Payroll** | Slip gaji bulanan (gaji pokok + tunjangan + lembur − kasbon − potongan), persetujuan lembur, koreksi lembur, kasbon, rekap bulanan + finalisasi slip (mengunci bulan), data gaji |
| **Sistem Proc & Res** | Pengajuan & laporan dana: ajukan kebutuhan → persetujuan pemilik → transfer + bukti → laporan + foto bukti → *Laporan Close*. Jenis pengajuan & kategori tujuan bisa dikelola |
| **Lap Pettycash** | Saldo awal, tambah saldo, transfer pengajuan dari Petty Cash, pengembalian sisa, laporan penggunaan dana per periode |
| **Approval & Bukti Transfer** | Setujui/tolak pengajuan, transfer dengan tanggal, bukti, dan sumber dana (Petty Cash / Rekening Induk TJP) |
| **Cash Flow Project** | Input project & penerimaan project; arus kas = penerimaan − transfer pengeluaran + pengembalian sisa |
| **User Admin / Management** | Tambah karyawan yang sudah membuka bot, ubah peran (Pemilik/Admin/Management/Karyawan) & perusahaan (TJP/EJS), aktifkan atau cabut akses |

### Peran

| Peran | Akses |
|---|---|
| Pemilik | Semua; satu-satunya yang menyetujui pengajuan dan mengubah peran |
| Admin | Payroll, Proc & Res, Petty Cash, Cash Flow Project, pengelolaan pengguna (menambah/mencabut karyawan). Sistem Absensi tidak tersedia |
| Management | Lihat laporan absensi, progres, pengajuan, Petty Cash, dan arus kas proyek |
| Karyawan | Progres (penugasan sendiri), Absensi, slip gaji/kasbon/koreksi lembur, membuat pengajuan |

Aturan uang: hanya transfer dari **Petty Cash** yang mengurangi saldo kas; transfer dari **Rekening Induk TJP** tetap tercatat di arus kas proyek. Penerimaan proyek tidak otomatis menambah Petty Cash; pengisian kas dicatat lewat *Tambah saldo*.

Upah lembur memakai aturan Kepmenakertrans 102/2004 untuk hari kerja: upah per jam = gaji pokok ÷ 173, jam pertama ×1,5, jam berikutnya ×2.

## Cara membuka aplikasi

1. **Di dalam Telegram (Mini App):** buka bot, tekan tombol menu **One Hub**. Login otomatis karena `initData` dari Telegram diverifikasi di server dengan HMAC token bot.
2. **Sebagai aplikasi terpasang (PWA) di Android, iPhone, atau desktop:** buka URL aplikasi di browser, tekan **Masuk dengan Telegram**, lalu **Pasang**.
   - **Android / Chrome / Edge desktop:** tombol **Pasang** di halaman utama memunculkan dialog instalasi.
   - **iPhone / iPad:** buka di Safari → **Bagikan** → **Tambah ke Layar Utama**.

### Masuk dengan Telegram (di luar Telegram)

Tidak ada password. Aplikasi menampilkan kode 4 digit dan tombol **Buka Telegram** (`t.me/<bot>?start=login_…`). Bot menampilkan kode yang sama dan meminta konfirmasi **"Ya, ini saya"**. Setelah dikonfirmasi, aplikasi langsung masuk. Detailnya:
- Link berlaku 5 menit dan hanya bisa dipakai sekali. Permintaan login terikat ke browser yang memulainya lewat cookie bertanda tangan.
- Pencocokan kode mencegah orang lain mengirim link login miliknya ke korban.
- `bot.js` mengonfirmasi ke server lewat `/auth/bot/lookup` dan `/auth/bot/confirm` dengan tanda tangan HMAC dari token bot, jadi hanya proses yang memegang token yang bisa mengonfirmasi.
- Sesi berlaku 30 hari. Tombol **Keluar** ada di bagian bawah halaman utama.

PWA menyimpan file statis (CSS, JS, ikon) untuk mempercepat pembukaan dan menampilkan halaman offline saat tidak ada sinyal. Halaman berisi data pribadi atau keuangan **tidak** disimpan di cache.

## Menjalankan

Butuh Node.js 22.9 atau lebih baru.

```bash
npm install
cp .env.example .env      # isi TELEGRAM_BOT_TOKEN, SESSION_SECRET, dll.
npm start                 # web app (port 3000)
npm run bot               # bot Telegram: tombol menu "One Hub" + /start
```

Pengembangan lokal tanpa Telegram: `npm run dev`, lalu buka http://localhost:3000. Form login dev (bisa memilih peran) aktif karena `DEV_LOGIN=1`. **Jangan aktifkan di produksi.**

Tes: `npm test`

## Menghubungkan ke Telegram

1. Buat bot di [@BotFather](https://t.me/BotFather) dan salin tokennya ke `TELEGRAM_BOT_TOKEN`.
2. Deploy `server.js` ke URL **HTTPS** publik (syarat Telegram Mini App) dan isi `WEBAPP_URL`.
3. Jalankan `npm run bot`. Bot memasang tombol menu **One Hub**, membalas `/start` dengan tombol untuk membuka aplikasi, dan menangani konfirmasi **Masuk dengan Telegram**. Bot menghubungi server di `WEBAPP_URL`, atau di `APP_INTERNAL_URL` bila diisi (mis. `http://localhost:3000` jika satu mesin).
4. Notifikasi: tambahkan bot ke grup, kirim `/id`, lalu isi `TELEGRAM_NOTIFY_CHAT_ID` dengan ID tersebut.
5. Isi `OWNER_TELEGRAM_IDS` dengan ID Telegram pemilik. Karyawan lain cukup membuka bot sekali (statusnya "menunggu akses", pemilik mendapat notifikasi), lalu pemilik/admin menambahkannya di **User Admin / Management**.

## Struktur

```
server.js            entry point + konfigurasi dari env
app.js               Express app, auth Telegram, routing
bot.js               bot long-polling (menu button, /start, /id, konfirmasi login)
routes/progress.js    Monitoring Progres (penugasan & evaluasi)
routes/attendance.js  Sistem Absensi
routes/payroll.js     Sistem Payroll (perhitungan di lib/payroll.js)
routes/procurement.js Sistem Proc & Res
routes/cash.js        Lap Pettycash, Approval & Transfer, Cash Flow Project (aturan di lib/finance.js)
routes/users.js       User Admin / Management (peran di lib/access.js)
lib/                  store JSON, validasi Telegram, sesi, tanggal (WIB)
views/               template EJS
public/              CSS, script, manifest PWA, service worker, ikon, halaman offline
data/                db.json & foto upload (dibuat otomatis, tidak di-commit)
```

Data disimpan di `data/db.json` (cukup untuk tim kecil). Untuk skala lebih besar, `lib/store.js` bisa diganti dengan database seperti PostgreSQL tanpa mengubah route.
