import os
import sys
import sqlite3
import time

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from services.database import get_db_connection, update_song_lyrics
from services.lyrics import search_lyrics

DATABASE_PATH = os.environ.get('PSR_FM_DATABASE_PATH', os.path.join(BASE_DIR, 'database.db', 'psr_fm.sqlite3'))


def main():
    conn = get_db_connection(DATABASE_PATH)
    cursor = conn.cursor()
    cursor.execute(
        '''
        SELECT id, title, artist, duration_seconds
        FROM songs
        WHERE COALESCE(lyrics, '') = ''
           OR COALESCE(synced_lyrics, '') = ''
        ORDER BY created_at ASC
        '''
    )
    songs = cursor.fetchall()
    conn.close()

    success = 0
    failed = 0
    for song in songs:
        try:
            lyrics_data = search_lyrics(song['title'], song['artist'], song['duration_seconds'])
            if lyrics_data:
                if update_song_lyrics(
                    DATABASE_PATH,
                    song['id'],
                    lyrics_data.get('lyrics', ''),
                    lyrics_data.get('synced_lyrics', ''),
                ):
                    success += 1
                else:
                    failed += 1
            else:
                failed += 1
        except Exception as exc:
            failed += 1
            print(f"[WARN] song {song['id']} failed: {exc}")
        time.sleep(1)

    print(f"Done. Success: {success}, Failed: {failed}, Total: {len(songs)}")


if __name__ == '__main__':
    main()
