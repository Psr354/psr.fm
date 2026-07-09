import os
import sqlite3
import shutil
import uuid
from flask import Flask, request, jsonify, send_from_directory, render_template, g, redirect, url_for
from flask_login import LoginManager, UserMixin, login_user, login_required, logout_user, current_user
from werkzeug.utils import secure_filename
from werkzeug.security import check_password_hash
from flask_socketio import SocketIO
from PIL import Image
import io
import time
from threading import Lock
from dotenv import load_dotenv
from urllib.parse import parse_qs, urlparse

from services.database import (
    init_db, get_db_connection,
    get_user_by_username, create_user, has_any_user,
    get_all_users, get_user_files, delete_user_cascade, update_user_password
)

from services.downloader import download_queue, start_worker, validate_youtube_url
from services.lyrics import search_lyrics, parse_lrc

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
load_dotenv(os.path.join(BASE_DIR, '.env'))

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', os.urandom(32).hex())

MAINTENANCE_MODE = False

@app.before_request
def maintenance_check():
    if MAINTENANCE_MODE:
        return render_template('maintenance.html'), 503

from flask_wtf.csrf import CSRFProtect, generate_csrf, validate_csrf

# Initialize CSRF token helpers. Actual API checks are handled in
# csrf_protect_api() so login/setup can stay unauthenticated.
app.config['WTF_CSRF_CHECK_DEFAULT'] = False
csrf = CSRFProtect(app)

# Generate CSRF token dan set di cookie
@app.after_request
def set_csrf_cookie(response):
    token = generate_csrf()
    response.set_cookie('csrf_token', token, httponly=False, samesite='Lax')
    return response

# Validasi CSRF untuk API endpoints (kecuali login/setup)
@app.before_request
def csrf_protect_api():
    if request.method in ['POST', 'PUT', 'DELETE']:
        if request.path.startswith('/api/'):
            # Skip untuk login/setup (belum ada session)
            if request.path in ['/api/login', '/api/setup']:
                return
            
            # Ambil token dari header atau cookie
            token = request.headers.get('X-CSRF-Token') or request.cookies.get('csrf_token')
            
            if not token:
                return jsonify({'error': 'CSRF token missing'}), 403
            
            try:
                validate_csrf(token)
            except Exception as e:
                return jsonify({'error': 'Invalid CSRF token'}), 403

login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login_page'
login_manager.login_message = None

socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

DOWNLOAD_DIR = os.environ.get('PSR_FM_DOWNLOAD_DIR', os.path.join(BASE_DIR, 'downloads'))
LIBRARY_DIR = os.path.join(DOWNLOAD_DIR, 'library')
ALBUM_ART_DIR = os.environ.get('PSR_FM_ALBUM_ART_DIR', os.path.join(BASE_DIR, 'static', 'album_art'))
DATABASE_PATH = os.environ.get('PSR_FM_DATABASE_PATH', os.path.join(BASE_DIR, 'database.db', 'psr_fm.sqlite3'))
DATABASE_DIR = os.path.dirname(DATABASE_PATH) or os.path.join(BASE_DIR, 'database.db')
ADMIN_USERNAMES = ['psr354']
LYRICS_RATE_LIMIT_WINDOW_SECONDS = 60
LYRICS_RATE_LIMIT_MAX_REQUESTS = 10
_lyrics_rate_limit_lock = Lock()
_lyrics_rate_limit_state = {}
LOGIN_RATE_LIMIT_WINDOW_SECONDS = 300
LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5
_login_rate_limit_lock = Lock()
_login_rate_limit_state = {}

os.makedirs(DOWNLOAD_DIR, exist_ok=True)
os.makedirs(LIBRARY_DIR, exist_ok=True)
os.makedirs(ALBUM_ART_DIR, exist_ok=True)
os.makedirs(DATABASE_DIR, exist_ok=True)
os.makedirs(os.path.join(BASE_DIR, 'logs'), exist_ok=True)

init_db(DATABASE_PATH)
if os.environ.get('PSR_FM_DISABLE_WORKER') != '1':
    start_worker(DATABASE_PATH, DOWNLOAD_DIR, ALBUM_ART_DIR, socketio)

class User(UserMixin):
    def __init__(self, id, username):
        self.id = id
        self.username = username

@login_manager.user_loader
def load_user(user_id):
    conn = get_db_connection(DATABASE_PATH)
    cursor = conn.cursor()
    cursor.execute('SELECT id, username FROM users WHERE id = ?', (user_id,))
    row = cursor.fetchone()
    conn.close()
    if row:
        return User(id=row['id'], username=row['username'])
    return None

@login_manager.unauthorized_handler
def unauthorized():
    if request.path.startswith('/api/'):
        return jsonify({'error': 'Unauthorized'}), 401
    return redirect(url_for('login_page'))

def get_db():
    if 'db' not in g:
        g.db = get_db_connection(DATABASE_PATH)
    return g.db

def get_owned_playlist(db, playlist_id):
    return db.execute(
        'SELECT * FROM playlists WHERE id = ? AND user_id = ?',
        (playlist_id, current_user.id)
    ).fetchone()

def get_owned_song(db, song_id):
    return db.execute(
        'SELECT * FROM songs WHERE id = ? AND user_id = ?',
        (song_id, current_user.id)
    ).fetchone()


def extract_youtube_video_id(url):
    parsed = urlparse((url or '').strip())
    host = parsed.netloc.lower()
    if host.startswith('www.'):
        host = host[4:]

    if host == 'youtu.be':
        video_id = parsed.path.strip('/').split('/')[0]
        return video_id or ''

    if host in {'youtube.com', 'm.youtube.com'}:
        if parsed.path == '/watch':
            return parse_qs(parsed.query).get('v', [''])[0]
        path_parts = [part for part in parsed.path.split('/') if part]
        if len(path_parts) >= 2 and path_parts[0] in {'shorts', 'embed', 'live'}:
            return path_parts[1]

    return ''


def get_global_song(db, song_id):
    return db.execute('SELECT * FROM songs WHERE id = ?', (song_id,)).fetchone()


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
        cursor = db.execute(
            '''
            INSERT INTO songs (
                title, artist, filename, album_art, duration_seconds,
                source_url, source_id, lyrics, synced_lyrics, lyrics_status, lyrics_updated_at, user_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''',
            (
                source_song['title'],
                source_song['artist'],
                source_song['filename'],
                source_song['album_art'],
                source_song['duration_seconds'],
                source_song['source_url'],
                source_song['source_id'],
                source_song['lyrics'],
                source_song['synced_lyrics'],
                source_song['lyrics_status'] or 'none',
                source_song['lyrics_updated_at'],
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


def _login_rate_limit_key(username):
    remote_addr = request.headers.get('X-Forwarded-For', request.remote_addr or 'unknown')
    client_ip = remote_addr.split(',')[0].strip().lower()
    return f"{client_ip}:{username.strip().lower()}"


def check_login_rate_limit(username):
    now = time.monotonic()
    key = _login_rate_limit_key(username)
    with _login_rate_limit_lock:
        timestamps = _login_rate_limit_state.get(key, [])
        timestamps = [ts for ts in timestamps if now - ts < LOGIN_RATE_LIMIT_WINDOW_SECONDS]
        if len(timestamps) >= LOGIN_RATE_LIMIT_MAX_ATTEMPTS:
            _login_rate_limit_state[key] = timestamps
            return False, int(LOGIN_RATE_LIMIT_WINDOW_SECONDS - (now - timestamps[0]))
        return True, None


def record_failed_login(username):
    now = time.monotonic()
    key = _login_rate_limit_key(username)
    with _login_rate_limit_lock:
        timestamps = _login_rate_limit_state.get(key, [])
        timestamps = [ts for ts in timestamps if now - ts < LOGIN_RATE_LIMIT_WINDOW_SECONDS]
        timestamps.append(now)
        _login_rate_limit_state[key] = timestamps


def clear_login_rate_limit(username):
    key = _login_rate_limit_key(username)
    with _login_rate_limit_lock:
        _login_rate_limit_state.pop(key, None)

@app.teardown_appcontext
def close_connection(exception):
    db = g.pop('db', None)
    if db is not None:
        db.close()

# ==========================================
# AUTHENTICATION ROUTES
# ==========================================
@app.route('/login')
def login_page():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    return render_template('login.html')

@app.route('/setup')
def setup_page():
    if has_any_user(DATABASE_PATH):
        return redirect(url_for('login_page'))
    return render_template('setup.html')

@app.route('/api/setup', methods=['POST'])
def setup_account():
    if has_any_user(DATABASE_PATH):
        return jsonify({'error': 'Account already exists'}), 403
    data = request.get_json()
    username = data.get('username', '').strip()
    password = data.get('password', '')
    if not username or not password:
        return jsonify({'error': 'Username and password required'}), 400
    if len(password) < 6:
        return jsonify({'error': 'Password must be at least 6 characters'}), 400
    if len(username) < 3:
        return jsonify({'error': 'Username must be at least 3 characters'}), 400
    
    user_id = create_user(DATABASE_PATH, username, password, role='admin')
    if not user_id:
        return jsonify({'error': 'Username already taken'}), 400
    
    user = User(id=user_id, username=username)
    login_user(user, remember=True)
    return jsonify({'status': 'success', 'message': 'Account created successfully'})

@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json()
    username = data.get('username', '').strip()
    password = data.get('password', '')
    if not username or not password:
        return jsonify({'error': 'Username and password required'}), 400

    allowed, retry_after = check_login_rate_limit(username)
    if not allowed:
        return jsonify({
            'error': 'Too many login attempts. Please try again later.',
            'retry_after': retry_after,
        }), 429
    
    user_row = get_user_by_username(DATABASE_PATH, username)
    if not user_row or not check_password_hash(user_row['password_hash'], password):
        record_failed_login(username)
        return jsonify({'error': 'Invalid username or password'}), 401
    
    clear_login_rate_limit(username)
    user = User(id=user_row['id'], username=user_row['username'])
    login_user(user, remember=True)
    return jsonify({'status': 'success', 'username': user.username})

@app.route('/api/logout', methods=['POST'])
@login_required
def logout():
    logout_user()
    return jsonify({'status': 'success'})

@app.route('/api/me')
@login_required
def me():
    return jsonify({
        'username': current_user.username,
        'id': current_user.id,
        'can_add_users': is_admin()
    })

@app.route('/api/users', methods=['POST'])
@login_required
def create_new_user():
    """Create a new user (admin only)"""
    # Cek apakah current user adalah admin
    if not is_admin():
        return jsonify({'error': 'Only administrators can create new users'}), 403

    data = request.get_json()
    username = data.get('username', '').strip()
    password = data.get('password', '')
    
    # Validasi input
    if not username or not password:
        return jsonify({'error': 'Username and password required'}), 400
    if len(password) < 6:
        return jsonify({'error': 'Password must be at least 6 characters'}), 400
    if len(username) < 3:
        return jsonify({'error': 'Username must be at least 3 characters'}), 400

    # Create user dengan role default 'user'
    user_id = create_user(DATABASE_PATH, username, password, role='user')
    if not user_id:
        return jsonify({'error': 'Username already taken'}), 400

    return jsonify({
        'status': 'success', 
        'message': f'User {username} created successfully',
        'user_id': user_id
    }), 201

# ==========================================
# MAIN & PROTECTED ROUTES
# ==========================================
@app.route('/')
@login_required
def index():
    return render_template('index.html')

@app.route('/api/playlists', methods=['POST'])
@login_required
def create_playlist():
    data = request.get_json()
    name = data.get('name')
    if not name:
        return jsonify({'error': 'Name is required'}), 400
    folder_name = secure_filename(name) or str(uuid.uuid4())
    db = get_db()
    cursor = db.cursor()
    cursor.execute('INSERT INTO playlists (name, folder_name, user_id) VALUES (?, ?, ?)', (name, folder_name, current_user.id))
    db.commit()
    return jsonify({'status': 'success', 'id': cursor.lastrowid, 'folder_name': folder_name})

@app.route('/api/playlists', methods=['GET'])
@login_required
def get_playlists():
    db = get_db()
    cursor = db.cursor()
    cursor.execute('SELECT * FROM playlists WHERE user_id = ? ORDER BY created_at DESC', (current_user.id,))
    return jsonify([dict(row) for row in cursor.fetchall()])

@app.route('/api/playlists/<int:playlist_id>', methods=['PUT'])
@login_required
def rename_playlist(playlist_id):
    data = request.get_json()
    name = data.get('name')
    if not name:
        return jsonify({'error': 'Name required'}), 400
    db = get_db()
    cursor = db.execute('UPDATE playlists SET name = ? WHERE id = ? AND user_id = ?', (name, playlist_id, current_user.id))
    db.commit()
    if cursor.rowcount == 0:
        return jsonify({'error': 'Playlist not found'}), 404
    return jsonify({'status': 'success'})

@app.route('/api/playlists/<int:playlist_id>/cover', methods=['POST'])
@login_required
def upload_cover(playlist_id):
    db = get_db()
    if not get_owned_playlist(db, playlist_id):
        return jsonify({'error': 'Playlist not found'}), 404

    if 'cover' not in request.files:
        return jsonify({'error': 'No file'}), 400
    file = request.files['cover']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400

    try:
        file_bytes = file.read()
        file.seek(0)
        img = Image.open(io.BytesIO(file_bytes))
        img.verify()
        img = Image.open(io.BytesIO(file_bytes))
        allowed_formats = ['JPEG', 'PNG', 'WEBP']
        if img.format not in allowed_formats:
            return jsonify({'error': f'Invalid image format: {img.format}'}), 400
        ext_map = {'JPEG': '.jpg', 'PNG': '.png', 'WEBP': '.webp'}
        ext = ext_map[img.format]
    except Exception:
        return jsonify({'error': 'Invalid or corrupted image file'}), 400

    filename = f"pl_cover_{playlist_id}{ext}"
    save_path = os.path.join(ALBUM_ART_DIR, filename)
    cursor = db.cursor()
    cursor.execute('SELECT cover_art FROM playlists WHERE id = ? AND user_id = ?', (playlist_id, current_user.id))
    old = cursor.fetchone()
    if old and old['cover_art']:
        old_path = os.path.join(ALBUM_ART_DIR, old['cover_art'])
        if os.path.exists(old_path):
            os.remove(old_path)

    file.seek(0)
    file.save(save_path)
    db.execute('UPDATE playlists SET cover_art = ? WHERE id = ? AND user_id = ?', (filename, playlist_id, current_user.id))
    db.commit()
    return jsonify({'status': 'success', 'cover_art': filename})

@app.route('/api/playlists/<int:playlist_id>', methods=['DELETE'])
@login_required
def delete_playlist(playlist_id):
    db = get_db()
    if not get_owned_playlist(db, playlist_id):
        return jsonify({'error': 'Playlist not found'}), 404

    db.execute('DELETE FROM playlist_songs WHERE playlist_id = ?', (playlist_id,))
    db.execute('DELETE FROM playlists WHERE id = ? AND user_id = ?', (playlist_id, current_user.id))
    db.commit()
    return jsonify({'status': 'success'})


@app.route('/api/playlists/<int:playlist_id>/songs/order', methods=['PUT'])
@login_required
def reorder_playlist_songs(playlist_id):
    db = get_db()
    if not get_owned_playlist(db, playlist_id):
        return jsonify({'error': 'Playlist not found'}), 404

    data = request.get_json()
    song_ids = data.get('song_ids', [])
    if not isinstance(song_ids, list):
        return jsonify({'error': 'song_ids must be a list'}), 400

    try:
        ordered_song_ids = [int(song_id) for song_id in song_ids]
    except (TypeError, ValueError):
        return jsonify({'error': 'Invalid song order'}), 400

    if len(ordered_song_ids) != len(set(ordered_song_ids)):
        return jsonify({'error': 'Duplicate song ids are not allowed'}), 400

    cursor = db.execute(
        '''
        SELECT ps.song_id
        FROM playlist_songs ps
        JOIN songs s ON s.id = ps.song_id
        WHERE ps.playlist_id = ? AND s.user_id = ?
        ''',
        (playlist_id, current_user.id)
    )
    existing_song_ids = {row['song_id'] for row in cursor.fetchall()}
    if set(ordered_song_ids) != existing_song_ids:
        return jsonify({'error': 'Song order must include every song in the playlist'}), 400

    for position, song_id in enumerate(ordered_song_ids):
        db.execute(
            'UPDATE playlist_songs SET position = ? WHERE playlist_id = ? AND song_id = ?',
            (position, playlist_id, song_id)
        )
    db.commit()
    return jsonify({'status': 'success'})

@app.route('/api/download', methods=['POST'])
@login_required
def download_song():
    data = request.get_json()
    url = data.get('url')
    playlist_ids = data.get('playlist_ids', [])
    if not url or not playlist_ids:
        return jsonify({'error': 'Missing data'}), 400
    is_valid, validation_error = validate_youtube_url(url)
    if not is_valid:
        return jsonify({'error': validation_error}), 400
    try:
        playlist_ids = sorted({int(pid) for pid in playlist_ids})
    except (TypeError, ValueError):
        return jsonify({'error': 'Invalid playlist data'}), 400

    db = get_db()
    placeholders = ','.join('?' for _ in playlist_ids)
    cursor = db.execute(
        f'SELECT id FROM playlists WHERE user_id = ? AND id IN ({placeholders})',
        (current_user.id, *playlist_ids)
    )
    owned_playlist_ids = [row['id'] for row in cursor.fetchall()]
    if len(owned_playlist_ids) != len(playlist_ids):
        return jsonify({'error': 'One or more playlists were not found'}), 404

    source_id = extract_youtube_video_id(url)
    if source_id:
        source_song = db.execute(
            'SELECT * FROM songs WHERE source_id = ? ORDER BY created_at ASC, id ASC LIMIT 1',
            (source_id,)
        ).fetchone()
        if source_song:
            song_id, created, added_playlist_ids, skipped_playlist_ids = add_global_song_to_playlists(
                db,
                source_song,
                owned_playlist_ids,
            )
            db.commit()
            return jsonify({
                'status': 'added_from_library',
                'song_id': song_id,
                'created': created,
                'playlist_ids': added_playlist_ids,
                'skipped_playlist_ids': skipped_playlist_ids,
                'title': source_song['title'],
                'artist': source_song['artist'],
            })

    download_queue.put({'url': url, 'playlist_ids': owned_playlist_ids, 'user_id': current_user.id})
    return jsonify({'status': 'processing', 'url': url})


@app.route('/api/library-songs', methods=['GET'])
@login_required
def get_library_songs():
    query = request.args.get('q', '').strip()
    search_param = f"%{query}%"
    db = get_db()
    params = [current_user.id]
    where_clause = ''
    if query:
        where_clause = 'WHERE s.title LIKE ? OR s.artist LIKE ?'
        params.extend([search_param, search_param])

    cursor = db.execute(
        f'''
        WITH grouped AS (
            SELECT
                MIN(s.id) AS id,
                COUNT(DISTINCT s.user_id) AS owner_count,
                MAX(CASE WHEN s.user_id = ? THEN 1 ELSE 0 END) AS in_my_library,
                MAX(s.created_at) AS latest_created_at
            FROM songs s
            {where_clause}
            GROUP BY CASE
                WHEN s.source_id IS NOT NULL AND s.source_id != '' THEN 'src:' || s.source_id
                ELSE 'file:' || s.filename
            END
        )
        SELECT
            s.id, s.title, s.artist, s.filename, s.album_art, s.duration_seconds,
            s.source_url, s.source_id, grouped.owner_count, grouped.in_my_library
        FROM grouped
        JOIN songs s ON s.id = grouped.id
        ORDER BY grouped.latest_created_at DESC, s.title COLLATE NOCASE ASC
        LIMIT 100
        ''',
        tuple(params)
    )
    return jsonify([dict(row) for row in cursor.fetchall()])


@app.route('/api/library-songs/check-url')
@login_required
def check_library_song_url():
    url = request.args.get('url', '').strip()
    is_valid, validation_error = validate_youtube_url(url)
    if not is_valid:
        return jsonify({'matched': False, 'error': validation_error}), 400

    source_id = extract_youtube_video_id(url)
    if not source_id:
        return jsonify({'matched': False})

    db = get_db()
    song = db.execute(
        '''
        SELECT id, title, artist, filename, album_art, duration_seconds, source_url, source_id
        FROM songs
        WHERE source_id = ?
        ORDER BY created_at ASC, id ASC
        LIMIT 1
        ''',
        (source_id,)
    ).fetchone()
    if not song:
        return jsonify({'matched': False, 'source_id': source_id})

    return jsonify({'matched': True, 'song': dict(song)})


@app.route('/api/library-songs/<int:song_id>/add', methods=['POST'])
@login_required
def add_library_song(song_id):
    data = request.get_json() or {}
    playlist_ids = data.get('playlist_ids', [])
    if not playlist_ids:
        return jsonify({'error': 'Select at least one playlist'}), 400

    try:
        playlist_ids = sorted({int(pid) for pid in playlist_ids})
    except (TypeError, ValueError):
        return jsonify({'error': 'Invalid playlist data'}), 400

    db = get_db()
    placeholders = ','.join('?' for _ in playlist_ids)
    cursor = db.execute(
        f'SELECT id FROM playlists WHERE user_id = ? AND id IN ({placeholders})',
        (current_user.id, *playlist_ids)
    )
    owned_playlist_ids = [row['id'] for row in cursor.fetchall()]
    if len(owned_playlist_ids) != len(playlist_ids):
        return jsonify({'error': 'One or more playlists were not found'}), 404

    source_song = get_global_song(db, song_id)
    if not source_song:
        return jsonify({'error': 'Library song not found'}), 404

    new_song_id, created, added_playlist_ids, skipped_playlist_ids = add_global_song_to_playlists(
        db,
        source_song,
        owned_playlist_ids,
    )
    db.commit()
    return jsonify({
        'status': 'success',
        'song_id': new_song_id,
        'created': created,
        'playlist_ids': added_playlist_ids,
        'skipped_playlist_ids': skipped_playlist_ids,
        'title': source_song['title'],
        'artist': source_song['artist'],
    })

@app.route('/api/songs', methods=['GET'])
@login_required
def get_songs():
    playlist_id = request.args.get('playlist_id')
    limit = request.args.get('limit', type=int)
    db = get_db()
    cursor = db.cursor()
    if playlist_id:
        if not get_owned_playlist(db, playlist_id):
            return jsonify({'error': 'Playlist not found'}), 404
        cursor.execute('''
            SELECT s.* FROM songs s 
            JOIN playlist_songs ps ON s.id = ps.song_id 
            WHERE ps.playlist_id = ? AND s.user_id = ?
            ORDER BY ps.position ASC, ps.added_at ASC
        ''', (playlist_id, current_user.id))
    else:
        if limit:
            cursor.execute('SELECT * FROM songs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', (current_user.id, limit))
        else:
            cursor.execute('SELECT * FROM songs WHERE user_id = ? ORDER BY created_at DESC', (current_user.id,))
    return jsonify([dict(row) for row in cursor.fetchall()])

@app.route('/api/songs/<int:song_id>', methods=['DELETE'])
@login_required
def delete_song(song_id):
    db = get_db()
    cursor = db.cursor()
    cursor.execute('SELECT filename, album_art FROM songs WHERE id = ? AND user_id = ?', (song_id, current_user.id))
    song = cursor.fetchone()
    if not song:
        return jsonify({'error': 'Not found'}), 404

    filename_ref_count = db.execute(
        'SELECT COUNT(*) AS count FROM songs WHERE filename = ?',
        (song['filename'],)
    ).fetchone()['count']
    album_art_ref_count = 0
    if song['album_art']:
        album_art_ref_count = db.execute(
            'SELECT COUNT(*) AS count FROM songs WHERE album_art = ?',
            (song['album_art'],)
        ).fetchone()['count']

    cursor.execute('DELETE FROM playlist_songs WHERE song_id = ?', (song_id,))
    cursor.execute('DELETE FROM listening_logs WHERE song_id = ?', (song_id,))
    cursor.execute('DELETE FROM songs WHERE id = ?', (song_id,))
    db.commit()

    if filename_ref_count <= 1:
        mp3 = os.path.join(LIBRARY_DIR, song['filename'])
        if os.path.exists(mp3):
            os.remove(mp3)
    if song['album_art'] and album_art_ref_count <= 1:
        art = os.path.join(ALBUM_ART_DIR, song['album_art'])
        if os.path.exists(art):
            os.remove(art)

    return jsonify({'status': 'success'})


@app.route('/api/songs/<int:song_id>/playlists', methods=['POST'])
@login_required
def add_owned_song_to_playlists(song_id):
    data = request.get_json() or {}
    playlist_ids = data.get('playlist_ids', [])
    if not playlist_ids:
        return jsonify({'error': 'Select at least one playlist'}), 400

    try:
        playlist_ids = sorted({int(pid) for pid in playlist_ids})
    except (TypeError, ValueError):
        return jsonify({'error': 'Invalid playlist data'}), 400

    db = get_db()
    song = get_owned_song(db, song_id)
    if not song:
        return jsonify({'error': 'Song not found'}), 404

    placeholders = ','.join('?' for _ in playlist_ids)
    cursor = db.execute(
        f'SELECT id FROM playlists WHERE user_id = ? AND id IN ({placeholders})',
        (current_user.id, *playlist_ids)
    )
    owned_playlist_ids = [row['id'] for row in cursor.fetchall()]
    if len(owned_playlist_ids) != len(playlist_ids):
        return jsonify({'error': 'One or more playlists were not found'}), 404

    added_playlist_ids = []
    skipped_playlist_ids = []
    for playlist_id in owned_playlist_ids:
        existing = db.execute(
            'SELECT 1 FROM playlist_songs WHERE playlist_id = ? AND song_id = ?',
            (playlist_id, song_id)
        ).fetchone()
        if existing:
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

    db.commit()
    return jsonify({
        'status': 'success',
        'song_id': song_id,
        'playlist_ids': added_playlist_ids,
        'skipped_playlist_ids': skipped_playlist_ids,
        'title': song['title'],
        'artist': song['artist'],
    })

@app.route('/audio/<filename>')
@login_required
def stream_audio(filename):
    safe_filename = secure_filename(filename)
    db = get_db()
    song = db.execute(
        'SELECT id FROM songs WHERE filename = ? AND user_id = ?',
        (safe_filename, current_user.id)
    ).fetchone()
    if not song:
        return jsonify({'error': 'Not found'}), 404
    return send_from_directory(LIBRARY_DIR, safe_filename, mimetype='audio/mpeg')

@app.route('/api/search')
@login_required
def search_songs():
    query = request.args.get('q', '')
    db = get_db()
    search_param = f"%{query}%"
    cursor = db.cursor()
    cursor.execute('''
        SELECT * FROM songs
        WHERE user_id = ? AND (title LIKE ? OR artist LIKE ?)
        ORDER BY created_at DESC
    ''', (current_user.id, search_param, search_param))
    return jsonify([dict(row) for row in cursor.fetchall()])

@app.route('/api/listen', methods=['POST'])
@login_required
def log_listen():
    data = request.get_json()
    song_id = data.get('song_id')
    seconds = data.get('seconds', 0)
    if song_id and seconds > 0:
        db = get_db()
        if get_owned_song(db, song_id):
            db.execute('INSERT INTO listening_logs (song_id, user_id, seconds_listened) VALUES (?, ?, ?)', (song_id, current_user.id, seconds))
            db.commit()
    return jsonify({'status': 'ok'})

@app.route('/api/songs/<int:song_id>/play', methods=['POST'])
@login_required
def log_play(song_id):
    db = get_db()
    if not get_owned_song(db, song_id):
        return jsonify({'error': 'Not found'}), 404
    db.execute('UPDATE songs SET play_count = play_count + 1 WHERE id = ? AND user_id = ?', (song_id, current_user.id))
    db.commit()
    return jsonify({'status': 'ok'})


@app.route('/api/songs/<int:song_id>/lyrics')
@login_required
def get_song_lyrics(song_id):
    db = get_db()
    song = get_owned_song(db, song_id)
    if not song:
        return jsonify({'error': 'Not found'}), 404

    return jsonify({
        'lyrics': song['lyrics'] or '',
        'synced_lyrics': song['synced_lyrics'] or '',
        'lyrics_status': song['lyrics_status'] or 'none',
        'lyrics_updated_at': song['lyrics_updated_at'],
    })


@app.route('/api/songs/<int:song_id>/lyrics', methods=['POST'])
@login_required
def refresh_song_lyrics(song_id):
    db = get_db()
    song = get_owned_song(db, song_id)
    if not song:
        return jsonify({'error': 'Not found'}), 404

    allowed, retry_after = check_lyrics_rate_limit(current_user.id)
    if not allowed:
        return jsonify({'error': 'Too many lyrics requests', 'retry_after': retry_after}), 429

    try:
        lyrics_data = search_lyrics(song['title'], song['artist'], song['duration_seconds'])
    except Exception:
        lyrics_data = None

    if not lyrics_data:
        db.execute(
            '''
            UPDATE songs
            SET lyrics = '', synced_lyrics = '', lyrics_status = 'not_found', lyrics_updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND user_id = ?
            ''',
            (song_id, current_user.id)
        )
        db.commit()
        return jsonify({
            'error': 'Lyrics not found',
            'lyrics': '',
            'synced_lyrics': '',
            'lyrics_status': 'not_found',
            'lyrics_updated_at': None,
        }), 404

    db.execute(
        '''
        UPDATE songs
        SET lyrics = ?, synced_lyrics = ?, lyrics_status = 'found', lyrics_updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
        ''',
        (
            lyrics_data.get('lyrics', ''),
            lyrics_data.get('synced_lyrics', ''),
            song_id,
            current_user.id,
        )
    )
    db.commit()

    return jsonify({
        'lyrics': lyrics_data.get('lyrics', ''),
        'synced_lyrics': lyrics_data.get('synced_lyrics', ''),
        'lyrics_status': 'found',
        'lyrics_updated_at': None,
    })


@app.route('/api/songs/<int:song_id>/lyrics', methods=['PUT'])
@login_required
def save_song_lyrics(song_id):
    db = get_db()
    song = get_owned_song(db, song_id)
    if not song:
        return jsonify({'error': 'Not found'}), 404

    data = request.get_json() or {}
    lyrics = str(data.get('lyrics') or '').strip()
    synced_lyrics = str(data.get('synced_lyrics') or '').strip()
    status = 'manual' if lyrics or synced_lyrics else 'none'

    db.execute(
        '''
        UPDATE songs
        SET lyrics = ?, synced_lyrics = ?, lyrics_status = ?, lyrics_updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
        ''',
        (lyrics, synced_lyrics, status, song_id, current_user.id)
    )
    db.commit()

    return jsonify({
        'lyrics': lyrics,
        'synced_lyrics': synced_lyrics,
        'lyrics_status': status,
        'lyrics_updated_at': None,
    })

@app.route('/api/dashboard')
@login_required
def dashboard():
    db = get_db()
    cursor = db.cursor()
    cursor.execute('SELECT COUNT(*) as count FROM playlists WHERE user_id = ?', (current_user.id,))
    total_playlists = cursor.fetchone()['count']
    cursor.execute('SELECT COUNT(*) as count FROM songs WHERE user_id = ?', (current_user.id,))
    total_songs = cursor.fetchone()['count']
    cursor.execute('SELECT SUM(seconds_listened) as total_listened FROM listening_logs WHERE user_id = ?', (current_user.id,))
    total_listened = cursor.fetchone()['total_listened'] or 0

    total_size = sum(os.path.getsize(os.path.join(dp, f)) for dp, dn, filenames in os.walk(DOWNLOAD_DIR) for f in filenames if os.path.isfile(os.path.join(dp, f)))
    total_size += sum(os.path.getsize(os.path.join(ALBUM_ART_DIR, f)) for f in os.listdir(ALBUM_ART_DIR) if os.path.isfile(os.path.join(ALBUM_ART_DIR, f)))
    storage_usage = shutil.disk_usage(DOWNLOAD_DIR)

    return jsonify({
        'total_playlists': total_playlists,
        'total_songs': total_songs,
        'total_listened': int(total_listened),
        'storage_used': total_size,
        'storage_free': storage_usage.free,
        'storage_total': storage_usage.total
    })

@app.route('/api/top-songs')
@login_required
def top_songs():
    db = get_db()
    cursor = db.cursor()
    cursor.execute('''
        SELECT s.id, s.title, s.artist, s.filename, s.album_art, s.duration_seconds,
               COALESCE(s.play_count, 0) as play_count,
               COALESCE(SUM(l.seconds_listened), 0) as total_listened
        FROM songs s
        LEFT JOIN listening_logs l ON s.id = l.song_id AND l.user_id = ?
        WHERE s.user_id = ?
        GROUP BY s.id
        ORDER BY s.play_count DESC, total_listened DESC
        LIMIT 5
    ''', (current_user.id, current_user.id))
    return jsonify([dict(row) for row in cursor.fetchall()])

@app.route('/api/top-songs-duration')
@login_required
def top_songs_duration():
    db = get_db()
    cursor = db.cursor()
    cursor.execute('''
        SELECT s.id, s.title, s.artist, s.filename, s.album_art, s.duration_seconds,
               COALESCE(s.play_count, 0) as play_count,
               COALESCE(SUM(l.seconds_listened), 0) as total_listened
        FROM songs s 
        LEFT JOIN listening_logs l ON s.id = l.song_id AND l.user_id = ?
        WHERE s.user_id = ?
        GROUP BY s.id
        ORDER BY total_listened DESC
        LIMIT 5
    ''', (current_user.id, current_user.id))
    return jsonify([dict(row) for row in cursor.fetchall()])

# ==========================================
# ADMIN: USER MANAGEMENT
# ==========================================

def is_admin():
    """Check if current user is admin"""
    if not current_user.is_authenticated:
        return False
    conn = get_db_connection(DATABASE_PATH)
    cursor = conn.cursor()
    cursor.execute('SELECT role FROM users WHERE id = ?', (current_user.id,))
    user = cursor.fetchone()
    conn.close()
    return user and user['role'] == 'admin'



@app.route('/api/admin/users')
@login_required
def list_users():
    """List all users with stats (admin only)"""
    if not is_admin():
        return jsonify({'error': 'Admin access required'}), 403
    
    users = get_all_users(DATABASE_PATH)
    return jsonify(users)


@app.route('/api/admin/users/<int:user_id>', methods=['DELETE'])
@login_required
def delete_user(user_id):
    """Delete user and all their data (admin only)"""
    if not is_admin():
        return jsonify({'error': 'Admin access required'}), 403
    
    # Prevent admin from deleting themselves
    if user_id == current_user.id:
        return jsonify({'error': 'You cannot delete your own account'}), 400
    
    # Get files before deletion (to delete from filesystem)
    user_files = get_user_files(DATABASE_PATH, user_id)
    
    # Delete from database
    success = delete_user_cascade(DATABASE_PATH, user_id)
    if not success:
        return jsonify({'error': 'Failed to delete user'}), 500
    
    conn = get_db_connection(DATABASE_PATH)
    for file_info in user_files:
        try:
            filename_count = conn.execute(
                'SELECT COUNT(*) AS count FROM songs WHERE filename = ?',
                (file_info['filename'],)
            ).fetchone()['count']
            if filename_count == 0:
                mp3_path = os.path.join(LIBRARY_DIR, file_info['filename'])
                if os.path.exists(mp3_path):
                    os.remove(mp3_path)

            if file_info.get('album_art'):
                album_art_count = conn.execute(
                    'SELECT COUNT(*) AS count FROM songs WHERE album_art = ?',
                    (file_info['album_art'],)
                ).fetchone()['count']
                if album_art_count == 0:
                    art_path = os.path.join(ALBUM_ART_DIR, file_info['album_art'])
                    if os.path.exists(art_path):
                        os.remove(art_path)
        except Exception as e:
            target = file_info.get('filename') or file_info.get('album_art') or 'unknown file'
            print(f"[WARN] Failed to delete {target}: {e}")
    conn.close()
    
    return jsonify({'status': 'success', 'message': 'User and all data deleted'})


@app.route('/api/admin/users/<int:user_id>/reset-password', methods=['POST'])
@login_required
def reset_user_password(user_id):
    """Reset user password (admin only)"""
    if not is_admin():
        return jsonify({'error': 'Admin access required'}), 403
    
    data = request.get_json()
    new_password = data.get('password', '')
    
    if not new_password:
        return jsonify({'error': 'New password required'}), 400
    
    if len(new_password) < 6:
        return jsonify({'error': 'Password must be at least 6 characters'}), 400
    
    success = update_user_password(DATABASE_PATH, user_id, new_password)
    
    if not success:
        return jsonify({'error': 'User not found'}), 404
    
    return jsonify({'status': 'success', 'message': 'Password reset successfully'})


@app.route('/api/admin/users/<int:user_id>/role', methods=['PUT'])
@login_required
def change_user_role(user_id):
    """Change user role (admin only)"""
    if not is_admin():
        return jsonify({'error': 'Admin access required'}), 403
    
    # Prevent admin from demoting themselves
    if user_id == current_user.id:
        return jsonify({'error': 'You cannot change your own role'}), 400
    
    data = request.get_json()
    new_role = data.get('role', '')
    
    if new_role not in ('user', 'admin'):
        return jsonify({'error': 'Invalid role. Must be user or admin'}), 400
    
    conn = get_db_connection(DATABASE_PATH)
    try:
        cursor = conn.cursor()
        cursor.execute('UPDATE users SET role = ? WHERE id = ?', (new_role, user_id))
        conn.commit()
        
        if cursor.rowcount == 0:
            return jsonify({'error': 'User not found'}), 404
        
        return jsonify({'status': 'success', 'message': f'Role updated to {new_role}'})
    finally:
        conn.close()



if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5000, debug=False, allow_unsafe_werkzeug=True)
