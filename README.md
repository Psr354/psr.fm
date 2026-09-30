# psr.fm

Koleksi musik sendiri, diputar dari browser.

psr.fm adalah aplikasi musik yang kamu jalankan di komputer atau server sendiri. Tambahkan lagu dari YouTube atau file audio yang sudah kamu punya, susun playlist, lalu dengarkan lewat laptop atau HP. File musik tersimpan di servermu.

![Tampilan psr.fm](static/dashboard.png)

## Yang bisa kamu lakukan

- Download audio dari YouTube dan YouTube Music, atau tambahkan lagu lewat tautan track Spotify.
- Upload file MP3, WAV, FLAC, OGG, dan M4A.
- Buat playlist dengan cover sendiri dan atur urutan lagunya.
- Dengarkan dengan queue, shuffle, repeat, A–B loop, dan equalizer 16-band.
- Baca lirik yang mengikuti lagu, edit lirik, dan bagikan potongannya sebagai gambar.
- Simpan playlist di browser untuk didengarkan offline.
- Lihat lagu yang paling sering diputar dan waktu dengarmu lewat **Frequency Focus**.
- Buat beberapa akun, masing-masing dengan playlist dan riwayat dengar sendiri.

## Mulai menggunakan

Siapkan **Git**, **Docker**, dan **Docker Compose**. Di Windows atau macOS, kamu bisa memakai Docker Desktop. Pastikan Docker sudah berjalan dan ada ruang penyimpanan untuk koleksi musikmu.

### 1. Ambil aplikasinya

```bash
git clone https://github.com/psr354/psr.fm.git
cd psr.fm
```

### 2. Buat konfigurasi

Salin `.env.example` menjadi `.env`:

```bash
cp .env.example .env
```

Kamu juga bisa menyalinnya lewat file manager. Buka `.env`, lalu ganti nilai `SECRET_KEY` dengan string acak yang panjang. Untuk membuatnya lewat Docker:

```bash
docker run --rm python:3.12-slim python -c "import secrets; print(secrets.token_hex(32))"
```

Salin hasilnya ke `.env` setelah `SECRET_KEY=`. Simpan key ini; jangan menggantinya setiap kali aplikasi dijalankan ulang.

### 3. Jalankan

```bash
docker compose up -d --build
```

Proses pertama membutuhkan internet untuk mengunduh dependensi. Setelah selesai, buka [http://localhost:5000](http://localhost:5000).

Jika aplikasinya berjalan di komputer lain, gunakan alamat IP komputer tersebut, misalnya `http://192.168.1.10:5000`.

### 4. Buat akun pertama

Halaman setup akan muncul saat aplikasi pertama kali dibuka. Akun yang kamu buat di sini menjadi admin. Untuk menambahkan akun lain, buka **User Management** setelah login.

## Tambahkan lagu pertamamu

Buat playlist lewat tombol **+** di sidebar, lalu pilih salah satu cara berikut dari menu **Songs**:

| Menu | Cara menambahkan lagu |
| --- | --- |
| **Download Song** | Tempel tautan YouTube, YouTube Music, atau track Spotify, lalu pilih playlist tujuan. |
| **Upload Song** | Pilih file audio dari perangkatmu dan masukkan ke playlist. |
| **Library Songs** | Pilih lagu yang sudah tersedia di server dan klik **Add**, tanpa download ulang. |

Download dibatasi sampai **10 menit per lagu**. Upload menerima file sampai **50 MB**.

Tautan Spotify digunakan untuk mencari judul dan artis. Audionya dicari dari YouTube Music atau YouTube, sehingga versi yang ditemukan bisa berbeda dari track Spotify.

**Library Songs** menampilkan koleksi yang tersedia dari semua akun di server. Playlist dan riwayat dengar tetap terpisah per akun.

## Mendengarkan

Klik lagu untuk mulai memutar. Gunakan queue untuk mengatur lagu berikutnya, atau aktifkan shuffle dan repeat dari player. Di HP, tekan lama sebuah lagu untuk membuka pilihan seperti **Play next** dan **Add to queue**.

Tombol **Lyrics** membuka lirik jika tersedia. Kamu bisa mengetuk baris lirik yang tersinkron untuk pindah ke bagian lagu itu, memakai **Edit** untuk memperbaikinya, atau **Share** untuk membuat gambar dari potongan lirik.

### Offline

Buka playlist saat masih terhubung ke server, klik **Save Offline**, lalu tunggu sampai selesai. Playlist itu disimpan pada browser dan perangkat yang sedang kamu gunakan.

Untuk memakai fitur offline melalui alamat server, gunakan HTTPS. Akses lokal melalui `localhost` juga mendukungnya. Ketersediaannya bergantung pada dukungan dan ruang penyimpanan browser.

Riwayat pemutaran offline akan dikirim saat aplikasi dibuka kembali dan server bisa diakses. Menghapus data situs di browser juga menghapus playlist offline dan riwayat yang belum tersinkron.

### Riwayat dengar

Di dashboard dan **Frequency Focus**, **Most Played** menunjukkan berapa kali lagu mulai diputar, sedangkan **Most Listened** menunjukkan total waktu yang didengarkan. Kamu bisa melihat recap bulan ini, bulan lalu, tahun ini, atau tahun lalu.

Jika koneksi terputus, pencatatan yang sudah tersimpan di perangkat akan dicoba lagi tanpa dihitung dua kali. Jika sinkronisasi membutuhkan login ulang atau ada data yang ditolak, aplikasi akan menampilkan pemberitahuan.

## Mengelola server

### Update

Backup data terlebih dahulu, lalu jalankan dari folder proyek:

```bash
git pull
docker compose up -d --build
```

Perubahan database diterapkan otomatis saat aplikasi mulai berjalan. Jika tampilan di browser masih memakai versi lama, tutup aplikasi atau tab lalu buka kembali.

### Backup

Simpan salinan `.env` dan folder berikut. Hentikan aplikasi sementara saat menyalin agar backup database konsisten.

| Folder | Isi |
| --- | --- |
| `database.db/` | Akun, playlist, metadata, lirik, dan riwayat dengar |
| `downloads/` | File audio |
| `static/album_art/` | Cover lagu dan playlist |

Ketiganya disimpan di folder proyek melalui Docker volume, jadi tetap ada ketika container dijalankan ulang. `docker compose down` juga tidak menghapusnya.

### Perintah sehari-hari

```bash
# Hentikan aplikasi
docker compose down

# Jalankan kembali
docker compose up -d

# Restart
docker compose restart

# Lihat log
docker compose logs -f psr_fm
```

## Jika ada masalah

**Halaman tidak bisa dibuka** — Pastikan Docker berjalan, lalu periksa container dengan `docker compose ps`. Pastikan port 5000 belum dipakai aplikasi lain. Jika mengakses dari perangkat lain, periksa alamat IP dan firewall server.

**Download gagal** — Coba tautan lain dan lihat log aplikasi. Video yang dibatasi aksesnya atau tidak tersedia bisa gagal diunduh. Kamu tetap bisa menambahkan file audio lewat **Upload Song**.

**Tidak bisa login setelah restart** — Periksa apakah `.env` masih ada dan `SECRET_KEY` sama seperti sebelumnya.

**Menu User Management tidak muncul** — Menu ini hanya tersedia untuk akun admin.

**Lirik tidak tersedia** — Tidak semua lagu memiliki lirik yang bisa ditemukan otomatis. Gunakan **Edit** di panel Lyrics untuk menambahkannya sendiri.

## Akses dari internet

Konfigurasi Docker bawaan cocok untuk mencoba aplikasi di komputer atau jaringan sendiri. Jika ingin mengaksesnya dari internet, gunakan HTTPS melalui reverse proxy seperti Nginx atau Caddy, simpan `SECRET_KEY` dengan baik, dan lakukan backup rutin. Konfigurasi bawaan belum ditujukan sebagai deployment publik yang siap pakai.

---

Dibangun dengan Python, Flask, SQLite, JavaScript, yt-dlp, dan FFmpeg.
