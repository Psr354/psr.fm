import os
import queue
import re
import threading
import time
import mimetypes
from datetime import datetime, timezone, timedelta
from threading import Lock
from flask import g, current_app, request
from flask_login import UserMixin, current_user
from services.database import get_db_connection, get_user_theme

AUDIO_MIME_TYPES = {
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/opus',
    '.wav': 'audio/wav',
    '.webm': 'audio/webm',
    '.aac': 'audio/aac'
}

LYRICS_RATE_LIMIT_WINDOW_SECONDS = 60
LYRICS_RATE_LIMIT_MAX_REQUESTS = 10
_lyrics_rate_limit_lock = Lock()
_lyrics_rate_limit_state = {}

LOGIN_RATE_LIMIT_WINDOW_SECONDS = 300
LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5
_login_rate_limit_lock = Lock()
_login_rate_limit_state = {}

PASSWORD_CHANGE_RATE_LIMIT_WINDOW_SECONDS = 300
PASSWORD_CHANGE_RATE_LIMIT_MAX_ATTEMPTS = 5
_password_change_rate_limit_lock = Lock()
_password_change_rate_limit_state = {}

MAX_PASSWORD_LENGTH = 128

_file_cleanup_queue = queue.Queue()


def _file_cleanup_worker():
    """Background worker to asynchronously delete files."""
    while True:
        file_path = _file_cleanup_queue.get()
        try:
            if file_path and os.path.exists(file_path):
                os.remove(file_path)
        except Exception as e:
            print(f"[WARN] Failed to delete {file_path}: {e}")
        finally:
            _file_cleanup_queue.task_done()


_cleanup_thread = threading.Thread(target=_file_cleanup_worker, daemon=True)
_cleanup_thread.start()


def queue_file_deletion(file_path):
    """Queue a file for async deletion instead of blocking."""
    _file_cleanup_queue.put(file_path)


class User(UserMixin):
    def __init__(self, id, username, role='user', session_token=''):
        self.id = id
        self.username = username
        self.role = role
        self.session_token = session_token or ''

    def get_id(self):
        return f'{self.id}:{self.session_token}' if self.session_token else str(self.id)


def audio_mimetype(filename):
    ext = os.path.splitext(filename)[1].lower()
    return AUDIO_MIME_TYPES.get(ext) or mimetypes.guess_type(filename)[0] or 'application/octet-stream'


def get_json_object():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else None


def get_database_path():
    if current_app and current_app.config.get('DATABASE_PATH'):
        return current_app.config['DATABASE_PATH']
    return os.environ.get('PSR_FM_DATABASE_PATH', os.path.join(
        os.path.abspath(os.path.dirname(__file__)), '..', 'data', 'psr_fm.sqlite3'
    ))


def get_db():
    if 'db' not in g:
        g.db = get_db_connection(get_database_path())
    return g.db


def get_owned_playlist(db, playlist_id):
    return db.execute(
        'SELECT * FROM playlists WHERE id = ? AND user_id = ?',
        (playlist_id, current_user.id),
    ).fetchone()


def get_owned_song(db, song_id):
    return db.execute(
        'SELECT * FROM songs WHERE id = ? AND user_id = ?',
        (song_id, current_user.id),
    ).fetchone()


def get_global_song(db, song_id):
    return db.execute(
        'SELECT * FROM songs WHERE id = ?',
        (song_id,),
    ).fetchone()


def add_global_song_to_playlists(db, source_song, playlist_ids):
    existing_song = None
    if source_song['source_id']:
        existing_song = db.execute(
            'SELECT * FROM songs WHERE user_id = ? AND source_id = ? ORDER BY id ASC LIMIT 1',
            (current_user.id, source_song['source_id'])
        ).fetchone()
    if not existing_song:
        existing_song = db.execute(
            '''
            SELECT * FROM songs
            WHERE user_id = ? AND filename = ?
            ORDER BY id ASC LIMIT 1
            ''',
            (current_user.id, source_song['filename'])
        ).fetchone()

    if existing_song:
        song_id = existing_song['id']
        created = False
    else:
        copy_public_lyrics = (source_song['lyrics_status'] or 'none') == 'found'
        copied_lyrics = (source_song['lyrics'] or '') if copy_public_lyrics else ''
        copied_synced = (source_song['synced_lyrics'] or '') if copy_public_lyrics else ''
        copied_word_synced = (
            (source_song['word_synced_lyrics'] or '')
            if copy_public_lyrics and 'word_synced_lyrics' in source_song.keys()
            else ''
        )
        copied_status = 'found' if copy_public_lyrics else 'none'
        copied_updated_at = source_song['lyrics_updated_at'] if copy_public_lyrics else None
        cursor = db.execute(
            '''
            INSERT INTO songs (
                title, artist, filename, album_art, duration_seconds,
                source_url, source_id, lyrics, synced_lyrics, word_synced_lyrics,
                lyrics_status, lyrics_updated_at, user_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''',
            (
                source_song['title'],
                source_song['artist'],
                source_song['filename'],
                source_song['album_art'],
                source_song['duration_seconds'],
                source_song['source_url'],
                source_song['source_id'],
                copied_lyrics,
                copied_synced,
                copied_word_synced,
                copied_status,
                copied_updated_at,
                current_user.id,
            )
        )
        song_id = cursor.lastrowid
        created = True

    added_playlist_ids = []
    skipped_playlist_ids = []
    for playlist_id in playlist_ids:
        cursor = db.execute(
            'SELECT 1 FROM playlist_songs WHERE playlist_id = ? AND song_id = ?',
            (playlist_id, song_id)
        )
        if cursor.fetchone():
            skipped_playlist_ids.append(playlist_id)
            continue
        cursor = db.execute(
            'SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_songs WHERE playlist_id = ?',
            (playlist_id,)
        )
        next_position = cursor.fetchone()[0]
        db.execute(
            'INSERT INTO playlist_songs (playlist_id, song_id, position) VALUES (?, ?, ?)',
            (playlist_id, song_id, next_position)
        )
        added_playlist_ids.append(playlist_id)

    return song_id, created, added_playlist_ids, skipped_playlist_ids


def is_admin():
    """Check if current user is admin."""
    if not current_user.is_authenticated:
        return False
    if hasattr(current_user, 'role') and current_user.role is not None:
        return current_user.role == 'admin'
    conn = get_db_connection(get_database_path())
    cursor = conn.cursor()
    cursor.execute('SELECT role FROM users WHERE id = ?', (current_user.id,))
    user = cursor.fetchone()
    conn.close()
    return user and user['role'] == 'admin'


def check_lyrics_rate_limit(user_id):
    now = time.monotonic()
    with _lyrics_rate_limit_lock:
        timestamps = _lyrics_rate_limit_state.get(user_id, [])
        timestamps = [ts for ts in timestamps if now - ts < LYRICS_RATE_LIMIT_WINDOW_SECONDS]
        if len(timestamps) >= LYRICS_RATE_LIMIT_MAX_REQUESTS:
            _lyrics_rate_limit_state[user_id] = timestamps
            return False, int(LYRICS_RATE_LIMIT_WINDOW_SECONDS - (now - timestamps[0]))
        timestamps.append(now)
        _lyrics_rate_limit_state[user_id] = timestamps
        return True, None


LOGIN_IP_RATE_LIMIT_MAX_ATTEMPTS = 25


def _client_ip():
    return (request.remote_addr or 'unknown').strip().lower()


def _login_rate_limit_key(username):
    return f"{_client_ip()}:{username.strip().lower()}"


def _login_ip_rate_limit_key():
    return f"ip:{_client_ip()}"


def _prune_expired_login_limits(now):
    expired_keys = [
        k for k, v in _login_rate_limit_state.items()
        if all(now - ts >= LOGIN_RATE_LIMIT_WINDOW_SECONDS for ts in v)
    ]
    for k in expired_keys:
        _login_rate_limit_state.pop(k, None)


def check_login_rate_limit(username):
    now = time.monotonic()
    key = _login_rate_limit_key(username)
    ip_key = _login_ip_rate_limit_key()
    with _login_rate_limit_lock:
        for bucket_key, limit in ((key, LOGIN_RATE_LIMIT_MAX_ATTEMPTS), (ip_key, LOGIN_IP_RATE_LIMIT_MAX_ATTEMPTS)):
            timestamps = [ts for ts in _login_rate_limit_state.get(bucket_key, []) if now - ts < LOGIN_RATE_LIMIT_WINDOW_SECONDS]
            if len(timestamps) >= limit:
                _login_rate_limit_state[bucket_key] = timestamps
                return False, int(LOGIN_RATE_LIMIT_WINDOW_SECONDS - (now - timestamps[0]))
        return True, None


def record_failed_login(username):
    now = time.monotonic()
    key = _login_rate_limit_key(username)
    ip_key = _login_ip_rate_limit_key()
    with _login_rate_limit_lock:
        _prune_expired_login_limits(now)
        for bucket_key in (key, ip_key):
            timestamps = [ts for ts in _login_rate_limit_state.get(bucket_key, []) if now - ts < LOGIN_RATE_LIMIT_WINDOW_SECONDS]
            timestamps.append(now)
            _login_rate_limit_state[bucket_key] = timestamps


def clear_login_rate_limit(username):
    key = _login_rate_limit_key(username)
    with _login_rate_limit_lock:
        _login_rate_limit_state.pop(key, None)
        _prune_expired_login_limits(time.monotonic())


def check_password_change_rate_limit(user_id):
    now = time.monotonic()
    key = f"pw:{user_id}"
    with _password_change_rate_limit_lock:
        timestamps = [
            ts for ts in _password_change_rate_limit_state.get(key, [])
            if now - ts < PASSWORD_CHANGE_RATE_LIMIT_WINDOW_SECONDS
        ]
        if len(timestamps) >= PASSWORD_CHANGE_RATE_LIMIT_MAX_ATTEMPTS:
            _password_change_rate_limit_state[key] = timestamps
            return False, int(PASSWORD_CHANGE_RATE_LIMIT_WINDOW_SECONDS - (now - timestamps[0]))
        return True, None


def record_failed_password_change(user_id):
    now = time.monotonic()
    key = f"pw:{user_id}"
    with _password_change_rate_limit_lock:
        timestamps = [
            ts for ts in _password_change_rate_limit_state.get(key, [])
            if now - ts < PASSWORD_CHANGE_RATE_LIMIT_WINDOW_SECONDS
        ]
        timestamps.append(now)
        _password_change_rate_limit_state[key] = timestamps


def clear_password_change_rate_limit(user_id):
    key = f"pw:{user_id}"
    with _password_change_rate_limit_lock:
        _password_change_rate_limit_state.pop(key, None)


def reset_rate_limits():
    with _login_rate_limit_lock:
        _login_rate_limit_state.clear()
    with _lyrics_rate_limit_lock:
        _lyrics_rate_limit_state.clear()
    with _password_change_rate_limit_lock:
        _password_change_rate_limit_state.clear()



def playback_timestamp(value):
    """Normalize queued client timestamps to SQLite UTC, rejecting future dates."""
    if value is None:
        return datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Timezone required')
    parsed = parsed.astimezone(timezone.utc)
    if parsed > datetime.now(timezone.utc) + timedelta(seconds=10):
        raise ValueError('Future timestamp')
    return parsed.strftime('%Y-%m-%d %H:%M:%S')


def valid_playback_id(value):
    return isinstance(value, str) and 1 <= len(value) <= 128 and all(
        c.isascii() and (c.isalnum() or c in '-_') for c in value
    )


HEX_COLOR_RE = re.compile(r'^#[0-9a-fA-F]{6}$')
THEME_BG_MAIN_COLORS = {
    'dark': '#070908',
    'amoled': '#000000',
    'midnight': '#0b0f19',
    'charcoal': '#131518',
    'warm': '#140f0c',
    'forest': '#09120c',
}


def is_valid_hex_color(value):
    return isinstance(value, str) and bool(HEX_COLOR_RE.match(value.strip()))


def _safe_hex_color(value, default):
    if is_valid_hex_color(value):
        return value.strip()
    return default


def get_user_status_bar_color(user_id):
    theme_data = get_user_theme(get_database_path(), user_id)
    if not isinstance(theme_data, dict) or not theme_data:
        return '#070908'
    accent = _safe_hex_color(theme_data.get('accent'), '#30d66b')
    mode = theme_data.get('statusBarMode', 'accent')
    if mode == 'accent':
        return accent
    if mode == 'background':
        bg = theme_data.get('bg', 'dark')
        if bg == 'custom':
            return _safe_hex_color(theme_data.get('bgCustom'), '#070908')
        return THEME_BG_MAIN_COLORS.get(bg, '#070908')
    if mode == 'black':
        return '#000000'
    if mode == 'custom':
        return _safe_hex_color(theme_data.get('statusBarCustom'), accent)
    if mode == 'match':
        return _safe_hex_color(theme_data.get('card') or theme_data.get('cardCustom'), '#161d19')
    return accent
