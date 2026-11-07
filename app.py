import os
import shutil
from datetime import datetime, timezone
from dotenv import load_dotenv
from flask import Flask, request, jsonify, send_from_directory, render_template, redirect, url_for
from flask_login import LoginManager, login_required, current_user
from flask_socketio import SocketIO, join_room
from flask_wtf.csrf import CSRFProtect, generate_csrf, validate_csrf
from flask_compress import Compress
from werkzeug.middleware.proxy_fix import ProxyFix

from services.database import (
    init_db, get_db_connection, has_any_user,
    get_user_by_username, create_user, get_all_users,
    get_user_files, delete_user_cascade, update_user_password,
    get_user_playback_state, save_user_playback_state,
    get_user_theme, save_user_theme, extract_song_source_id
)
from services.downloader import download_queue, start_worker, validate_song_url
from services.lyrics import search_lyrics, parse_lrc
from services.common import (
    User, get_db, get_owned_playlist, get_owned_song, get_global_song,
    add_global_song_to_playlists, get_json_object, audio_mimetype,
    playback_timestamp, valid_playback_id, queue_file_deletion,
    check_login_rate_limit, record_failed_login, clear_login_rate_limit,
    check_lyrics_rate_limit, get_user_status_bar_color, reset_rate_limits,
    LOGIN_RATE_LIMIT_MAX_ATTEMPTS
)

from routes.auth import auth_bp
from routes.playlists import playlists_bp
from routes.songs import songs_bp
from routes.lyrics import lyrics_bp
from routes.recap import recap_bp
from routes.user_settings import user_settings_bp

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
load_dotenv(os.path.join(BASE_DIR, '.env'))

app = Flask(__name__)
secret_key = os.environ.get('SECRET_KEY')
if not secret_key and (os.environ.get('FLASK_ENV', '').lower() == 'production' or os.environ.get('PSR_FM_ENV', '').lower() == 'production'):
    raise RuntimeError('SECRET_KEY must be configured in production')
app.secret_key = secret_key or os.urandom(32).hex()

trusted_proxy_count = int(os.environ.get('PSR_FM_TRUSTED_PROXY_COUNT', '0'))
if trusted_proxy_count:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=trusted_proxy_count)

app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0
app.config['MAX_CONTENT_LENGTH'] = int(os.environ.get(
    'PSR_FM_MAX_CONTENT_LENGTH', 55 * 1024 * 1024
))

Compress(app)

DOWNLOAD_DIR = os.environ.get('PSR_FM_DOWNLOAD_DIR', os.path.join(BASE_DIR, 'downloads'))
LIBRARY_DIR = os.path.join(DOWNLOAD_DIR, 'library')
ALBUM_ART_DIR = os.environ.get('PSR_FM_ALBUM_ART_DIR', os.path.join(BASE_DIR, 'static', 'album_art'))
DATABASE_PATH = os.environ.get('PSR_FM_DATABASE_PATH', os.path.join(BASE_DIR, 'database.db', 'psr_fm.sqlite3'))
DATABASE_DIR = os.path.dirname(DATABASE_PATH) or os.path.join(BASE_DIR, 'database.db')

app.config['DATABASE_PATH'] = DATABASE_PATH
app.config['DOWNLOAD_DIR'] = DOWNLOAD_DIR
app.config['LIBRARY_DIR'] = LIBRARY_DIR
app.config['ALBUM_ART_DIR'] = ALBUM_ART_DIR

os.makedirs(DOWNLOAD_DIR, exist_ok=True)
os.makedirs(LIBRARY_DIR, exist_ok=True)
os.makedirs(ALBUM_ART_DIR, exist_ok=True)
os.makedirs(DATABASE_DIR, exist_ok=True)
reset_rate_limits()

# CSRF configuration
app.config['WTF_CSRF_CHECK_DEFAULT'] = False
csrf = CSRFProtect(app)

login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'auth.login_page'
login_manager.login_message = None

socketio_origins = os.environ.get('PSR_FM_SOCKETIO_ORIGINS', '').strip() or None
socketio = SocketIO(app, cors_allowed_origins=socketio_origins, async_mode='threading')
app.socketio = socketio

init_db(DATABASE_PATH)
if os.environ.get('PSR_FM_DISABLE_WORKER') != '1':
    start_worker(DATABASE_PATH, DOWNLOAD_DIR, ALBUM_ART_DIR, socketio)

MAINTENANCE_MODE = False


@app.before_request
def maintenance_check():
    if MAINTENANCE_MODE:
        return render_template('maintenance.html'), 503


@app.after_request
def set_csrf_cookie(response):
    token = generate_csrf()
    response.set_cookie('csrf_token', token, httponly=False, samesite='Lax')
    if request.path.startswith('/static/album_art/') or request.path.endswith(('.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg')):
        response.cache_control.max_age = 31536000
        response.cache_control.public = True
    return response


CSRF_EXEMPT_ROUTES = {'/api/login', '/api/setup'}


@app.before_request
def csrf_protect():
    if request.method in ['POST', 'PUT', 'DELETE', 'PATCH']:
        if request.path in CSRF_EXEMPT_ROUTES:
            return
        token = request.headers.get('X-CSRF-Token') or request.form.get('csrf_token')
        if not token:
            return jsonify({'error': 'CSRF token missing'}), 403
        try:
            validate_csrf(token)
        except Exception:
            return jsonify({'error': 'Invalid CSRF token'}), 403


@login_manager.user_loader
def load_user(user_id):
    conn = get_db_connection(app.config.get('DATABASE_PATH') or DATABASE_PATH)
    cursor = conn.cursor()
    cursor.execute('SELECT id, username, role FROM users WHERE id = ?', (user_id,))
    row = cursor.fetchone()
    conn.close()
    if row:
        return User(id=row['id'], username=row['username'], role=row['role'])
    return None


@login_manager.unauthorized_handler
def unauthorized():
    if request.path.startswith('/api/'):
        return jsonify({'error': 'Unauthorized'}), 401
    return redirect(url_for('auth.login_page'))


@socketio.on('connect')
def on_socket_connect():
    if current_user.is_authenticated:
        join_room(f'user_{current_user.id}')


@app.teardown_appcontext
def close_connection(exception):
    from flask import g
    db = getattr(g, 'db', None)
    if db is not None:
        db.close()


def get_asset_version(filename):
    """Generate cache-busting version based on file modification timestamp."""
    static_folder = app.static_folder or os.path.join(BASE_DIR, 'static')
    filepath = os.path.join(static_folder, filename)
    try:
        mtime = int(os.path.getmtime(filepath))
        return str(mtime)
    except OSError:
        return '1'


@app.context_processor
def inject_asset_version():
    return dict(asset_version=get_asset_version)


@app.route('/')
@login_required
def index():
    status_bar_color = get_user_status_bar_color(current_user.id)
    return render_template('index.html', status_bar_color=status_bar_color)


@app.route('/site.webmanifest')
def site_webmanifest():
    status_bar_color = '#070908'
    if current_user.is_authenticated:
        status_bar_color = get_user_status_bar_color(current_user.id)
    manifest_data = {
        "name": "psr.fm",
        "short_name": "psr.fm",
        "description": "Personal Self-Hosted Music Streaming Server",
        "id": "/",
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "background_color": "#070908",
        "theme_color": status_bar_color,
        "launch_handler": {
            "client_mode": "focus-existing"
        },
        "icons": [
            { "src": "/static/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
            { "src": "/static/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
            { "src": "/static/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable" },
            { "src": "/static/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
        ]
    }
    resp = jsonify(manifest_data)
    resp.mimetype = 'application/manifest+json'
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return resp


@app.route('/service-worker.js')
def service_worker():
    """Expose the worker at the domain root so it can control the app and audio URLs."""
    response = send_from_directory(app.static_folder or os.path.join(BASE_DIR, 'static'), 'service-worker.js', mimetype='application/javascript')
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    response.headers['Service-Worker-Allowed'] = '/'
    return response


# Register Blueprints
app.register_blueprint(auth_bp)
app.register_blueprint(playlists_bp)
app.register_blueprint(songs_bp)
app.register_blueprint(lyrics_bp)
app.register_blueprint(recap_bp)
app.register_blueprint(user_settings_bp)


if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5000, debug=False, allow_unsafe_werkzeug=True)
