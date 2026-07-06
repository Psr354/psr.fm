
# 🎵 psr.fm

[![Python](https://img.shields.io/badge/Python-3.12-blue.svg)](https://www.python.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED.svg)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Security](https://img.shields.io/badge/Security-Hardened-orange.svg)]()

> A lightweight, self-hosted music streaming server inspired by Spotify.  
> Download, organize, and stream YouTube audio directly to your personal cloud with multi-user support and enterprise-grade security.

---

## ✨ Features

### 🔐 Security & Authentication
- **Multi-User System** — Isolated data per user with role-based access control
- **Admin Panel** — Complete user management (list, delete, reset password, change role)
- **Secure Authentication** — PBKDF2-SHA256 password hashing with salt
- **CSRF Protection** — All state-changing endpoints protected
- **IDOR Prevention** — Ownership validation on all resources
- **XSS Prevention** — Input sanitization with `escapeHtml()`
- **Rate Limiting** — Protection against brute force and abuse

### 🎧 YouTube Downloader
- Download audio using `yt-dlp` (pinned version for stability)
- Convert to MP3 192kbps with FFmpeg
- Auto-extract metadata (title, artist, album art)
- Real-time progress bar via WebSocket
- URL validation (YouTube only, max 10 minutes)

### 📂 Smart Playlist
- **Many-to-Many architecture** — One song in multiple playlists, no duplication
- Custom cover images per playlist
- User-scoped playlists (data isolation)
- UUID-based file naming (prevents conflicts)

### 📊 Analytics (Per User)
- Play count tracking
- Listen time statistics
- Top played songs
- Top listened songs (by duration)
- Storage usage monitoring

### ⚡ Real-Time Features
- Live download progress bar
- WebSocket-powered notifications
- Real-time song addition alerts

### 🎵 Music Player

**Playback Controls:**
- Queue management with shuffle support
- **A-B Loop** — Loop specific sections with jump-to-start
- Repeat modes (Off / Repeat All / Repeat One)
- Next / Previous with smart logic
- Volume control with visual feedback
- Progress bar with seek functionality

**Advanced Features:**
- **Synced Lyrics** — LRC format with auto-scroll (when available)
- **Keyboard Shortcuts** — Full keyboard navigation
- **Responsive Design** — Works on desktop and mobile

### ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `←` / `→` | Previous / Next |
| `L` | Jump to loop start |
| `Esc` | Close popover/modal/exit admin panel |

---

## 🛠️ Tech Stack

| Component | Technology |
|-----------|------------|
| Backend | Python 3.12 + Flask 3.0.3 |
| Authentication | Flask-Login + Werkzeug |
| Security | Flask-WTF (CSRF) |
| Realtime | Flask-SocketIO |
| Database | SQLite (WAL mode) |
| Downloader | yt-dlp (pinned: 2026.6.9) |
| Media | FFmpeg + Mutagen + Pillow |
| Frontend | Vanilla HTML/CSS/JS |
| Deployment | Docker + Docker Compose |

---

## 📸 Preview

<p align="center">
  <img src="static/dashboard.jpeg" width="800" alt="Dashboard Preview">
</p>

---

## 🚀 Installation

### Prerequisites
- [Docker](https://docs.docker.com/get-docker/) & [Docker Compose](https://docs.docker.com/compose/install/)
- [Git](https://git-scm.com/)
- ~2GB free disk space
- Stable internet connection

### 1. Clone Repository

```bash
git clone https://github.com/psr354/psr.fm.git
cd psr.fm
```

### 2. Setup Environment

```bash
echo "SECRET_KEY=$(openssl rand -hex 32)" > .env
```

> ⚠️ **IMPORTANT:** Don't skip this step. `SECRET_KEY` is required for session security.

### 3. Create Database File

```bash
touch database.db
```

> 📝 **Note:** The `downloads/`, `static/album_art/`, and `logs/` folders will be **created automatically** by the application on first run.

### 4. Run with Docker

```bash
docker compose up -d --build
```

Wait 1-2 minutes for the build to complete. The container will automatically create the required folders and run database migrations.

### 5. First-Time Setup

1. Open browser: `http://localhost:5000` (or `http://SERVER_IP:5000`)
2. You'll be redirected to the **Setup Wizard** (`/setup`)
3. Create your first admin account:
   - Username (min. 3 characters)
   - Password (min. 6 characters)
4. You'll be logged in automatically

> ⚠️ **IMPORTANT:** Setup page only appears **once**. The first user automatically becomes an administrator. If you forget your password, see [Troubleshooting](#-troubleshooting).

---

## 👥 User Management (Admin Only)

The first user created during setup automatically becomes an **administrator** with full access to the User Management panel.

### Admin Privileges
- ✅ View all registered users with statistics
- ✅ Add new users
- ✅ Reset user passwords
- ✅ Change user roles (promote/demote)
- ✅ Delete users and all their data

### Accessing User Management
1. Login as admin
2. Click **"User Management"** in the sidebar (green accent)
3. View user stats, search, filter, and manage accounts

### Features
- **Stats Dashboard** — Total users, admins, regular users, total songs
- **Search & Filter** — Find users by username, filter by role
- **Modern UI** — Gradient avatars, role badges, action tooltips
- **Safety Features** — Cannot delete/modify own account, confirmation modals

---

## 🐳 Docker Commands

```bash
# Start
docker compose up -d

# Stop
docker compose down

# Rebuild (after code changes)
docker compose up -d --build

# View logs
docker compose logs -f psr_fm_app

# Restart
docker compose restart
```

---

## 🔧 Troubleshooting

### ❌ `TLS handshake timeout` during build

**Cause:** Network issue when pulling `python:3.12-slim` from Docker Hub.

**Solutions:**

1. **Check internet connection** — make sure it's stable
2. **Restart Docker daemon:**
   ```bash
   sudo systemctl restart docker
   ```
3. **Try again** — sometimes it's just a temporary issue:
   ```bash
   docker compose up -d --build
   ```
4. **Use Docker mirror** (if in Indonesia/China):
   ```bash
   # Edit /etc/docker/daemon.json
   {
     "registry-mirrors": ["https://mirror.gcr.io"]
   }
   sudo systemctl restart docker
   ```

### ❌ Permission denied on download/upload

```bash
sudo chown -R 1000:1000 downloads static/album_art logs database.db
docker compose restart
```

### ❌ CSRF token error after restart

Make sure `.env` exists and contains `SECRET_KEY`:
```bash
cat .env
# If empty, regenerate:
echo "SECRET_KEY=$(openssl rand -hex 32)" > .env
docker compose restart
```

### ❌ Forgot admin password

Reset database (⚠️ all user data will be lost, but MP3 files remain safe):
```bash
docker compose down
rm database.db
touch database.db
docker compose up -d
# Open web and create new admin account
```

### ❌ User Management menu not visible

Only administrators can see the User Management menu. To promote a user to admin:
```bash
# Access database
sqlite3 database.db

# Promote user to admin
UPDATE users SET role = 'admin' WHERE username = 'your_username';

# Exit
.quit

# Restart container
docker compose restart
```

---

## 📁 Project Structure

```
psr.fm/
├── app.py                 # Flask routes & API
├── Dockerfile
├── docker-compose.yml
├── requirements.txt
├── database.db            # SQLite (auto-created)
├── .env                   # Environment variables
│
├── services/
│   ├── database.py        # Schema & migrations
│   ├── downloader.py      # yt-dlp worker
│   └── metadata.py        # Audio metadata
│
├── static/
│   ├── main.js            # Frontend logic
│   ├── style.css          # Styling
│   └── album_art/         # Auto-created
│
├── templates/
│   ├── index.html         # Main app
│   ├── login.html         # Login page
│   └── setup.html         # Setup wizard
│
├── downloads/             # Auto-created
│   └── library/           # MP3 files (UUID-named)
│
└── logs/                  # Auto-created
```

---

## 🤝 Contributing

Pull requests are welcome! For major changes, please open an issue first to discuss what you would like to change.

```bash
# Create feature branch
git checkout -b feature/your-feature

# Make changes
git add .
git commit -m "Add your feature"

# Push and create PR
git push origin feature/your-feature
```

---

## 📜 License

MIT License - see [LICENSE](LICENSE) file for details

---

## 👤 Author

**psr354**  

- GitHub: [@psr354](https://github.com/psr354)
- Project: [psr.fm](https://github.com/psr354/psr.fm)

---

## 🙏 Acknowledgments

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — YouTube downloader
- [Flask](https://flask.palletsprojects.com/) — Web framework
- [FFmpeg](https://ffmpeg.org/) — Audio processing
- [Docker](https://www.docker.com/) — Containerization

---

<p align="center">Made with ❤️ and 🎵 by psr354</p>
