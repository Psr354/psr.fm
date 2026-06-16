import sqlite3
from werkzeug.security import generate_password_hash

def get_db_connection(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

def init_db(db_path):
    conn = get_db_connection(db_path)
    cursor = conn.cursor()

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

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
    
    cursor.execute("PRAGMA table_info(playlists)")
    columns = [col[1] for col in cursor.fetchall()]
    if 'cover_art' not in columns:
        cursor.execute("ALTER TABLE playlists ADD COLUMN cover_art TEXT DEFAULT ''")

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS songs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            artist TEXT,
            filename TEXT NOT NULL,
            album_art TEXT,
            duration_seconds INTEGER,
            play_count INTEGER DEFAULT 0,
            user_id INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    cursor.execute("PRAGMA table_info(songs)")
    song_cols = [col[1] for col in cursor.fetchall()]
    if 'playlist_id' in song_cols:
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS playlist_songs (
                playlist_id INTEGER, song_id INTEGER, added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (playlist_id, song_id)
            )
        ''')
        cursor.execute('INSERT OR IGNORE INTO playlist_songs (playlist_id, song_id) SELECT playlist_id, id FROM songs WHERE playlist_id IS NOT NULL')
        cursor.execute('''
            CREATE TABLE songs_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, artist TEXT, filename TEXT NOT NULL,
                album_art TEXT, duration_seconds INTEGER, play_count INTEGER DEFAULT 0,
                user_id INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        cursor.execute('INSERT INTO songs_new SELECT id, title, artist, filename, album_art, duration_seconds, COALESCE(play_count, 0), 1, created_at FROM songs')
        cursor.execute('DROP TABLE songs')
        cursor.execute('ALTER TABLE songs_new RENAME TO songs')
    else:
        if 'play_count' not in song_cols:
            cursor.execute("ALTER TABLE songs ADD COLUMN play_count INTEGER DEFAULT 0")
        if 'user_id' not in song_cols:
            cursor.execute("ALTER TABLE songs ADD COLUMN user_id INTEGER DEFAULT 1")
            cursor.execute("UPDATE songs SET user_id = 1 WHERE user_id IS NULL")

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS playlist_songs (
            playlist_id INTEGER, song_id INTEGER, added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (playlist_id, song_id),
            FOREIGN KEY (playlist_id) REFERENCES playlists (id) ON DELETE CASCADE,
            FOREIGN KEY (song_id) REFERENCES songs (id) ON DELETE CASCADE
        )
    ''')
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS listening_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, song_id INTEGER, user_id INTEGER,
            seconds_listened REAL, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    cursor.execute("PRAGMA table_info(playlists)")
    playlist_cols = [col[1] for col in cursor.fetchall()]
    if 'user_id' not in playlist_cols:
        cursor.execute("ALTER TABLE playlists ADD COLUMN user_id INTEGER DEFAULT 1")
        cursor.execute("UPDATE playlists SET user_id = 1 WHERE user_id IS NULL")

    cursor.execute("PRAGMA table_info(listening_logs)")
    log_cols = [col[1] for col in cursor.fetchall()]
    if 'user_id' not in log_cols:
        cursor.execute("ALTER TABLE listening_logs ADD COLUMN user_id INTEGER DEFAULT 1")
        cursor.execute("UPDATE listening_logs SET user_id = 1 WHERE user_id IS NULL")
    
    conn.commit()
    conn.close()

def get_user_by_username(db_path, username):
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM users WHERE username = ?', (username,))
    user = cursor.fetchone()
    conn.close()
    return user

def create_user(db_path, username, password):
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    password_hash = generate_password_hash(password, method='pbkdf2:sha256', salt_length=16)
    try:
        cursor.execute('INSERT INTO users (username, password_hash) VALUES (?, ?)', (username, password_hash))
        conn.commit()
        user_id = cursor.lastrowid
        conn.close()
        return user_id
    except sqlite3.IntegrityError:
        conn.close()
        return None

def has_any_user(db_path):
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    cursor.execute('SELECT COUNT(*) as count FROM users')
    count = cursor.fetchone()['count']
    conn.close()
    return count > 0
