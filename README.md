# psr.fm

psr.fm adalah aplikasi musik self-hosted untuk download audio dari YouTube, menyimpan lagu di server sendiri, membuat playlist, dan streaming dari browser.

Aplikasi ini cocok untuk server pribadi, keluarga, atau teman kecil-kecilan. Setiap user punya playlist, lagu, riwayat dengar, dan statistik sendiri.

![Dashboard Preview](static/dashboard.jpeg)

## Fitur Utama

- Multi-user dengan akun admin dan user biasa.
- Download lagu dari YouTube ke MP3.
- Library Songs untuk melihat lagu yang sudah pernah didownload semua user.
- Add lagu dari Library Songs tanpa download ulang.
- Peringatan kalau link YouTube yang ditempel sudah ada di Library Songs.
- Playlist pribadi dengan urutan drag-and-drop.
- Search lagu pribadi.
- Lyrics biasa dan synced lyrics jika tersedia.
- Edit lirik manual jika hasil pencarian tidak tersedia atau perlu dikoreksi.
- Share Lyrics Card untuk membuat gambar PNG dari potongan lirik dengan cover lagu dan tema warna.
- Player dengan queue, shuffle, repeat, volume, seek, dan A-B loop.
- Dashboard per user: recently added, top played, top listened, dan storage usage.
- Frequency Focus untuk recap bulanan/tahunan: total waktu dengar, jumlah play, lagu paling sering diputar, lagu paling lama didengar, dan breakdown per bulan untuk mode tahunan.
- Tampilan mobile dengan drawer sidebar, tombol keluar User Management, dan player bawah yang tidak menutup konten.

Dashboard menampilkan maksimal 5 lagu untuk **Recently Added**, **Top Played**, dan **Top Listened** agar halaman tetap ringan.

Catatan perhitungan:

- **Home > Top Played** memakai total historis `play_count`.
- **Frequency Focus > Plays** memakai event play bertanggal dari `play_events`, sehingga bisa dihitung per bulan atau tahun.
- **Frequency Focus > Listening Time** memakai `listening_logs`, yaitu durasi audio yang benar-benar didengar.

## Kebutuhan

- Docker dan Docker Compose
- Git
- Koneksi internet
- Storage kosong untuk file lagu

## Cara Install

### 1. Clone project

```bash
git clone https://github.com/psr354/psr.fm.git
cd psr.fm
```

### 2. Buat file `.env`

```bash
cp .env.example .env
```

Lalu isi `SECRET_KEY` dengan nilai random yang panjang.

Contoh Linux/macOS:

```bash
printf "SECRET_KEY=%s\n" "$(openssl rand -hex 32)" > .env
```

Contoh manual:

```env
SECRET_KEY=ganti-dengan-random-string-yang-panjang
```

### 3. Jalankan aplikasi

```bash
docker compose up -d --build
```

Setelah selesai, buka:

```text
http://localhost:5000
```

Jika di server lain:

```text
http://IP_SERVER:5000
```

## Setup Pertama

Saat pertama kali dibuka, aplikasi akan masuk ke halaman setup.

1. Buat akun pertama.
2. Akun pertama otomatis menjadi admin.
3. Setelah itu halaman setup tidak akan muncul lagi.

Admin bisa menambahkan user lain dari menu **User Management**.

## Cara Pakai

### Download Lagu

1. Klik **Download Song**.
2. Paste link YouTube.
3. Pilih playlist tujuan.
4. Klik **Download**.

Jika lagu sudah ada di **Library Songs**, aplikasi akan memberi peringatan dan lagu bisa langsung ditambahkan tanpa download ulang.

Download hanya menerima URL YouTube dan video berdurasi maksimal 10 menit.

### Library Songs

Menu **Library Songs** menampilkan lagu yang sudah pernah didownload oleh semua user.

Dari sini user bisa:

- Cari lagu yang sudah ada.
- Melihat apakah lagu sudah ada di library pribadi.
- Klik **Add** untuk memasukkan lagu ke playlist tanpa paste link lagi.

### Playlist

- Buat playlist dari tombol plus di sidebar.
- Buka playlist untuk melihat lagu.
- Drag lagu untuk mengubah urutan.
- Upload cover playlist jika ingin.
- Delete playlist tidak menghapus file lagu.

### Search

Menu **Search** mencari lagu milik akun yang sedang login.

Dari hasil search, lagu bisa langsung ditambahkan ke playlist lain dengan tombol **Add**.

### Frequency Focus

Menu **Frequency Focus** menampilkan recap listening untuk:

- This Month
- Last Month
- This Year
- Last Year

Bagian **Most Played** dihitung dari jumlah lagu mulai diputar pada periode itu. Bagian **Most Listened** dihitung dari total detik yang didengar pada periode itu.

Untuk data lama sebelum tabel `play_events` tersedia, listening time lama tetap bisa muncul, tetapi play count per periode baru akurat setelah aplikasi berjalan dengan versi ini.

### Lyrics dan Share Card

- Klik tombol **Lyrics** di player untuk membuka panel lirik.
- Jika lirik tersedia, synced lyrics bisa ditap untuk seek ke bagian lagu.
- Klik **Edit** untuk menambahkan atau memperbaiki plain lyrics dan synced LRC lyrics secara manual.
- Klik **Share** di panel lirik untuk membuat card dari potongan lirik.
- Pilih teks lirik di modal untuk menentukan bagian yang masuk ke card.
- Pilih tema warna, lalu klik **Download** untuk menyimpan PNG atau **Copy** untuk menyalin gambar ke clipboard.

Share card otomatis memakai cover lagu jika tersedia dan menyesuaikan tinggi card dengan panjang lirik yang dipilih.

### Mobile

- Tombol menu membuka sidebar sebagai drawer.
- Tap playlist langsung menutup drawer dan membuka playlist.
- Player tetap berada di bawah layar; konten diberi jarak supaya tidak tertutup.
- User Management punya tombol **Back** untuk kembali ke dashboard.

## Data yang Disimpan

Folder penting:

| Folder | Isi |
| --- | --- |
| `database.db/` | Database SQLite |
| `downloads/` | File MP3 |
| `static/album_art/` | Cover lagu dan playlist |
| `logs/` | Log aplikasi |

Database menyimpan akun, playlist, metadata lagu, event play, listening logs, lyrics cache/manual lyrics, dan statistik recap.

Sebelum update atau pindah server, backup folder-folder di atas.

## Struktur Kode

| Path | Fungsi |
| --- | --- |
| `app.py` | Route Flask, auth, API playlist/song/user, dan bootstrap aplikasi |
| `services/database.py` | Schema SQLite, migration ringan, play events, listening logs, dan helper user/song |
| `services/downloader.py` | Worker download YouTube, metadata, album art, dan event progress |
| `services/lyrics.py` | Pencarian lyrics/synced lyrics via LRCLIB |
| `static/main.js` | UI browser: player, playlist, modal, dashboard, Frequency Focus, lyrics, dan user management |
| `static/style.css` | Design system visual dan responsive behavior |
| `templates/` | HTML halaman utama, login, setup, dan maintenance |

## Update Aplikasi

```bash
git pull
docker compose up -d --build
```

Database migration berjalan otomatis saat aplikasi start.

Tetap disarankan backup dulu:

```bash
cp -r database.db database.db.backup
cp -r downloads downloads.backup
cp -r static/album_art album_art.backup
```

Jika update dari versi lama, tabel `play_events` akan dibuat otomatis. Play count periode di Frequency Focus mulai akurat dari play yang terjadi setelah update tersebut.

## Backfill Lagu Lama

Jika server sudah punya lagu sebelum fitur Library Songs, lagu lama tetap akan muncul di Library Songs.

Namun duplicate warning dari link YouTube akan lebih akurat jika lagu lama punya `source_id`. Untuk mencoba mengisi data itu:

```bash
docker exec -it psr_fm_app python scripts/backfill_song_sources.py --dry-run
```

Jika hasilnya sudah cocok:

```bash
docker exec -it psr_fm_app python scripts/backfill_song_sources.py
```

Catatan: script ini butuh internet dan mencocokkan lagu lama dari judul/artis, jadi cek hasil `--dry-run` dulu.

## Perintah Berguna

```bash
# Start
docker compose up -d

# Stop
docker compose down

# Restart
docker compose restart

# Rebuild setelah update
docker compose up -d --build

# Lihat log
docker compose logs -f psr_fm
```

## Troubleshooting

### Tidak bisa login setelah restart

Pastikan `.env` ada dan `SECRET_KEY` tidak berubah.

### Permission denied saat download/upload

Di Linux server, jalankan:

```bash
sudo chown -R 1000:1000 database.db downloads static/album_art logs
docker compose restart
```

### User Management tidak muncul

Menu itu hanya muncul untuk admin.

### Lupa password admin

Jika masih ada admin lain, reset lewat **User Management**.

Jika tidak ada akses admin sama sekali, database perlu diedit manual atau direset.

### Build Docker gagal karena network

Coba ulang:

```bash
docker compose up -d --build
```

Jika masih gagal, restart Docker lalu coba lagi.

## Development Check

Untuk cek cepat:

```bash
python -m py_compile app.py services/database.py services/downloader.py services/lyrics.py services/metadata.py scripts/backfill_song_sources.py scripts/fetch_lyrics_batch.py
node --check static/main.js
```

Untuk menjalankan test:

```bash
docker compose exec -T psr_fm python -m unittest -q
```

## Catatan Keamanan

Konfigurasi bawaan di repo ini cocok untuk self-hosted/private use. Sebelum dibuka ke internet publik:

- Pakai HTTPS.
- Jalankan di balik reverse proxy seperti Nginx/Caddy.
- Gunakan `SECRET_KEY` yang kuat dan stabil.
- Batasi akses Socket.IO/CORS ke domain sendiri.
- Jangan mengandalkan Werkzeug development server sebagai server publik.
- Pisahkan compose development dan production jika aplikasi dipakai serius; image production sebaiknya tidak bind-mount source code aplikasi.
- Backup database dan folder lagu secara rutin.

## Tech Stack

- Python + Flask
- SQLite
- Flask-Login
- Flask-SocketIO
- yt-dlp
- FFmpeg
- Vanilla HTML/CSS/JavaScript
- Docker
