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
from dotenv import load_dotenv

from services.database import (
    init_db, get_db_connection, 
    get_user_by_username, create_user, has_any_user
)
from services.downloader import download_queue, start_worker

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
load_dotenv(os.path.join(BASE_DIR, '.env'))

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', os.urandom(32).hex())

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

DOWNLOAD_DIR = os.path.join(BASE_DIR, 'downloads')
LIBRARY_DIR = os.path.join(DOWNLOAD_DIR, 'library')
ALBUM_ART_DIR = os.path.join(BASE_DIR, 'static', 'album_art')
DATABASE_PATH = os.path.join(BASE_DIR, 'database.db')
ADMIN_USERNAME = 'psr354'

os.makedirs(DOWNLOAD_DIR, exist_ok=True)
os.makedirs(LIBRARY_DIR, exist_ok=True)
os.makedirs(ALBUM_ART_DIR, exist_ok=True)
os.makedirs(os.path.join(BASE_DIR, 'logs'), exist_ok=True)

init_db(DATABASE_PATH)
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

def current_user_can_manage_accounts():
    return current_user.is_authenticated and current_user.username == ADMIN_USERNAME

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
    
    user_id = create_user(DATABASE_PATH, username, password)
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
    
    user_row = get_user_by_username(DATABASE_PATH, username)
    if not user_row or not check_password_hash(user_row['password_hash'], password):
        return jsonify({'error': 'Invalid username or password'}), 401
    
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
        'can_add_users': current_user_can_manage_accounts()
    })

@app.route('/api/users', methods=['POST'])
@login_required
def create_new_user():
    if not current_user_can_manage_accounts():
        return jsonify({'error': 'Only psr354 can add accounts'}), 403

    data = request.get_json()
    username = data.get('username', '').strip()
    password = data.get('password', '')
    if not username or not password:
        return jsonify({'error': 'Username and password required'}), 400
    if len(password) < 6:
        return jsonify({'error': 'Password must be at least 6 characters'}), 400
    if len(username) < 3:
        return jsonify({'error': 'Username must be at least 3 characters'}), 400
    
    user_id = create_user(DATABASE_PATH, username, password)
    if not user_id:
        return jsonify({'error': 'Username already taken'}), 400
    
    return jsonify({'status': 'success', 'message': f'User {username} created successfully'})

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
    db.execute('UPDATE playlists SET name = ? WHERE id = ? AND user_id = ?', (name, playlist_id, current_user.id))
    db.commit()
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

@app.route('/api/download', methods=['POST'])
@login_required
def download_song():
    data = request.get_json()
    url = data.get('url')
    playlist_ids = data.get('playlist_ids', [])
    if not url or not playlist_ids:
        return jsonify({'error': 'Missing data'}), 400
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

    download_queue.put({'url': url, 'playlist_ids': owned_playlist_ids, 'user_id': current_user.id})
    return jsonify({'status': 'processing', 'url': url})

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
            ORDER BY ps.added_at DESC
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

    mp3 = os.path.join(LIBRARY_DIR, song['filename'])
    if os.path.exists(mp3):
        os.remove(mp3)
    if song['album_art']:
        art = os.path.join(ALBUM_ART_DIR, song['album_art'])
        if os.path.exists(art):
            os.remove(art)

    cursor.execute('DELETE FROM playlist_songs WHERE song_id = ?', (song_id,))
    cursor.execute('DELETE FROM listening_logs WHERE song_id = ?', (song_id,))
    cursor.execute('DELETE FROM songs WHERE id = ?', (song_id,))
    db.commit()
    return jsonify({'status': 'success'})

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

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5000, debug=False, allow_unsafe_werkzeug=True)
