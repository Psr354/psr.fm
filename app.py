import os
from dotenv import load_dotenv
from flask import Flask, request, jsonify, send_from_directory, render_template, redirect, url_for
from flask_login import LoginManager, login_required, current_user
from flask_socketio import SocketIO, join_room
from flask_wtf.csrf import CSRFProtect, generate_csrf, validate_csrf
from flask_compress import Compress
from werkzeug.middleware.proxy_fix import ProxyFix

from services.database import init_db, validate_user_session
from services.downloader import download_queue, start_worker  # noqa: F401
from services.lyrics import search_lyrics  # noqa: F401
from services.common import (
    User, get_db, get_user_status_bar_color, reset_rate_limits,
    LOGIN_RATE_LIMIT_MAX_ATTEMPTS  # noqa: F401
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
    app.wsgi_app = ProxyFix(
        app.wsgi_app,
        x_for=trusted_proxy_count,
        x_proto=trusted_proxy_count,
        x_host=trusted_proxy_count,
    )

app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0
app.config['MAX_CONTENT_LENGTH'] = int(os.environ.get(
    'PSR_FM_MAX_CONTENT_LENGTH', 55 * 1024 * 1024
))
COOKIE_SECURE = os.environ.get('PSR_FM_COOKIE_SECURE', '').strip().lower() in ('1', 'true', 'yes')
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['SESSION_COOKIE_SECURE'] = COOKIE_SECURE
app.config['REMEMBER_COOKIE_HTTPONLY'] = True
app.config['REMEMBER_COOKIE_SAMESITE'] = 'Lax'
app.config['REMEMBER_COOKIE_SECURE'] = COOKIE_SECURE

Compress(app)

DATA_DIR = os.path.join(BASE_DIR, 'data')
DOWNLOAD_DIR = os.environ.get('PSR_FM_DOWNLOAD_DIR', os.path.join(DATA_DIR, 'downloads'))
LIBRARY_DIR = os.path.join(DOWNLOAD_DIR, 'library')
ALBUM_ART_DIR = os.environ.get('PSR_FM_ALBUM_ART_DIR', os.path.join(DATA_DIR, 'album_art'))
DATABASE_PATH = os.environ.get('PSR_FM_DATABASE_PATH', os.path.join(DATA_DIR, 'psr_fm.sqlite3'))
DATABASE_DIR = os.path.dirname(DATABASE_PATH) or DATA_DIR

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

def _parse_socketio_origins(raw_value):
    cleaned = (raw_value or '').strip()
    if not cleaned:
        return None
    if cleaned == '*':
        return '*'
    origins = [origin.strip() for origin in cleaned.split(',') if origin.strip()]
    return origins or None


socketio_origins = _parse_socketio_origins(os.environ.get('PSR_FM_SOCKETIO_ORIGINS', ''))
socketio = SocketIO(app, cors_allowed_origins=socketio_origins, async_mode='threading')
app.socketio = socketio

init_db(DATABASE_PATH)
if os.environ.get('PSR_FM_DISABLE_WORKER') != '1':
    start_worker(DATABASE_PATH, DOWNLOAD_DIR, ALBUM_ART_DIR, socketio)

MAINTENANCE_MODE = os.environ.get('PSR_FM_MAINTENANCE_MODE', '').strip().lower() in ('1', 'true', 'yes')


@app.before_request
def maintenance_check():
    if MAINTENANCE_MODE:
        return render_template('maintenance.html'), 503


CSP_POLICY = (
    "default-src 'self'; "
    "script-src 'self' https://cdnjs.cloudflare.com; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; "
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:; "
    "img-src 'self' data: blob:; "
    "media-src 'self' blob: data:; "
    "connect-src 'self' ws: wss: https://cdnjs.cloudflare.com; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "frame-ancestors 'self'"
)


@app.after_request
def set_csrf_cookie(response):
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('X-Frame-Options', 'SAMEORIGIN')
    response.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')

    is_static_path = request.path.startswith('/static/')
    if not is_static_path:
        response.headers.setdefault('Content-Security-Policy', CSP_POLICY)
        token = generate_csrf()
        response.set_cookie(
            'csrf_token',
            token,
            httponly=False,
            samesite='Lax',
            secure=COOKIE_SECURE,
        )
    if response.status_code == 200:
        if request.path.startswith('/static/album_art/'):
            response.cache_control.max_age = 31536000
            response.cache_control.private = True
            response.cache_control.public = False
        elif request.path.endswith(('.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg')):
            response.cache_control.max_age = 31536000
            response.cache_control.public = True
    return response


@app.before_request
def csrf_protect():
    if request.method in ['POST', 'PUT', 'DELETE', 'PATCH']:
        token = request.headers.get('X-CSRF-Token') or request.form.get('csrf_token')
        if not token:
            return jsonify({'error': 'CSRF token missing'}), 403
        try:
            validate_csrf(token)
        except Exception:
            return jsonify({'error': 'Invalid CSRF token'}), 403


@login_manager.user_loader
def load_user(user_id):
    raw = str(user_id or '')
    parts = raw.split(':')
    if len(parts) not in (2, 3):
        return None
    uid_part = parts[0]
    token = parts[1]
    device_token = parts[2] if len(parts) == 3 else ''
    if not uid_part.isdigit() or not token:
        return None
    uid = int(uid_part)
    conn = get_db()
    row = conn.execute(
        'SELECT id, username, role, session_token FROM users WHERE id = ? AND session_token = ?',
        (uid, token),
    ).fetchone()
    if not row:
        return None
    if len(parts) == 3 and not validate_user_session(conn, uid, device_token):
        return None
    return User(
        id=row['id'],
        username=row['username'],
        role=row['role'],
        session_token=row['session_token'],
        device_token=device_token,
    )


@login_manager.unauthorized_handler
def unauthorized():
    if request.path.startswith('/api/'):
        return jsonify({'error': 'Unauthorized'}), 401
    return redirect(url_for('auth.login_page'))


@socketio.on('connect')
def on_socket_connect():
    if not current_user.is_authenticated:
        return False
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


@app.route('/healthz')
def healthz():
    try:
        get_db().execute('SELECT 1').fetchone()
        return jsonify({'status': 'ok'}), 200
    except Exception:
        return jsonify({'status': 'error'}), 503


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
            { "src": "/static/img/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
            { "src": "/static/img/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
            { "src": "/static/img/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable" },
            { "src": "/static/img/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
        ]
    }
    resp = jsonify(manifest_data)
    resp.mimetype = 'application/manifest+json'
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return resp


@app.route('/static/album_art/<path:filename>')
@login_required
def serve_album_art(filename):
    """Serve runtime album and playlist artwork from ALBUM_ART_DIR."""
    base_name = os.path.basename(filename)
    if base_name.startswith('pl_cover_'):
        owned = get_db().execute(
            'SELECT 1 FROM playlists WHERE cover_art = ? AND user_id = ?',
            (base_name, current_user.id),
        ).fetchone()
        if not owned:
            return jsonify({'error': 'Not found'}), 404
    return send_from_directory(app.config.get('ALBUM_ART_DIR') or ALBUM_ART_DIR, filename)


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
