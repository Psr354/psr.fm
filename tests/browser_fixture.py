"""Temporary localhost server for browser regression checks; no production data."""
import os
import sys
import tempfile
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
temporary = tempfile.TemporaryDirectory(prefix='psr354-browser-')
root = Path(temporary.name)
os.environ.update({
    'SECRET_KEY': 'psr354-browser-test-only',
    'PSR_FM_DATABASE_PATH': str(root / 'database.sqlite3'),
    'PSR_FM_DOWNLOAD_DIR': str(root / 'downloads'),
    'PSR_FM_ALBUM_ART_DIR': str(root / 'covers'),
    'PSR_FM_DISABLE_WORKER': '1',
})
from app import app, DATABASE_PATH, LIBRARY_DIR
from services.database import create_user, get_db_connection
from werkzeug.serving import make_server
import logging

logging.getLogger('werkzeug').setLevel(logging.ERROR)
create_user(DATABASE_PATH, 'psr354', 'psr354-browser-password', role='admin')
db = get_db_connection(DATABASE_PATH)
playlist = db.execute("INSERT INTO playlists (name, folder_name, user_id) VALUES ('psr354 Browser Playlist', 'psr354-browser', 1)").lastrowid
for index, duration in enumerate((4, 4, 30), 1):
    name = f'psr354-track-{index}.wav'
    with wave.open(str(Path(LIBRARY_DIR) / name), 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b'\0\0' * (8000 * duration))
    song = db.execute(
        "INSERT INTO songs (title, artist, filename, album_art, duration_seconds, user_id, lyrics, synced_lyrics, lyrics_status) VALUES (?, 'psr354', ?, '', ?, 1, 'psr354 lyrics', '[00:00.00] psr354 lyrics', 'manual')",
        (f'psr354 Track {index}', name, duration),
    ).lastrowid
    db.execute('INSERT INTO playlist_songs (playlist_id, song_id, position) VALUES (?, ?, ?)', (playlist, song, index - 1))
db.commit()
db.close()

@app.get('/__psr354_test_stats')
def stats():
    db = get_db_connection(DATABASE_PATH)
    try:
        return {
            'songs': [dict(row) for row in db.execute('SELECT id, play_count FROM songs ORDER BY id')],
            'sessions': [dict(row) for row in db.execute('SELECT id, song_id, seconds_listened FROM playback_sessions ORDER BY started_at, rowid')],
            'seconds': db.execute('SELECT COALESCE(SUM(seconds_listened), 0) FROM listening_logs').fetchone()[0],
            'plays': db.execute('SELECT COUNT(*) FROM play_events').fetchone()[0],
        }
    finally:
        db.close()

server = make_server('127.0.0.1', 0, app, threaded=True)
print(f'http://127.0.0.1:{server.server_port}', flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
    temporary.cleanup()
