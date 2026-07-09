import importlib
import os
import sqlite3
import sys
import tempfile
import unittest
from http.cookies import SimpleCookie
from unittest.mock import patch

from services.lyrics import clean_text, parse_lrc


class AuthAndDownloadTests(unittest.TestCase):
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

    def _create_playlist(self, user_id=1, name='Favorites'):
        conn = sqlite3.connect(self.app_module.DATABASE_PATH)
        try:
            cursor = conn.cursor()
            cursor.execute(
                'INSERT INTO playlists (name, folder_name, user_id) VALUES (?, ?, ?)',
                (name, 'favorites', user_id),
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
    ):
        conn = sqlite3.connect(self.app_module.DATABASE_PATH)
        try:
            cursor = conn.cursor()
            cursor.execute(
                '''
                INSERT INTO songs (title, artist, filename, duration_seconds, source_url, source_id, user_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ''',
                (title, artist, filename, duration_seconds, source_url, source_id, user_id),
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

    def test_setup_and_login_flow(self):
        client = self.app_module.app.test_client()

        setup_response = client.post('/api/setup', json={
            'username': 'admin',
            'password': 'secret123',
        })
        self.assertEqual(setup_response.status_code, 200)

        me_response = client.get('/api/me')
        self.assertEqual(me_response.status_code, 200)
        self.assertTrue(me_response.get_json()['can_add_users'])

        csrf_token = self._csrf_token_from_response(setup_response)
        logout_response = client.post('/api/logout', headers={'X-CSRF-Token': csrf_token})
        self.assertEqual(logout_response.status_code, 200)

        login_response = client.post('/api/login', json={
            'username': 'admin',
            'password': 'secret123',
        })
        self.assertEqual(login_response.status_code, 200)
        self.assertEqual(login_response.get_json()['username'], 'admin')

    def test_login_rate_limit_blocks_repeated_failures(self):
        client = self.app_module.app.test_client()
        client.post('/api/setup', json={
            'username': 'admin',
            'password': 'secret123',
        })

        for _ in range(self.app_module.LOGIN_RATE_LIMIT_MAX_ATTEMPTS):
            response = client.post('/api/login', json={
                'username': 'admin',
                'password': 'wrong-password',
            })
            self.assertEqual(response.status_code, 401)

        limited_response = client.post('/api/login', json={
            'username': 'admin',
            'password': 'wrong-password',
        })

        self.assertEqual(limited_response.status_code, 429)
        self.assertIn('retry_after', limited_response.get_json())

    def test_download_rejects_non_youtube_urls(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_token = self._csrf_token_from_response(setup_response)
        playlist_id = self._create_playlist()

        response = client.post(
            '/api/download',
            headers={'X-CSRF-Token': csrf_token},
            json={'url': 'https://example.com/video', 'playlist_ids': [playlist_id]},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn('Only YouTube URLs are allowed', response.get_json()['error'])

    def test_download_enqueues_valid_youtube_url(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_token = self._csrf_token_from_response(setup_response)
        playlist_id = self._create_playlist()

        captured_tasks = []
        with patch.object(self.app_module.download_queue, 'put', side_effect=lambda task: captured_tasks.append(task)):
            response = client.post(
                '/api/download',
                headers={'X-CSRF-Token': csrf_token},
                json={
                    'url': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                    'playlist_ids': [playlist_id],
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['status'], 'processing')
        self.assertEqual(len(captured_tasks), 1)
        self.assertEqual(captured_tasks[0]['playlist_ids'], [playlist_id])
        self.assertEqual(captured_tasks[0]['user_id'], 1)
        self.assertEqual(captured_tasks[0]['url'], 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')

    def test_download_existing_library_song_adds_without_queueing(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_token = self._csrf_token_from_response(setup_response)
        playlist_id = self._create_playlist()
        self._create_song(
            user_id=2,
            title='Shared Track',
            artist='Shared Artist',
            filename='shared-track.mp3',
            source_url='https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            source_id='dQw4w9WgXcQ',
        )

        with patch.object(self.app_module.download_queue, 'put') as queue_put:
            response = client.post(
                '/api/download',
                headers={'X-CSRF-Token': csrf_token},
                json={
                    'url': 'https://youtu.be/dQw4w9WgXcQ',
                    'playlist_ids': [playlist_id],
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['status'], 'added_from_library')
        queue_put.assert_not_called()

        songs_response = client.get(f'/api/songs?playlist_id={playlist_id}')
        self.assertEqual(songs_response.status_code, 200)
        songs = songs_response.get_json()
        self.assertEqual(len(songs), 1)
        self.assertEqual(songs[0]['title'], 'Shared Track')

    def test_library_song_can_be_added_to_current_user_playlist(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_token = self._csrf_token_from_response(setup_response)
        playlist_id = self._create_playlist()
        source_song_id = self._create_song(
            user_id=2,
            title='Library Track',
            artist='Library Artist',
            filename='library-track.mp3',
            source_url='https://www.youtube.com/watch?v=abc12345678',
            source_id='abc12345678',
        )

        library_response = client.get('/api/library-songs')
        self.assertEqual(library_response.status_code, 200)
        self.assertEqual(library_response.get_json()[0]['id'], source_song_id)

        add_response = client.post(
            f'/api/library-songs/{source_song_id}/add',
            headers={'X-CSRF-Token': csrf_token},
            json={'playlist_ids': [playlist_id]},
        )
        self.assertEqual(add_response.status_code, 200)
        self.assertTrue(add_response.get_json()['created'])

        songs_response = client.get(f'/api/songs?playlist_id={playlist_id}')
        self.assertEqual(songs_response.status_code, 200)
        self.assertEqual(songs_response.get_json()[0]['source_id'], 'abc12345678')

    def test_owned_song_can_be_added_to_another_playlist(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_token = self._csrf_token_from_response(setup_response)
        playlist_a = self._create_playlist(name='A')
        playlist_b = self._create_playlist(name='B')
        song_id = self._create_song(title='Reusable Track')
        self._add_song_to_playlist(playlist_a, song_id, 0)

        add_response = client.post(
            f'/api/songs/{song_id}/playlists',
            headers={'X-CSRF-Token': csrf_token},
            json={'playlist_ids': [playlist_b]},
        )

        self.assertEqual(add_response.status_code, 200)
        self.assertEqual(add_response.get_json()['playlist_ids'], [playlist_b])

        songs_response = client.get(f'/api/songs?playlist_id={playlist_b}')
        self.assertEqual(songs_response.status_code, 200)
        self.assertEqual(songs_response.get_json()[0]['id'], song_id)

    def test_playlist_song_order_can_be_reordered(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_token = self._csrf_token_from_response(setup_response)
        playlist_id = self._create_playlist()
        song_a = self._create_song(title='A')
        song_b = self._create_song(title='B')
        song_c = self._create_song(title='C')
        self._add_song_to_playlist(playlist_id, song_a, 0)
        self._add_song_to_playlist(playlist_id, song_b, 1)
        self._add_song_to_playlist(playlist_id, song_c, 2)

        response = client.put(
            f'/api/playlists/{playlist_id}/songs/order',
            headers={'X-CSRF-Token': csrf_token},
            json={'song_ids': [song_c, song_a, song_b]},
        )
        self.assertEqual(response.status_code, 200)

        songs_response = client.get(f'/api/songs?playlist_id={playlist_id}')
        self.assertEqual(songs_response.status_code, 200)
        self.assertEqual(
            [song['id'] for song in songs_response.get_json()],
            [song_c, song_a, song_b],
        )

    def test_lyrics_helpers_parse_and_clean(self):
        self.assertEqual(clean_text('Song Title (Official Video) feat. Guest'), 'Song Title')
        parsed = parse_lrc('[00:01.00][00:03.00] Hello\n[00:05.50] World')
        self.assertEqual(len(parsed), 3)
        self.assertAlmostEqual(parsed[1]['timestamp'], 3.0, places=1)
        self.assertAlmostEqual(parsed[2]['timestamp'], 5.5, places=1)

    def test_lyrics_endpoints(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_token = self._csrf_token_from_response(setup_response)
        song_id = self._create_song()

        get_response = client.get(f'/api/songs/{song_id}/lyrics')
        self.assertEqual(get_response.status_code, 200)
        get_data = get_response.get_json()
        self.assertEqual(get_data['lyrics'], '')
        self.assertEqual(get_data['synced_lyrics'], '')
        self.assertEqual(get_data['lyrics_status'], 'none')

        with patch.object(self.app_module, 'search_lyrics', return_value={
            'lyrics': 'Plain lyrics',
            'synced_lyrics': '[00:01.00] Plain lyrics',
        }):
            post_response = client.post(
                f'/api/songs/{song_id}/lyrics',
                headers={'X-CSRF-Token': csrf_token},
            )

        self.assertEqual(post_response.status_code, 200)
        self.assertEqual(post_response.get_json()['lyrics'], 'Plain lyrics')

        refreshed = client.get(f'/api/songs/{song_id}/lyrics')
        self.assertEqual(refreshed.get_json()['lyrics'], 'Plain lyrics')
        self.assertTrue(refreshed.get_json()['synced_lyrics'].startswith('[00:01.00]'))
        self.assertEqual(refreshed.get_json()['lyrics_status'], 'found')

        manual_response = client.put(
            f'/api/songs/{song_id}/lyrics',
            headers={'X-CSRF-Token': csrf_token},
            json={
                'lyrics': 'Manual plain',
                'synced_lyrics': '[00:02.00] Manual synced',
            },
        )
        self.assertEqual(manual_response.status_code, 200)
        self.assertEqual(manual_response.get_json()['lyrics_status'], 'manual')

        manual_refreshed = client.get(f'/api/songs/{song_id}/lyrics')
        self.assertEqual(manual_refreshed.get_json()['lyrics'], 'Manual plain')
        self.assertEqual(manual_refreshed.get_json()['lyrics_status'], 'manual')

    def test_lyrics_manual_refresh_rate_limit(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_token = self._csrf_token_from_response(setup_response)
        song_id = self._create_song()

        with patch.object(self.app_module, 'search_lyrics', return_value=None):
            for _ in range(10):
                response = client.post(
                    f'/api/songs/{song_id}/lyrics',
                    headers={'X-CSRF-Token': csrf_token},
                )
                self.assertIn(response.status_code, (404, 200))

            limited_response = client.post(
                f'/api/songs/{song_id}/lyrics',
                headers={'X-CSRF-Token': csrf_token},
            )

        self.assertEqual(limited_response.status_code, 429)


if __name__ == '__main__':
    unittest.main()
