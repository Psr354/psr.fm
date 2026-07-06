# psr.fm

[![Python](https://img.shields.io/badge/Python-3.12-blue.svg)](https://www.python.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED.svg)](https://www.docker.com/)

A lightweight, self-hosted music streaming server inspired by Spotify.

psr.fm lets you download, organize, and stream YouTube audio from your own server with multi-user accounts, playlist management, synced lyrics, and basic security protections.

---

## Features

### Security and Authentication

- **Multi-user system**: each user has isolated playlists, songs, and listening stats.
- **Admin panel**: admins can list users, create users, reset passwords, change roles, and delete accounts.
- **Password hashing**: passwords are stored with PBKDF2-SHA256 hashes and salts.
- **CSRF protection**: state-changing API endpoints require CSRF tokens.
- **Ownership checks**: routes validate that playlists and songs belong to the current user.
- **Frontend escaping**: user-controlled text rendered by the main app is escaped.
- **Rate limiting**: repeated failed login attempts and manual lyrics refreshes are limited.

### YouTube Downloader

- Downloads audio with `yt-dlp`.
- Converts audio to MP3 192 kbps with FFmpeg.
- Extracts title, uploader, duration, and album art when available.
- Shows realtime download progress with WebSocket updates.
- Accepts YouTube URLs only.
- Rejects videos longer than 10 minutes.

### Playlists

- Many-to-many playlists: one song can appear in multiple playlists.
- Drag-and-drop song ordering inside each playlist.
- Saved custom order per playlist.
- Custom cover images per playlist.
- User-scoped playlist data.
- UUID-based audio filenames to avoid conflicts.

### Lyrics

- Fetches lyrics from LRCLIB when available.
- Supports plain lyrics and synced LRC lyrics.
- Synced lyrics auto-scroll while the song plays.
- Clicking a synced lyric line seeks the player to that timestamp.
- Includes a manual lyrics refresh action with rate limiting.

### Analytics

- Play count tracking.
- Listening time tracking.
- Top played songs.
- Top listened songs by duration.
- Storage usage monitoring.

### Music Player

- Queue management.
- Shuffle support.
- Repeat off, repeat all, and repeat one.
- A-B loop with jump-to-start.
- Next and previous controls.
- Volume and seek controls.
- Keyboard shortcuts.
- Responsive desktop and mobile layout.

---

## Tech Stack

| Component | Technology |
| --- | --- |
| Backend | Python 3.12 + Flask |
| Authentication | Flask-Login + Werkzeug |
| Security | Flask-WTF CSRF |
| Realtime | Flask-SocketIO |
| Database | SQLite |
| Downloader | yt-dlp |
| Media | FFmpeg + Mutagen + Pillow |
| Frontend | Vanilla HTML/CSS/JS |
| Deployment | Docker + Docker Compose |

---

## Preview

<p align="center">
  <img src="static/dashboard.jpeg" width="800" alt="Dashboard Preview">
</p>

---

## Installation

### Prerequisites

- Docker and Docker Compose
- Git
- Around 2 GB of free disk space
- Stable internet connection

### 1. Clone Repository

```bash
git clone https://github.com/psr354/psr.fm.git
cd psr.fm
```

### 2. Setup Environment

Create a stable secret key:

```bash
echo "SECRET_KEY=$(openssl rand -hex 32)" > .env
```

Do not skip this step. `SECRET_KEY` is required for stable login sessions and CSRF tokens.

### 3. Database Directory Note

Docker Compose automatically creates the runtime directories used by the app, including:

- `database.db`
- `downloads`
- `static/album_art`
- `logs`

`database.db` must be a directory. The SQLite file is stored at:

```text
database.db/psr_fm.sqlite3
```

Do not run `touch database.db`; that creates a file and breaks the expected database layout.

### 4. Run with Docker

```bash
docker compose up -d --build
```

Wait 1-2 minutes for the build to complete. The container creates missing runtime folders and runs database migrations automatically.

### 5. First-Time Setup

1. Open `http://localhost:5000` or `http://SERVER_IP:5000`.
2. You will be redirected to `/setup`.
3. Create the first admin account:
   - Username: minimum 3 characters
   - Password: minimum 6 characters
4. You will be logged in automatically.

The setup page appears only once. The first user becomes an administrator.

---

## Docker Commands

```bash
# Start
docker compose up -d

# Stop
docker compose down

# Rebuild after code changes
docker compose up -d --build

# View logs by Compose service name
docker compose logs -f psr_fm

# View logs by container name
docker logs -f psr_fm_app

# Restart
docker compose restart
```

---

## User Management

Admins can open **User Management** from the sidebar.

Admin actions:

- View all registered users and account statistics.
- Add regular users.
- Reset user passwords.
- Promote or demote users.
- Delete users and their data.

Safety rules:

- Admins cannot delete their own account.
- Admins cannot change their own role.
- Regular users cannot access admin APIs.

---

## Playlist Ordering

Inside a playlist, drag the handle on the left side of a song row to reorder songs.

The order is saved to SQLite, so it remains after refreshes, restarts, and future logins.

---

## Lyrics

Lyrics are fetched automatically after downloads when a match is available.

For synced LRC lyrics:

- The active lyric line follows playback.
- Clicking a lyric line seeks the song to that timestamp.
- The **Try Again** button manually refreshes lyrics for the current song.

Manual lyrics refreshes are rate limited.

---

## Runtime Data

The Docker setup mounts these host folders into the container:

| Host path | Container path | Purpose |
| --- | --- | --- |
| `./database.db` | `/app/database.db` | SQLite directory containing `psr_fm.sqlite3` |
| `./downloads` | `/app/downloads` | Downloaded audio files |
| `./static/album_art` | `/app/static/album_art` | Album art and playlist covers |
| `./logs` | `/app/logs` | Runtime logs |

The database path is set in `docker-compose.yml`:

```text
PSR_FM_DATABASE_PATH=/app/database.db/psr_fm.sqlite3
```

---

## Troubleshooting

### TLS handshake timeout during build

Cause: network issue when pulling `python:3.12-slim` from Docker Hub.

Try:

```bash
docker compose up -d --build
```

If it keeps failing, restart Docker and try again.

### Permission denied on download/upload

```bash
sudo chown -R 1000:1000 database.db downloads static/album_art logs
docker compose restart
```

### CSRF token error after restart

Make sure `.env` exists and contains a stable `SECRET_KEY`:

```bash
cat .env
```

If it is missing:

```bash
echo "SECRET_KEY=$(openssl rand -hex 32)" > .env
docker compose restart
```

### Forgot admin password

Reset the database. This deletes user, playlist, and song records. Downloaded MP3 files remain in `downloads`.

```bash
docker compose down
rm -rf database.db
docker compose up -d
```

Then open the app and create a new admin account.

### User Management menu not visible

Only admins can see User Management. To promote a user manually:

```bash
sqlite3 database.db/psr_fm.sqlite3
UPDATE users SET role = 'admin' WHERE username = 'your_username';
.quit
docker compose restart
```

### Too many login attempts

The login API allows 5 failed attempts per IP address and username within 5 minutes.

Wait for the retry window to pass, then try again.

---

## Project Structure

```text
psr.fm/
|-- app.py
|-- Dockerfile
|-- docker-compose.yml
|-- requirements.txt
|-- .env
|-- database.db/
|   `-- psr_fm.sqlite3
|-- services/
|   |-- __init__.py
|   |-- database.py
|   |-- downloader.py
|   |-- lyrics.py
|   `-- metadata.py
|-- scripts/
|   `-- fetch_lyrics_batch.py
|-- static/
|   |-- main.js
|   |-- style.css
|   `-- album_art/
|-- templates/
|   |-- index.html
|   |-- login.html
|   |-- maintenance.html
|   `-- setup.html
|-- downloads/
|   `-- library/
|-- logs/
`-- tests/
    `-- test_auth_download.py
```

Runtime directories and `.env` are ignored by Git.

---

## Development Checks

Run syntax checks:

```bash
python -m py_compile app.py services/database.py services/downloader.py services/lyrics.py services/metadata.py
node --check static/main.js
```

Run tests inside the Docker container:

```bash
docker exec psr_fm_app python -m unittest tests.test_auth_download -v
```

---

## Contributing

Pull requests are welcome. For major changes, open an issue first to discuss the proposal.

```bash
git checkout -b feature/your-feature
git add .
git commit -m "Add your feature"
git push origin feature/your-feature
```

---

## Acknowledgments

- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [Flask](https://flask.palletsprojects.com/)
- [FFmpeg](https://ffmpeg.org/)
- [Docker](https://www.docker.com/)
