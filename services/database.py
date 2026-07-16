import sqlite3
from urllib.parse import parse_qs, urlparse
from werkzeug.security import generate_password_hash


def extract_youtube_video_id(url):
    parsed = urlparse((url or '').strip())
    host = parsed.netloc.lower()
    if host.startswith('www.'):
        host = host[4:]

    if host == 'youtu.be':
        return parsed.path.strip('/').split('/')[0] or ''

    if host in {'youtube.com', 'm.youtube.com'}:
        if parsed.path == '/watch':
            return parse_qs(parsed.query).get('v', [''])[0]
        path_parts = [part for part in parsed.path.split('/') if part]
        if len(path_parts) >= 2 and path_parts[0] in {'shorts', 'embed', 'live'}:
            return path_parts[1]

    return ''


def get_db_connection(db_path):
    """Create a database connection with row factory and foreign keys enabled"""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(db_path):
    """Initialize database with all required tables and migrations"""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()

    # ==========================================
    # USERS TABLE (with role support)
    # ==========================================
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin')),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # Migration: add role column to existing users table
    cursor.execute("PRAGMA table_info(users)")
    user_cols = [col[1] for col in cursor.fetchall()]
    if 'role' not in user_cols:
        cursor.execute("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'")
        # Set first user as admin (backward compatibility)
        cursor.execute("UPDATE users SET role = 'admin' WHERE id = 1")

    # ==========================================
    # PLAYLISTS TABLE
    # ==========================================
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS playlists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            folder_name TEXT NOT NULL,
            cover_art TEXT DEFAULT '',
            user_id INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # Migration: add cover_art column
    cursor.execute("PRAGMA table_info(playlists)")
    playlist_cols = [col[1] for col in cursor.fetchall()]
    if 'cover_art' not in playlist_cols:
        cursor.execute("ALTER TABLE playlists ADD COLUMN cover_art TEXT DEFAULT ''")

    # Migration: add user_id column
    if 'user_id' not in playlist_cols:
        cursor.execute("ALTER TABLE playlists ADD COLUMN user_id INTEGER DEFAULT 1")
        cursor.execute("UPDATE playlists SET user_id = 1 WHERE user_id IS NULL")

    # ==========================================
    # SONGS TABLE
    # ==========================================
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS songs (
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
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # Migration: handle legacy playlist_id column (old schema)
    cursor.execute("PRAGMA table_info(songs)")
    song_cols = [col[1] for col in cursor.fetchall()]
    
    if 'playlist_id' in song_cols:
        # Create playlist_songs junction table
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
        
        # Migrate data from old schema
        cursor.execute('''
            INSERT OR IGNORE INTO playlist_songs (playlist_id, song_id, position) 
            SELECT playlist_id, id, id FROM songs WHERE playlist_id IS NOT NULL
        ''')
        
        # Recreate songs table without playlist_id
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
        # Add missing columns to existing songs table
        if 'play_count' not in song_cols:
            cursor.execute("ALTER TABLE songs ADD COLUMN play_count INTEGER DEFAULT 0")
        if 'lyrics' not in song_cols:
            cursor.execute("ALTER TABLE songs ADD COLUMN lyrics TEXT")
        if 'synced_lyrics' not in song_cols:
            cursor.execute("ALTER TABLE songs ADD COLUMN synced_lyrics TEXT")
        if 'lyrics_status' not in song_cols:
            cursor.execute("ALTER TABLE songs ADD COLUMN lyrics_status TEXT DEFAULT 'none'")
            cursor.execute(
                '''
                UPDATE songs
                SET lyrics_status = CASE
                    WHEN COALESCE(lyrics, '') != '' OR COALESCE(synced_lyrics, '') != '' THEN 'found'
                    ELSE 'none'
                END
                WHERE lyrics_status IS NULL OR lyrics_status = ''
                '''
            )
        if 'lyrics_updated_at' not in song_cols:
            cursor.execute("ALTER TABLE songs ADD COLUMN lyrics_updated_at TIMESTAMP")
        if 'source_url' not in song_cols:
            cursor.execute("ALTER TABLE songs ADD COLUMN source_url TEXT")
        if 'source_id' not in song_cols:
            cursor.execute("ALTER TABLE songs ADD COLUMN source_id TEXT")
        if 'user_id' not in song_cols:
            cursor.execute("ALTER TABLE songs ADD COLUMN user_id INTEGER DEFAULT 1")
            cursor.execute("UPDATE songs SET user_id = 1 WHERE user_id IS NULL")

    cursor.execute(
        '''
        SELECT id, source_url FROM songs
        WHERE (source_id IS NULL OR source_id = '')
          AND source_url IS NOT NULL
          AND source_url != ''
        '''
    )
    for row in cursor.fetchall():
        source_id = extract_youtube_video_id(row['source_url'])
        if source_id:
            cursor.execute(
                'UPDATE songs SET source_id = ? WHERE id = ?',
                (source_id, row['id'])
            )

    # ==========================================
    # PLAYLIST_SONGS JUNCTION TABLE (Many-to-Many)
    # ==========================================
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
        cursor.execute(
            '''
            SELECT song_id FROM playlist_songs
            WHERE playlist_id = ?
            ORDER BY position ASC, added_at ASC, song_id ASC
            ''',
            (playlist_id,)
        )
        for index, row in enumerate(cursor.fetchall()):
            cursor.execute(
                'UPDATE playlist_songs SET position = ? WHERE playlist_id = ? AND song_id = ?',
                (index, playlist_id, row['song_id'])
            )

    # ==========================================
    # LISTENING LOGS TABLE
    # ==========================================
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS listening_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            song_id INTEGER,
            user_id INTEGER,
            seconds_listened REAL,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # Migration: add user_id to listening_logs
    cursor.execute("PRAGMA table_info(listening_logs)")
    log_cols = [col[1] for col in cursor.fetchall()]
    if 'user_id' not in log_cols:
        cursor.execute("ALTER TABLE listening_logs ADD COLUMN user_id INTEGER DEFAULT 1")
        cursor.execute("UPDATE listening_logs SET user_id = 1 WHERE user_id IS NULL")

    conn.commit()
    conn.close()


# ==========================================
# USER OPERATIONS
# ==========================================
def get_user_by_username(db_path, username):
    """Get user by username"""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM users WHERE username = ?', (username,))
    user = cursor.fetchone()
    conn.close()
    return user


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
    
    try:
        cursor.execute(
            'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
            (username, password_hash, role)
        )
        conn.commit()
        user_id = cursor.lastrowid
        return user_id
    except sqlite3.IntegrityError:
        return None
    finally:
        conn.close()


def has_any_user(db_path):
    """Check if there are any users in the database"""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    cursor.execute('SELECT COUNT(*) as count FROM users')
    count = cursor.fetchone()['count']
    conn.close()
    return count > 0


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
    """Get all files (MP3 & album art) owned by a user"""
    conn = get_db_connection(database_path)
    try:
        cursor = conn.cursor()
        cursor.execute('SELECT filename, album_art FROM songs WHERE user_id = ?', (user_id,))
        return [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def delete_user_cascade(database_path, user_id):
    """Delete user and all related data (playlists, songs, logs)"""
    conn = get_db_connection(database_path)
    try:
        cursor = conn.cursor()
        # Delete in correct order due to foreign keys
        cursor.execute('DELETE FROM listening_logs WHERE user_id = ?', (user_id,))
        cursor.execute('''
            DELETE FROM playlist_songs 
            WHERE playlist_id IN (SELECT id FROM playlists WHERE user_id = ?)
        ''', (user_id,))
        cursor.execute('DELETE FROM playlists WHERE user_id = ?', (user_id,))
        cursor.execute('DELETE FROM songs WHERE user_id = ?', (user_id,))
        cursor.execute('DELETE FROM users WHERE id = ?', (user_id,))
        conn.commit()
        return True
    except Exception as e:
        conn.rollback()
        print(f"[ERROR] delete_user_cascade: {e}")
        return False
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
        cursor = conn.cursor()
        cursor.execute(
            'UPDATE users SET password_hash = ? WHERE id = ?',
            (new_hash, user_id)
        )
        conn.commit()
        return cursor.rowcount > 0
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


def update_song_lyrics(database_path, song_id, lyrics, synced_lyrics, status='found'):
    conn = get_db_connection(database_path)
    try:
        cursor = conn.cursor()
        cursor.execute(
            '''
            UPDATE songs
            SET lyrics = ?, synced_lyrics = ?, lyrics_status = ?, lyrics_updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            ''',
            (lyrics, synced_lyrics, status, song_id)
        )
        conn.commit()
        return cursor.rowcount > 0
    finally:
        conn.close()
