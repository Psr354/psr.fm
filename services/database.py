import logging
import secrets
import sqlite3
from urllib.parse import parse_qs, urlparse
from werkzeug.security import generate_password_hash

logger = logging.getLogger(__name__)


def extract_youtube_video_id(url):
    parsed = urlparse((url or '').strip())
    host = parsed.netloc.lower()
    if host.startswith('www.'):
        host = host[4:]

    if host == 'youtu.be':
        return parsed.path.strip('/').split('/')[0] or ''

    if host in {'youtube.com', 'm.youtube.com', 'music.youtube.com'}:
        if parsed.path == '/watch':
            return parse_qs(parsed.query).get('v', [''])[0]
        path_parts = [part for part in parsed.path.split('/') if part]
        if len(path_parts) >= 2 and path_parts[0] in {'shorts', 'embed', 'live'}:
            return path_parts[1]

    return ''


def extract_song_source_id(url):
    """Return a stable library key for a supported song URL."""
    youtube_id = extract_youtube_video_id(url)
    if youtube_id:
        # Keep the legacy YouTube key format so existing library rows still match.
        return youtube_id

    parsed = urlparse((url or '').strip())
    host = parsed.netloc.lower()
    if host.startswith('www.'):
        host = host[4:]
    if host == 'open.spotify.com':
        parts = [part for part in parsed.path.split('/') if part]
        if 'track' in parts:
            track_index = parts.index('track')
            if len(parts) > track_index + 1 and parts[track_index + 1].isalnum():
                return f'spotify:{parts[track_index + 1]}'

    return ''


def get_db_connection(db_path):
    """Create a database connection with row factory, WAL mode, and foreign keys enabled"""
    conn = sqlite3.connect(db_path, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
    except sqlite3.OperationalError:
        pass
    return conn


def _init_users_and_sessions_tables(cursor):
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin')),
            session_token TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    cursor.execute("PRAGMA table_info(users)")
    user_cols = [col[1] for col in cursor.fetchall()]
    if 'role' not in user_cols:
        cursor.execute("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'")
        cursor.execute("UPDATE users SET role = 'admin' WHERE id = 1")

    if 'session_token' not in user_cols:
        cursor.execute("ALTER TABLE users ADD COLUMN session_token TEXT DEFAULT ''")

    cursor.execute("SELECT id FROM users WHERE session_token IS NULL OR session_token = ''")
    for row in cursor.fetchall():
        cursor.execute(
            'UPDATE users SET session_token = ? WHERE id = ?',
            (secrets.token_hex(16), row['id'])
        )

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS user_sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        )
    ''')
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id
        ON user_sessions (user_id)
    ''')


def _init_playlists_and_songs_tables(cursor):
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS playlists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            folder_name TEXT NOT NULL,
            cover_art TEXT DEFAULT '',
            user_id INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        )
    ''')

    cursor.execute("PRAGMA table_info(playlists)")
    playlist_cols = [col[1] for col in cursor.fetchall()]
    if 'cover_art' not in playlist_cols:
        cursor.execute("ALTER TABLE playlists ADD COLUMN cover_art TEXT DEFAULT ''")
    if 'user_id' not in playlist_cols:
        cursor.execute("ALTER TABLE playlists ADD COLUMN user_id INTEGER DEFAULT 1")
        cursor.execute("UPDATE playlists SET user_id = 1 WHERE user_id IS NULL")

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS songs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            artist TEXT,
            filename TEXT NOT NULL,
            album_art TEXT,
            duration_seconds INTEGER,
            file_size_bytes INTEGER DEFAULT 0,
            source_url TEXT,
            source_id TEXT,
            play_count INTEGER DEFAULT 0,
            lyrics TEXT,
            synced_lyrics TEXT,
            word_synced_lyrics TEXT,
            lyrics_status TEXT DEFAULT 'none',
            lyrics_updated_at TIMESTAMP,
            user_id INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        )
    ''')

    cursor.execute("PRAGMA table_info(songs)")
    song_cols = [col[1] for col in cursor.fetchall()]

    if 'playlist_id' in song_cols:
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS playlist_songs (
                playlist_id INTEGER,
                song_id INTEGER,
                added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                position INTEGER DEFAULT 0,
                PRIMARY KEY (playlist_id, song_id),
                FOREIGN KEY (playlist_id) REFERENCES playlists (id) ON DELETE CASCADE,
                FOREIGN KEY (song_id) REFERENCES songs (id) ON DELETE CASCADE
            )
        ''')
        cursor.execute('''
            INSERT OR IGNORE INTO playlist_songs (playlist_id, song_id, position)
            SELECT playlist_id, id, id FROM songs WHERE playlist_id IS NOT NULL
        ''')
        cursor.execute('''
            CREATE TABLE songs_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                artist TEXT,
                filename TEXT NOT NULL,
                album_art TEXT,
                duration_seconds INTEGER,
                source_url TEXT,
                source_id TEXT,
                play_count INTEGER DEFAULT 0,
                lyrics TEXT,
                synced_lyrics TEXT,
                lyrics_status TEXT DEFAULT 'none',
                lyrics_updated_at TIMESTAMP,
                user_id INTEGER NOT NULL DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            )
        ''')
        cursor.execute('''
            INSERT INTO songs_new
            SELECT id, title, artist, filename, album_art, duration_seconds,
                   NULL, NULL, COALESCE(play_count, 0), NULL, NULL, 'none', NULL, 1, created_at
            FROM songs
        ''')
        cursor.execute('DROP TABLE songs')
        cursor.execute('ALTER TABLE songs_new RENAME TO songs')
    else:
        if 'play_count' not in song_cols:
            cursor.execute("ALTER TABLE songs ADD COLUMN play_count INTEGER DEFAULT 0")
        if 'lyrics' not in song_cols:
            cursor.execute("ALTER TABLE songs ADD COLUMN lyrics TEXT")
        if 'synced_lyrics' not in song_cols:
            cursor.execute("ALTER TABLE songs ADD COLUMN synced_lyrics TEXT")
        if 'lyrics_status' not in song_cols:
            cursor.execute("ALTER TABLE songs ADD COLUMN lyrics_status TEXT DEFAULT 'none'")
            cursor.execute('''
                UPDATE songs
                SET lyrics_status = CASE
                    WHEN COALESCE(lyrics, '') != '' OR COALESCE(synced_lyrics, '') != '' THEN 'found'
                    ELSE 'none'
                END
                WHERE lyrics_status IS NULL OR lyrics_status = ''
            ''')
        if 'lyrics_updated_at' not in song_cols:
            cursor.execute("ALTER TABLE songs ADD COLUMN lyrics_updated_at TIMESTAMP")
        if 'source_url' not in song_cols:
            cursor.execute("ALTER TABLE songs ADD COLUMN source_url TEXT")
        if 'source_id' not in song_cols:
            cursor.execute("ALTER TABLE songs ADD COLUMN source_id TEXT")
        if 'user_id' not in song_cols:
            cursor.execute("ALTER TABLE songs ADD COLUMN user_id INTEGER DEFAULT 1")
            cursor.execute("UPDATE songs SET user_id = 1 WHERE user_id IS NULL")

    cursor.execute("PRAGMA table_info(songs)")
    existing_cols = [col[1] for col in cursor.fetchall()]
    if 'word_synced_lyrics' not in existing_cols:
        cursor.execute("ALTER TABLE songs ADD COLUMN word_synced_lyrics TEXT")
    if 'file_size_bytes' not in existing_cols:
        cursor.execute("ALTER TABLE songs ADD COLUMN file_size_bytes INTEGER DEFAULT 0")

    _init_songs_fts(cursor)
    _init_tracks_table(cursor)

    cursor.execute('''
        SELECT id, source_url FROM songs
        WHERE (source_id IS NULL OR source_id = '')
          AND source_url IS NOT NULL
          AND source_url != ''
    ''')
    for row in cursor.fetchall():
        source_id = extract_song_source_id(row['source_url'])
        if source_id:
            cursor.execute(
                'UPDATE songs SET source_id = ? WHERE id = ?',
                (source_id, row['id'])
            )

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS playlist_songs (
            playlist_id INTEGER,
            song_id INTEGER,
            added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            position INTEGER DEFAULT 0,
            PRIMARY KEY (playlist_id, song_id),
            FOREIGN KEY (playlist_id) REFERENCES playlists (id) ON DELETE CASCADE,
            FOREIGN KEY (song_id) REFERENCES songs (id) ON DELETE CASCADE
        )
    ''')

    cursor.execute("PRAGMA table_info(playlist_songs)")
    playlist_song_cols = [col[1] for col in cursor.fetchall()]
    if 'position' not in playlist_song_cols:
        cursor.execute("ALTER TABLE playlist_songs ADD COLUMN position INTEGER DEFAULT 0")
        cursor.execute("SELECT DISTINCT playlist_id FROM playlist_songs")
        playlist_ids = [row['playlist_id'] for row in cursor.fetchall()]
        for playlist_id in playlist_ids:
            cursor.execute('''
                SELECT song_id FROM playlist_songs
                WHERE playlist_id = ?
                ORDER BY position ASC, added_at ASC, song_id ASC
            ''', (playlist_id,))
            for index, row in enumerate(cursor.fetchall()):
                cursor.execute(
                    'UPDATE playlist_songs SET position = ? WHERE playlist_id = ? AND song_id = ?',
                    (index, playlist_id, row['song_id'])
                )


def _init_songs_fts(cursor):
    """Initialize SQLite FTS5 table and sync triggers for fast full-text song searches."""
    cursor.execute('''
        CREATE VIRTUAL TABLE IF NOT EXISTS songs_fts USING fts5(
            title,
            artist,
            content='songs',
            content_rowid='id'
        )
    ''')
    cursor.execute('''
        CREATE TRIGGER IF NOT EXISTS songs_ai AFTER INSERT ON songs BEGIN
            INSERT INTO songs_fts(rowid, title, artist) VALUES (new.id, new.title, new.artist);
        END
    ''')
    cursor.execute('''
        CREATE TRIGGER IF NOT EXISTS songs_ad AFTER DELETE ON songs BEGIN
            INSERT INTO songs_fts(songs_fts, rowid, title, artist) VALUES('delete', old.id, old.title, old.artist);
        END
    ''')
    cursor.execute('''
        CREATE TRIGGER IF NOT EXISTS songs_au AFTER UPDATE OF title, artist ON songs BEGIN
            INSERT INTO songs_fts(songs_fts, rowid, title, artist) VALUES('delete', old.id, old.title, old.artist);
            INSERT INTO songs_fts(rowid, title, artist) VALUES (new.id, new.title, new.artist);
        END
    ''')
    try:
        cursor.execute("SELECT COUNT(*) FROM songs_fts")
        fts_cnt = cursor.fetchone()[0]
        cursor.execute("SELECT COUNT(*) FROM songs")
        songs_cnt = cursor.fetchone()[0]
        if fts_cnt != songs_cnt:
            cursor.execute("INSERT INTO songs_fts(songs_fts) VALUES('rebuild')")
    except Exception:
        pass


def _init_tracks_table(cursor):
    """Initialize canonical tracks catalog table, track_id column, indexes, triggers and backfill."""
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS tracks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id TEXT,
            source_url TEXT,
            title TEXT NOT NULL,
            artist TEXT,
            filename TEXT NOT NULL UNIQUE,
            album_art TEXT,
            duration_seconds INTEGER,
            file_size_bytes INTEGER DEFAULT 0,
            lyrics TEXT,
            synced_lyrics TEXT,
            word_synced_lyrics TEXT,
            lyrics_status TEXT DEFAULT 'none',
            lyrics_updated_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    cursor.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_filename ON tracks (filename)')
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_tracks_source_id
        ON tracks (source_id)
        WHERE source_id IS NOT NULL AND source_id != ''
    ''')

    cursor.execute("PRAGMA table_info(songs)")
    song_cols = [col[1] for col in cursor.fetchall()]
    if 'track_id' not in song_cols:
        cursor.execute("ALTER TABLE songs ADD COLUMN track_id INTEGER REFERENCES tracks (id)")

    cursor.execute("CREATE INDEX IF NOT EXISTS idx_songs_track_id ON songs (track_id)")

    cursor.execute('''
        CREATE TRIGGER IF NOT EXISTS songs_ai_track AFTER INSERT ON songs
        WHEN new.track_id IS NULL AND new.filename IS NOT NULL AND new.filename != ''
        BEGIN
            INSERT OR IGNORE INTO tracks (
                source_id, source_url, title, artist, filename,
                album_art, duration_seconds, file_size_bytes,
                lyrics, synced_lyrics, word_synced_lyrics,
                lyrics_status, lyrics_updated_at, created_at
            ) VALUES (
                new.source_id, new.source_url, new.title, new.artist, new.filename,
                new.album_art, new.duration_seconds, COALESCE(new.file_size_bytes, 0),
                new.lyrics, new.synced_lyrics, new.word_synced_lyrics,
                new.lyrics_status, new.lyrics_updated_at, new.created_at
            );
            UPDATE songs SET track_id = (SELECT id FROM tracks WHERE filename = new.filename)
            WHERE id = new.id;
        END
    ''')

    cursor.execute('''
        CREATE TRIGGER IF NOT EXISTS songs_ad_track AFTER DELETE ON songs
        WHEN old.track_id IS NOT NULL
        BEGIN
            DELETE FROM tracks
            WHERE id = old.track_id
              AND NOT EXISTS (SELECT 1 FROM songs WHERE track_id = old.track_id);
        END
    ''')

    cursor.execute('''
        CREATE TRIGGER IF NOT EXISTS songs_au_track_meta AFTER UPDATE OF title, artist, file_size_bytes, album_art, duration_seconds ON songs
        WHEN new.track_id IS NOT NULL
        BEGIN
            UPDATE tracks
            SET title = CASE WHEN COALESCE(new.title, '') != '' THEN new.title ELSE tracks.title END,
                artist = CASE WHEN COALESCE(new.artist, '') != '' THEN new.artist ELSE tracks.artist END,
                file_size_bytes = CASE WHEN new.file_size_bytes > 0 THEN new.file_size_bytes ELSE tracks.file_size_bytes END,
                album_art = CASE WHEN COALESCE(new.album_art, '') != '' THEN new.album_art ELSE tracks.album_art END,
                duration_seconds = CASE WHEN new.duration_seconds > 0 THEN new.duration_seconds ELSE tracks.duration_seconds END
            WHERE id = new.track_id;
        END
    ''')

    cursor.execute('''
        INSERT OR IGNORE INTO tracks (
            source_id, source_url, title, artist, filename,
            album_art, duration_seconds, file_size_bytes,
            lyrics, synced_lyrics, word_synced_lyrics,
            lyrics_status, lyrics_updated_at, created_at
        )
        SELECT
            source_id, source_url, title, artist, filename,
            album_art, duration_seconds, COALESCE(file_size_bytes, 0),
            lyrics, synced_lyrics, word_synced_lyrics,
            lyrics_status, lyrics_updated_at, MIN(created_at)
        FROM songs
        WHERE filename IS NOT NULL AND filename != ''
        GROUP BY filename
    ''')

    cursor.execute('''
        UPDATE songs
        SET track_id = (SELECT id FROM tracks WHERE tracks.filename = songs.filename)
        WHERE track_id IS NULL AND filename IS NOT NULL AND filename != ''
    ''')


def _table_needs_song_set_null_migration(cursor, table_name):
    cursor.execute(f"PRAGMA table_info({table_name})")
    cols = [col[1] for col in cursor.fetchall()]
    if 'song_title' not in cols or 'song_artist' not in cols:
        return True
    cursor.execute(f"PRAGMA foreign_key_list({table_name})")
    for fk in cursor.fetchall():
        # PRAGMA foreign_key_list columns: id, seq, table, from, to, on_update, on_delete, match
        if fk[2] == 'songs' and str(fk[6] or '').upper() != 'SET NULL':
            return True
    return False


def _init_listening_tables(cursor):
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS listening_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            song_id INTEGER,
            user_id INTEGER,
            seconds_listened REAL,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            song_title TEXT DEFAULT '',
            song_artist TEXT DEFAULT '',
            FOREIGN KEY (song_id) REFERENCES songs (id) ON DELETE SET NULL,
            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        )
    ''')

    cursor.execute("PRAGMA table_info(listening_logs)")
    log_cols = [col[1] for col in cursor.fetchall()]
    if 'user_id' not in log_cols:
        cursor.execute("ALTER TABLE listening_logs ADD COLUMN user_id INTEGER DEFAULT 1")
        cursor.execute("UPDATE listening_logs SET user_id = 1 WHERE user_id IS NULL")

    if _table_needs_song_set_null_migration(cursor, 'listening_logs'):
        has_title = 'song_title' in log_cols
        has_artist = 'song_artist' in log_cols
        title_expr = "COALESCE(NULLIF(l.song_title, ''), s.title, '')" if has_title else "COALESCE(s.title, '')"
        artist_expr = "COALESCE(NULLIF(l.song_artist, ''), s.artist, '')" if has_artist else "COALESCE(s.artist, '')"
        cursor.execute('DROP TABLE IF EXISTS listening_logs_new')
        cursor.execute('''
            CREATE TABLE listening_logs_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                song_id INTEGER,
                user_id INTEGER,
                seconds_listened REAL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                song_title TEXT DEFAULT '',
                song_artist TEXT DEFAULT '',
                FOREIGN KEY (song_id) REFERENCES songs (id) ON DELETE SET NULL,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            )
        ''')
        cursor.execute(f'''
            INSERT INTO listening_logs_new (id, song_id, user_id, seconds_listened, timestamp, song_title, song_artist)
            SELECT l.id, s.id, u.id, l.seconds_listened, l.timestamp, {title_expr}, {artist_expr}
            FROM listening_logs l
            LEFT JOIN songs s ON l.song_id = s.id
            INNER JOIN users u ON l.user_id = u.id
        ''')
        cursor.execute('DROP TABLE listening_logs')
        cursor.execute('ALTER TABLE listening_logs_new RENAME TO listening_logs')

    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_listening_logs_user_timestamp
        ON listening_logs (user_id, timestamp)
    ''')
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_listening_logs_song_user
        ON listening_logs (song_id, user_id)
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS play_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            song_id INTEGER,
            user_id INTEGER NOT NULL,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            song_title TEXT DEFAULT '',
            song_artist TEXT DEFAULT '',
            FOREIGN KEY (song_id) REFERENCES songs (id) ON DELETE SET NULL,
            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        )
    ''')

    if _table_needs_song_set_null_migration(cursor, 'play_events'):
        cursor.execute("PRAGMA table_info(play_events)")
        pe_cols = [col[1] for col in cursor.fetchall()]
        has_title = 'song_title' in pe_cols
        has_artist = 'song_artist' in pe_cols
        title_expr = "COALESCE(NULLIF(pe.song_title, ''), s.title, '')" if has_title else "COALESCE(s.title, '')"
        artist_expr = "COALESCE(NULLIF(pe.song_artist, ''), s.artist, '')" if has_artist else "COALESCE(s.artist, '')"
        cursor.execute('DROP TABLE IF EXISTS play_events_new')
        cursor.execute('''
            CREATE TABLE play_events_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                song_id INTEGER,
                user_id INTEGER NOT NULL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                song_title TEXT DEFAULT '',
                song_artist TEXT DEFAULT '',
                FOREIGN KEY (song_id) REFERENCES songs (id) ON DELETE SET NULL,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            )
        ''')
        cursor.execute(f'''
            INSERT INTO play_events_new (id, song_id, user_id, timestamp, song_title, song_artist)
            SELECT pe.id, s.id, u.id, pe.timestamp, {title_expr}, {artist_expr}
            FROM play_events pe
            LEFT JOIN songs s ON pe.song_id = s.id
            INNER JOIN users u ON pe.user_id = u.id
        ''')
        cursor.execute('DROP TABLE play_events')
        cursor.execute('ALTER TABLE play_events_new RENAME TO play_events')

    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_play_events_user_timestamp
        ON play_events (user_id, timestamp)
    ''')
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_play_events_song_user
        ON play_events (song_id, user_id)
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS playback_sessions (
            id TEXT PRIMARY KEY,
            song_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            duration_seconds REAL,
            seconds_listened REAL NOT NULL DEFAULT 0,
            started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (song_id) REFERENCES songs (id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        )
    ''')
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_playback_sessions_user_song
        ON playback_sessions (user_id, song_id)
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS listening_receipts (
            user_id INTEGER NOT NULL,
            event_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            seconds REAL NOT NULL,
            PRIMARY KEY (user_id, event_id),
            FOREIGN KEY (session_id) REFERENCES playback_sessions (id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        )
    ''')


def _init_settings_and_jobs_tables(cursor):
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS user_playback_state (
            user_id INTEGER PRIMARY KEY,
            state_json TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS user_settings (
            user_id INTEGER PRIMARY KEY,
            theme_json TEXT DEFAULT '',
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS download_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            url TEXT NOT NULL,
            playlist_ids TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'processing', 'completed', 'failed')),
            error TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        )
    ''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_download_jobs_status ON download_jobs (status)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_download_jobs_user_status ON download_jobs (user_id, status)')

    cursor.execute('''
        SELECT 1
        FROM songs
        WHERE source_id IS NOT NULL AND source_id != ''
        GROUP BY user_id, source_id
        HAVING COUNT(*) > 1
        LIMIT 1
    ''')
    duplicate_source = cursor.fetchone()
    if not duplicate_source:
        cursor.execute('''
            CREATE UNIQUE INDEX IF NOT EXISTS idx_songs_user_source_unique
            ON songs (user_id, source_id)
            WHERE source_id IS NOT NULL AND source_id != ''
        ''')


def init_db(db_path):
    """Initialize database with all required tables and migrations."""
    conn = get_db_connection(db_path)
    try:
        cursor = conn.cursor()
        _init_users_and_sessions_tables(cursor)
        _init_playlists_and_songs_tables(cursor)
        _init_listening_tables(cursor)
        _init_settings_and_jobs_tables(cursor)
        conn.commit()
    finally:
        conn.close()


# ==========================================
# USER OPERATIONS
# ==========================================
def get_user_by_id(db_path, user_id):
    """Get user by id"""
    conn = get_db_connection(db_path)
    try:
        return conn.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
    finally:
        conn.close()


def get_user_by_username(db_path, username):
    """Get user by username"""
    conn = get_db_connection(db_path)
    try:
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM users WHERE username = ?', (username,))
        return cursor.fetchone()
    finally:
        conn.close()


def create_user(db_path, username, password, role='user'):
    """
    Create a new user with specified role.
    
    Args:
        db_path: Path to database file
        username: Username (must be unique)
        password: Plain text password (will be hashed)
        role: User role ('user' or 'admin', default: 'user')
    
    Returns:
        user_id (int) if successful, None if username already exists
    """
    if role not in ('user', 'admin'):
        raise ValueError(f"Invalid role: {role}. Must be 'user' or 'admin'")
    
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    
    # Hash password dengan PBKDF2-SHA256
    password_hash = generate_password_hash(password, method='pbkdf2:sha256', salt_length=16)
    session_token = secrets.token_hex(16)
    
    try:
        cursor.execute(
            'INSERT INTO users (username, password_hash, role, session_token) VALUES (?, ?, ?, ?)',
            (username, password_hash, role, session_token)
        )
        conn.commit()
        user_id = cursor.lastrowid
        return user_id
    except sqlite3.IntegrityError:
        return None
    finally:
        conn.close()


def create_initial_admin(db_path, username, password):
    """Atomically create the first admin user only if no users exist (prevents TOCTOU)."""
    conn = get_db_connection(db_path)
    password_hash = generate_password_hash(password, method='pbkdf2:sha256', salt_length=16)
    session_token = secrets.token_hex(16)
    try:
        conn.execute('BEGIN IMMEDIATE')
        count = conn.execute('SELECT COUNT(*) FROM users').fetchone()[0]
        if count > 0:
            conn.rollback()
            return None, 'exists'
        cursor = conn.execute(
            'INSERT INTO users (username, password_hash, role, session_token) VALUES (?, ?, ?, ?)',
            (username, password_hash, 'admin', session_token)
        )
        conn.commit()
        return cursor.lastrowid, None
    except sqlite3.IntegrityError:
        conn.rollback()
        return None, 'taken'
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def has_any_user(db_path):
    """Check if there are any users in the database"""
    conn = get_db_connection(db_path)
    try:
        cursor = conn.cursor()
        cursor.execute('SELECT COUNT(*) as count FROM users')
        return cursor.fetchone()['count'] > 0
    finally:
        conn.close()


def get_all_users(database_path):
    """Get all users with stats (playlists & songs count)"""
    conn = get_db_connection(database_path)
    try:
        cursor = conn.cursor()
        cursor.execute('''
            SELECT 
                u.id, 
                u.username, 
                u.role,
                u.created_at,
                (SELECT COUNT(*) FROM playlists p WHERE p.user_id = u.id) as playlist_count,
                (SELECT COUNT(*) FROM songs s WHERE s.user_id = u.id) as song_count
            FROM users u
            ORDER BY u.id ASC
        ''')
        return [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def get_user_files(database_path, user_id):
    """Get all files (audio, album art, playlist cover art) owned by a user"""
    conn = get_db_connection(database_path)
    try:
        cursor = conn.cursor()
        cursor.execute('SELECT filename, album_art FROM songs WHERE user_id = ?', (user_id,))
        files = [{'filename': row['filename'], 'album_art': row['album_art'], 'cover_art': None} for row in cursor.fetchall()]
        cursor.execute("SELECT cover_art FROM playlists WHERE user_id = ? AND cover_art IS NOT NULL AND cover_art != ''", (user_id,))
        for row in cursor.fetchall():
            if row['cover_art']:
                files.append({'filename': None, 'album_art': None, 'cover_art': row['cover_art']})
        return files
    finally:
        conn.close()


def delete_user_cascade(database_path, user_id):
    """Delete user and all related data (playlists, songs, logs).

    Returns:
        'deleted' if user existed and was removed,
        'not_found' if user_id does not exist,
        'error' on unexpected database failure.
    """
    conn = get_db_connection(database_path)
    try:
        cursor = conn.cursor()
        # Delete in correct order due to foreign keys
        cursor.execute('DELETE FROM listening_logs WHERE user_id = ?', (user_id,))
        cursor.execute('DELETE FROM play_events WHERE user_id = ?', (user_id,))
        cursor.execute('''
            DELETE FROM playlist_songs 
            WHERE playlist_id IN (SELECT id FROM playlists WHERE user_id = ?)
        ''', (user_id,))
        cursor.execute('DELETE FROM playlists WHERE user_id = ?', (user_id,))
        cursor.execute('DELETE FROM songs WHERE user_id = ?', (user_id,))
        cursor.execute('DELETE FROM user_sessions WHERE user_id = ?', (user_id,))
        cursor.execute('DELETE FROM users WHERE id = ?', (user_id,))
        if cursor.rowcount == 0:
            conn.rollback()
            return 'not_found'
        conn.commit()
        return 'deleted'
    except Exception as e:
        conn.rollback()
        logger.error("delete_user_cascade: %s", e)
        return 'error'
    finally:
        conn.close()


def create_user_session(database_path, user_id):
    """Create a per-device session token for server-side logout revocation."""
    token = secrets.token_hex(24)
    conn = get_db_connection(database_path)
    try:
        conn.execute(
            'INSERT INTO user_sessions (token, user_id) VALUES (?, ?)',
            (token, user_id),
        )
        conn.commit()
        return token
    finally:
        conn.close()


def validate_user_session(conn, user_id, device_token):
    """Return True if device_token belongs to an active session for user_id."""
    if not device_token:
        return False
    row = conn.execute(
        'SELECT 1 FROM user_sessions WHERE token = ? AND user_id = ?',
        (device_token, user_id),
    ).fetchone()
    return row is not None


def revoke_user_session(database_path, user_id, device_token):
    """Revoke a single device session on logout."""
    if not device_token:
        return False
    conn = get_db_connection(database_path)
    try:
        cursor = conn.cursor()
        cursor.execute(
            'DELETE FROM user_sessions WHERE token = ? AND user_id = ?',
            (device_token, user_id),
        )
        conn.commit()
        return cursor.rowcount > 0
    finally:
        conn.close()


def revoke_all_user_sessions(database_path, user_id):
    """Rotate user session_token and remove all active device sessions."""
    conn = get_db_connection(database_path)
    try:
        new_session_token = secrets.token_hex(16)
        cursor = conn.cursor()
        cursor.execute(
            'UPDATE users SET session_token = ? WHERE id = ?',
            (new_session_token, user_id),
        )
        cursor.execute('DELETE FROM user_sessions WHERE user_id = ?', (user_id,))
        conn.commit()
        return cursor.rowcount >= 0
    finally:
        conn.close()


def update_user_password(database_path, user_id, new_password):
    """
    Update user password.
    
    Args:
        database_path: Path to database file
        user_id: ID of user to update
        new_password: Plain text new password (will be hashed)
    
    Returns:
        True if successful, False if user not found
    """
    conn = get_db_connection(database_path)
    try:
        new_hash = generate_password_hash(new_password, method='pbkdf2:sha256', salt_length=16)
        new_session_token = secrets.token_hex(16)
        cursor = conn.cursor()
        cursor.execute(
            'UPDATE users SET password_hash = ?, session_token = ? WHERE id = ?',
            (new_hash, new_session_token, user_id)
        )
        updated = cursor.rowcount > 0
        if updated:
            cursor.execute('DELETE FROM user_sessions WHERE user_id = ?', (user_id,))
        conn.commit()
        return updated
    finally:
        conn.close()




def update_user_role(database_path, user_id, new_role):
    """
    Update user role.
    
    Args:
        database_path: Path to database file
        user_id: ID of user to update
        new_role: New role ('user' or 'admin')
    
    Returns:
        True if successful, False if user not found
    
    Raises:
        ValueError: If role is invalid
    """
    if new_role not in ('user', 'admin'):
        raise ValueError(f"Invalid role: {new_role}. Must be 'user' or 'admin'")
    
    conn = get_db_connection(database_path)
    try:
        cursor = conn.cursor()
        cursor.execute(
            'UPDATE users SET role = ? WHERE id = ?',
            (new_role, user_id)
        )
        conn.commit()
        return cursor.rowcount > 0
    finally:
        conn.close()




def update_song_lyrics(database_path, song_id, lyrics, synced_lyrics, word_synced_lyrics='', status='found'):
    conn = get_db_connection(database_path)
    try:
        cursor = conn.cursor()
        cursor.execute(
            '''
            UPDATE songs
            SET lyrics = ?, synced_lyrics = ?, word_synced_lyrics = ?, lyrics_status = ?, lyrics_updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            ''',
            (lyrics, synced_lyrics, word_synced_lyrics, status, song_id)
        )
        cursor.execute('SELECT track_id FROM songs WHERE id = ?', (song_id,))
        trow = cursor.fetchone()
        if trow and trow['track_id']:
            track_id = trow['track_id']
            cursor.execute(
                '''
                UPDATE tracks
                SET lyrics = ?, synced_lyrics = ?, word_synced_lyrics = ?, lyrics_status = ?, lyrics_updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                ''',
                (lyrics, synced_lyrics, word_synced_lyrics, status, track_id)
            )
            if status == 'found':
                cursor.execute(
                    '''
                    UPDATE songs
                    SET lyrics = ?, synced_lyrics = ?, word_synced_lyrics = ?, lyrics_status = 'found', lyrics_updated_at = CURRENT_TIMESTAMP
                    WHERE track_id = ? AND id != ? AND lyrics_status != 'manual'
                    ''',
                    (lyrics, synced_lyrics, word_synced_lyrics, track_id, song_id)
                )
        conn.commit()
        return cursor.rowcount > 0
    finally:
        conn.close()


# ==========================================
# CROSS-DEVICE PLAYBACK & THEME STATE
# ==========================================
def get_user_playback_state(database_path, user_id):
    import json
    conn = get_db_connection(database_path)
    try:
        cursor = conn.cursor()
        cursor.execute('SELECT state_json FROM user_playback_state WHERE user_id = ?', (user_id,))
        row = cursor.fetchone()
        if row and row['state_json']:
            try:
                return json.loads(row['state_json'])
            except Exception:
                return None
        return None
    finally:
        conn.close()


def save_user_playback_state(database_path, user_id, state_dict):
    import json
    conn = get_db_connection(database_path)
    try:
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO user_playback_state (user_id, state_json, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET
                state_json = excluded.state_json,
                updated_at = CURRENT_TIMESTAMP
        ''', (user_id, json.dumps(state_dict)))
        conn.commit()
        return True
    finally:
        conn.close()


def get_user_theme(database_path, user_id):
    import json
    conn = get_db_connection(database_path)
    try:
        cursor = conn.cursor()
        cursor.execute('SELECT theme_json FROM user_settings WHERE user_id = ?', (user_id,))
        row = cursor.fetchone()
        if row and row['theme_json']:
            try:
                return json.loads(row['theme_json'])
            except Exception:
                return None
        return None
    finally:
        conn.close()


def save_user_theme(database_path, user_id, theme_dict):
    import json
    conn = get_db_connection(database_path)
    try:
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO user_settings (user_id, theme_json, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET
                theme_json = excluded.theme_json,
                updated_at = CURRENT_TIMESTAMP
        ''', (user_id, json.dumps(theme_dict)))
        conn.commit()
        return True
    finally:
        conn.close()


def run_database_maintenance(db_path):
    """Run periodic WAL checkpointing and query optimization."""
    if not db_path:
        return
    conn = None
    try:
        conn = get_db_connection(db_path)
        conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
        conn.execute("PRAGMA optimize")
    except Exception as e:
        logger.warning("Database maintenance failed: %s", e)
    finally:
        if conn is not None:
            conn.close()
