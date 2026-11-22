import sqlite3
from unittest.mock import patch
from tests.backend.base import PsrFmTestCase


class TracksDeduplicationTests(PsrFmTestCase):
    def test_track_created_automatically_on_song_insert(self):
        song_id = self._create_song(
            title='Unique Track',
            artist='Solo Artist',
            filename='unique-track.mp3',
            lyrics='Some lyrics',
            lyrics_status='found',
        )
        conn = sqlite3.connect(self.app_module.DATABASE_PATH)
        conn.row_factory = sqlite3.Row
        try:
            song = conn.execute('SELECT * FROM songs WHERE id = ?', (song_id,)).fetchone()
            self.assertIsNotNone(song['track_id'])
            track = conn.execute('SELECT * FROM tracks WHERE id = ?', (song['track_id'],)).fetchone()
            self.assertIsNotNone(track)
            self.assertEqual(track['filename'], 'unique-track.mp3')
            self.assertEqual(track['title'], 'Unique Track')
            self.assertEqual(track['artist'], 'Solo Artist')
            self.assertEqual(track['lyrics_status'], 'found')
        finally:
            conn.close()

    def test_track_deduplicated_when_multiple_users_have_same_song(self):
        # User 1 creates song
        song1_id = self._create_song(
            user_id=1,
            title='Shared Anthem',
            artist='Group',
            filename='shared-anthem.mp3',
        )
        # User 2 creates song with same filename
        song2_id = self._create_song(
            user_id=2,
            title='Shared Anthem',
            artist='Group',
            filename='shared-anthem.mp3',
        )
        conn = sqlite3.connect(self.app_module.DATABASE_PATH)
        conn.row_factory = sqlite3.Row
        try:
            song1 = conn.execute('SELECT * FROM songs WHERE id = ?', (song1_id,)).fetchone()
            song2 = conn.execute('SELECT * FROM songs WHERE id = ?', (song2_id,)).fetchone()
            self.assertEqual(song1['track_id'], song2['track_id'])

            tracks_count = conn.execute(
                'SELECT COUNT(*) FROM tracks WHERE filename = ?',
                ('shared-anthem.mp3',)
            ).fetchone()[0]
            self.assertEqual(tracks_count, 1)
        finally:
            conn.close()

    def test_public_lyrics_sync_across_users(self):
        client = self.app_module.app.test_client()
        setup_resp = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_admin = self._csrf_token_from_response(setup_resp)

        # Create user2
        user2_resp = client.post(
            '/api/users',
            headers={'X-CSRF-Token': csrf_admin},
            json={'username': 'user2', 'password': 'password123'},
        )
        user2_id = user2_resp.get_json()['user_id']

        # Both users have the same song
        song1_id = self._create_song(
            user_id=1,
            title='Synchronized Lyrics Song',
            artist='Sync Band',
            filename='sync-song.mp3',
            lyrics='',
            lyrics_status='none',
        )
        song2_id = self._create_song(
            user_id=user2_id,
            title='Synchronized Lyrics Song',
            artist='Sync Band',
            filename='sync-song.mp3',
            lyrics='',
            lyrics_status='none',
        )

        # Admin refreshes lyrics from LRCLIB
        with patch.object(self.app_module, 'search_lyrics', return_value={
            'lyrics': 'Canon lyrics',
            'synced_lyrics': '[00:01.00] Canon lyrics',
        }):
            post_resp = client.post(
                f'/api/songs/{song1_id}/lyrics',
                headers={'X-CSRF-Token': csrf_admin},
            )
            self.assertEqual(post_resp.status_code, 200)

        # Verify user 1 has found lyrics
        u1_lyrics = client.get(f'/api/songs/{song1_id}/lyrics').get_json()
        self.assertEqual(u1_lyrics['lyrics_status'], 'found')
        self.assertEqual(u1_lyrics['lyrics'], 'Canon lyrics')

        # Now login as user 2 and verify user 2 got the found lyrics
        login_u2 = client.post('/api/login', headers={'X-CSRF-Token': csrf_admin}, json={
            'username': 'user2',
            'password': 'password123',
        })
        csrf_u2 = self._csrf_token_from_response(login_u2)

        u2_lyrics = client.get(f'/api/songs/{song2_id}/lyrics').get_json()
        self.assertEqual(u2_lyrics['lyrics_status'], 'found')
        self.assertEqual(u2_lyrics['lyrics'], 'Canon lyrics')

    def test_manual_lyrics_do_not_overwrite_other_users(self):
        client = self.app_module.app.test_client()
        setup_resp = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_admin = self._csrf_token_from_response(setup_resp)

        user2_resp = client.post(
            '/api/users',
            headers={'X-CSRF-Token': csrf_admin},
            json={'username': 'user2', 'password': 'password123'},
        )
        user2_id = user2_resp.get_json()['user_id']

        song1_id = self._create_song(
            user_id=1,
            title='Shared Song',
            artist='Shared Artist',
            filename='shared-manual.mp3',
            lyrics='Original text',
            lyrics_status='found',
        )
        song2_id = self._create_song(
            user_id=user2_id,
            title='Shared Song',
            artist='Shared Artist',
            filename='shared-manual.mp3',
            lyrics='Original text',
            lyrics_status='found',
        )

        # Admin sets manual lyrics
        client.put(
            f'/api/songs/{song1_id}/lyrics',
            headers={'X-CSRF-Token': csrf_admin},
            json={'lyrics': 'Admin personal custom lyrics', 'synced_lyrics': ''},
        )

        # Login as user 2
        login_u2 = client.post('/api/login', headers={'X-CSRF-Token': csrf_admin}, json={
            'username': 'user2',
            'password': 'password123',
        })
        u2_lyrics = client.get(f'/api/songs/{song2_id}/lyrics').get_json()
        # User 2 must keep Original text, NOT admin's personal lyrics
        self.assertEqual(u2_lyrics['lyrics'], 'Original text')
        self.assertEqual(u2_lyrics['lyrics_status'], 'found')

    def test_track_retained_until_last_user_deletes(self):
        client = self.app_module.app.test_client()
        setup_resp = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_admin = self._csrf_token_from_response(setup_resp)

        user2_resp = client.post(
            '/api/users',
            headers={'X-CSRF-Token': csrf_admin},
            json={'username': 'user2', 'password': 'password123'},
        )
        user2_id = user2_resp.get_json()['user_id']

        song1_id = self._create_song(
            user_id=1,
            title='Shared Retention Song',
            artist='Retention Artist',
            filename='retention-track.mp3',
        )
        song2_id = self._create_song(
            user_id=user2_id,
            title='Shared Retention Song',
            artist='Retention Artist',
            filename='retention-track.mp3',
        )

        conn = sqlite3.connect(self.app_module.DATABASE_PATH)
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM tracks WHERE filename = ?', ('retention-track.mp3',)).fetchone()[0], 1)
        conn.close()

        # Delete user 1 song
        del_resp = client.delete(f'/api/songs/{song1_id}', headers={'X-CSRF-Token': csrf_admin})
        self.assertEqual(del_resp.status_code, 200)

        conn = sqlite3.connect(self.app_module.DATABASE_PATH)
        # Track still exists because user 2 still references it
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM tracks WHERE filename = ?', ('retention-track.mp3',)).fetchone()[0], 1)
        conn.close()

        # Login as user 2 and delete user 2 song
        login_u2 = client.post('/api/login', headers={'X-CSRF-Token': csrf_admin}, json={
            'username': 'user2',
            'password': 'password123',
        })
        csrf_u2 = self._csrf_token_from_response(login_u2)
        del_u2_resp = client.delete(f'/api/songs/{song2_id}', headers={'X-CSRF-Token': csrf_u2})
        self.assertEqual(del_u2_resp.status_code, 200)

        conn = sqlite3.connect(self.app_module.DATABASE_PATH)
        # Now track is pruned from tracks table because no users reference it
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM tracks WHERE filename = ?', ('retention-track.mp3',)).fetchone()[0], 0)
        conn.close()
