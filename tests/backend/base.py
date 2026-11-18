import importlib
import os
import sqlite3
import sys
import tempfile
import unittest
from http.cookies import SimpleCookie


class PsrFmTestCase(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        base_dir = self.tempdir.name
        os.environ['SECRET_KEY'] = 'test-secret-key'
        os.environ['PSR_FM_DATABASE_PATH'] = os.path.join(base_dir, 'database.sqlite3')
        os.environ['PSR_FM_DOWNLOAD_DIR'] = os.path.join(base_dir, 'downloads')
        os.environ['PSR_FM_ALBUM_ART_DIR'] = os.path.join(base_dir, 'album_art')
        os.environ['PSR_FM_DISABLE_WORKER'] = '1'

        sys.modules.pop('app', None)
        self.app_module = importlib.import_module('app')
        self.app_module.app.config['TESTING'] = True

    def tearDown(self):
        self.tempdir.cleanup()

    def _csrf_token_from_response(self, response):
        cookie = SimpleCookie()
        for header in response.headers.getlist('Set-Cookie'):
            cookie.load(header)
        return cookie['csrf_token'].value

    def _csrf_token(self, client):
        return self._csrf_token_from_response(client.get('/login'))

    def _create_playlist(self, user_id=1, name='Favorites', cover_art=''):
        conn = sqlite3.connect(self.app_module.DATABASE_PATH)
        try:
            cursor = conn.cursor()
            cursor.execute(
                'INSERT INTO playlists (name, folder_name, user_id, cover_art) VALUES (?, ?, ?, ?)',
                (name, 'favorites', user_id, cover_art),
            )
            conn.commit()
            return cursor.lastrowid
        finally:
            conn.close()

    def _create_song(
        self,
        user_id=1,
        title='Test Track',
        artist='Test Artist',
        duration_seconds=123,
        filename='test-track.mp3',
        source_url=None,
        source_id=None,
        lyrics='',
        synced_lyrics='',
        lyrics_status='none',
        create_file=True,
    ):
        if create_file and filename:
            library_dir = self.app_module.LIBRARY_DIR
            os.makedirs(library_dir, exist_ok=True)
            fpath = os.path.join(library_dir, filename)
            if not os.path.exists(fpath):
                with open(fpath, 'wb') as handle:
                    handle.write(b'ID3test-audio')
        conn = sqlite3.connect(self.app_module.DATABASE_PATH)
        try:
            cursor = conn.cursor()
            cursor.execute(
                '''
                INSERT INTO songs (
                    title, artist, filename, duration_seconds, source_url, source_id,
                    lyrics, synced_lyrics, lyrics_status, user_id
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    title, artist, filename, duration_seconds, source_url, source_id,
                    lyrics, synced_lyrics, lyrics_status, user_id,
                ),
            )
            conn.commit()
            return cursor.lastrowid
        finally:
            conn.close()

    def _add_song_to_playlist(self, playlist_id, song_id, position=0):
        conn = sqlite3.connect(self.app_module.DATABASE_PATH)
        try:
            cursor = conn.cursor()
            cursor.execute(
                'INSERT INTO playlist_songs (playlist_id, song_id, position) VALUES (?, ?, ?)',
                (playlist_id, song_id, position),
            )
            conn.commit()
        finally:
            conn.close()
