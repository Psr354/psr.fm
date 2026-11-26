import io
import os
import sqlite3
import unittest
from contextlib import closing
from unittest.mock import patch

from tests.backend.base import PsrFmTestCase


class PlaylistTests(PsrFmTestCase):
    def test_owned_song_can_be_added_to_another_playlist(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
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

    def test_delete_playlist_removes_only_orphaned_songs(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_token = self._csrf_token_from_response(setup_response)
        playlist_a = self._create_playlist(name='A')
        playlist_b = self._create_playlist(name='B')
        orphaned_song = self._create_song(title='Only in A', filename='only-a.mp3')
        shared_song = self._create_song(title='Shared', filename='shared.mp3')
        self._add_song_to_playlist(playlist_a, orphaned_song, 0)
        self._add_song_to_playlist(playlist_a, shared_song, 1)
        self._add_song_to_playlist(playlist_b, shared_song, 0)

        response = client.delete(
            f'/api/playlists/{playlist_a}',
            headers={'X-CSRF-Token': csrf_token},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['deleted_orphaned_songs'], 1)

        dashboard = client.get('/api/dashboard').get_json()
        self.assertEqual(dashboard['total_songs'], 1)
        remaining = client.get(f'/api/songs?playlist_id={playlist_b}').get_json()
        self.assertEqual([song['id'] for song in remaining], [shared_song])

    def test_delete_song_from_playlist_keeps_song_used_by_another_playlist(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_token = self._csrf_token_from_response(setup_response)
        playlist_a = self._create_playlist(name='A')
        playlist_b = self._create_playlist(name='B')
        song_id = self._create_song(title='Shared between playlists')
        self._add_song_to_playlist(playlist_a, song_id, 0)
        self._add_song_to_playlist(playlist_b, song_id, 0)

        response = client.delete(
            f'/api/songs/{song_id}?playlist_id={playlist_a}',
            headers={'X-CSRF-Token': csrf_token},
        )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.get_json()['song_deleted'])
        self.assertEqual(response.get_json()['remaining_playlist_count'], 1)
        self.assertEqual(client.get(f'/api/songs?playlist_id={playlist_a}').get_json(), [])
        remaining = client.get(f'/api/songs?playlist_id={playlist_b}').get_json()
        self.assertEqual([song['id'] for song in remaining], [song_id])

    def test_delete_song_from_its_last_playlist_deletes_song(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_token = self._csrf_token_from_response(setup_response)
        playlist_id = self._create_playlist()
        song_id = self._create_song(title='Last playlist')
        self._add_song_to_playlist(playlist_id, song_id, 0)

        response = client.delete(
            f'/api/songs/{song_id}?playlist_id={playlist_id}',
            headers={'X-CSRF-Token': csrf_token},
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()['song_deleted'])
        self.assertEqual(client.get(f'/api/songs?playlist_id={playlist_id}').get_json(), [])
        self.assertEqual(client.get('/api/dashboard').get_json()['total_songs'], 0)

    def test_playlist_song_order_can_be_reordered(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
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

    def test_delete_playlist_cleans_up_cover_art_file(self):
        from services.common import _file_cleanup_queue
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_token = self._csrf_token_from_response(setup_response)

        album_art_dir = self.app_module.ALBUM_ART_DIR
        os.makedirs(album_art_dir, exist_ok=True)
        cover_filename = 'pl_cover_999.jpg'
        cover_path = os.path.join(album_art_dir, cover_filename)
        with open(cover_path, 'wb') as f:
            f.write(b'dummy-cover-bytes')

        playlist_id = self._create_playlist(user_id=1, name='Cover Playlist', cover_art=cover_filename)

        delete_response = client.delete(
            f'/api/playlists/{playlist_id}',
            headers={'X-CSRF-Token': csrf_token},
        )
        self.assertEqual(delete_response.status_code, 200)

        _file_cleanup_queue.join()
        self.assertFalse(os.path.exists(cover_path))

    def test_init_db_skips_reordering_if_position_column_exists(self):
        from services.database import init_db, get_db_connection
        executed_queries = []
        real_conn = get_db_connection(self.app_module.DATABASE_PATH)

        class LoggingCursor:
            def __init__(self, cursor):
                self._cursor = cursor
            def execute(self, sql, params=()):
                executed_queries.append(sql)
                return self._cursor.execute(sql, params)
            def executemany(self, sql, params=()):
                executed_queries.append(sql)
                return self._cursor.executemany(sql, params)
            def fetchall(self):
                return self._cursor.fetchall()
            def fetchone(self):
                return self._cursor.fetchone()
            @property
            def lastrowid(self):
                return self._cursor.lastrowid

        class LoggingConn:
            def __init__(self, conn):
                self._conn = conn
            def cursor(self):
                return LoggingCursor(self._conn.cursor())
            def commit(self):
                return self._conn.commit()
            def close(self):
                return self._conn.close()

        with patch('services.database.get_db_connection', return_value=LoggingConn(real_conn)):
            init_db(self.app_module.DATABASE_PATH)

        self.assertFalse(any('SELECT DISTINCT playlist_id FROM playlist_songs' in q for q in executed_queries))

    def test_database_connection_uses_wal_mode_and_busy_timeout(self):
        from services.database import get_db_connection
        conn = get_db_connection(self.app_module.DATABASE_PATH)
        try:
            journal_mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
            busy_timeout = conn.execute("PRAGMA busy_timeout").fetchone()[0]
            self.assertEqual(journal_mode.lower(), 'wal')
            self.assertGreaterEqual(busy_timeout, 5000)
        finally:
            conn.close()

    def test_upload_playlist_cover_reencodes_image(self):
        client = self.app_module.app.test_client()
        setup_res = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_token = self._csrf_token_from_response(setup_res)
        playlist_id = self._create_playlist()

        from PIL import Image
        img_io = io.BytesIO()
        test_img = Image.new('RGB', (100, 100), color='blue')
        test_img.save(img_io, format='JPEG')
        img_io.seek(0)

        upload_res = client.post(
            f'/api/playlists/{playlist_id}/cover',
            headers={'X-CSRF-Token': csrf_token},
            data={'cover': (img_io, 'test_cover.jpg')},
            content_type='multipart/form-data',
        )
        self.assertEqual(upload_res.status_code, 200)
        cover_filename = upload_res.get_json()['cover_art']
        saved_cover_path = os.path.join(self.app_module.ALBUM_ART_DIR, cover_filename)
        self.assertTrue(os.path.exists(saved_cover_path))
        saved_img = Image.open(saved_cover_path)
        self.assertEqual(saved_img.format, 'JPEG')

    def test_album_art_route_serves_from_configured_album_art_dir(self):
        client = self.app_module.app.test_client()
        art_name = 'custom-runtime-cover.png'
        art_path = os.path.join(self.app_module.ALBUM_ART_DIR, art_name)
        os.makedirs(self.app_module.ALBUM_ART_DIR, exist_ok=True)
        with open(art_path, 'wb') as handle:
            handle.write(b'\x89PNG\r\n\x1a\nfake-png-bytes')

        # Unauthenticated request must be redirected to login without long-term caching
        unauth_res = client.get(f'/static/album_art/{art_name}')
        self.assertEqual(unauth_res.status_code, 302)
        self.assertIsNone(unauth_res.cache_control.max_age)

        # Authenticated request serves the file privately from ALBUM_ART_DIR
        client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        res = client.get(f'/static/album_art/{art_name}')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data, b'\x89PNG\r\n\x1a\nfake-png-bytes')
        self.assertTrue(res.cache_control.private)
        self.assertFalse(res.cache_control.public)
        self.assertEqual(res.cache_control.max_age, 31536000)
        res.close()

        health_res = client.get('/healthz')
        self.assertEqual(health_res.status_code, 200)
        self.assertEqual(health_res.get_json()['status'], 'ok')

    def test_playlist_validation_unique_cover_and_limit_validation(self):
        from PIL import Image
        client = self.app_module.app.test_client()
        setup_res = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        csrf = self._csrf_token_from_response(setup_res)

        for bad_name in ('   ', 123, ['list']):
            res = client.post('/api/playlists', headers={'X-CSRF-Token': csrf}, json={'name': bad_name})
            self.assertEqual(res.status_code, 400)

        create_res = client.post('/api/playlists', headers={'X-CSRF-Token': csrf}, json={'name': '  Road Trip  '})
        self.assertEqual(create_res.status_code, 200)
        playlist_id = create_res.get_json()['id']

        def upload_jpg(color):
            buf = io.BytesIO()
            Image.new('RGB', (32, 32), color=color).save(buf, format='JPEG')
            buf.seek(0)
            return client.post(
                f'/api/playlists/{playlist_id}/cover',
                headers={'X-CSRF-Token': csrf},
                data={'cover': (buf, 'cover.jpg')},
                content_type='multipart/form-data',
            )

        res1 = upload_jpg('red')
        res2 = upload_jpg('green')
        self.assertEqual(res1.status_code, 200)
        self.assertEqual(res2.status_code, 200)
        cover1 = res1.get_json()['cover_art']
        cover2 = res2.get_json()['cover_art']
        self.assertNotEqual(cover1, cover2)
        from services.common import _file_cleanup_queue
        _file_cleanup_queue.join()
        self.assertFalse(os.path.exists(os.path.join(self.app_module.ALBUM_ART_DIR, cover1)))
        self.assertTrue(os.path.exists(os.path.join(self.app_module.ALBUM_ART_DIR, cover2)))

        for bad_limit in ('0', '-5', '501', 'abc'):
            res = client.get(f'/api/songs?limit={bad_limit}')
            self.assertEqual(res.status_code, 400)

    def test_delete_playlist_preserves_song_art_referenced_by_other_playlist_cover_and_role_update(self):
        from services.common import _file_cleanup_queue

        client = self.app_module.app.test_client()
        setup_res = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf = self._csrf_token_from_response(setup_res)

        library_dir = os.path.join(self.app_module.DOWNLOAD_DIR, 'library')
        os.makedirs(library_dir, exist_ok=True)
        os.makedirs(self.app_module.ALBUM_ART_DIR, exist_ok=True)
        shared_art = 'shared_cover_art.jpg'
        shared_art_path = os.path.join(self.app_module.ALBUM_ART_DIR, shared_art)
        with open(shared_art_path, 'wb') as f:
            f.write(b'shared-art-bytes')
        audio_path = os.path.join(library_dir, 'orphan_song.mp3')
        with open(audio_path, 'wb') as f:
            f.write(b'audio-bytes')

        pl_to_delete = self._create_playlist(user_id=1, name='Delete Me')
        self._create_playlist(user_id=1, name='Keeps Cover', cover_art=shared_art)

        with closing(sqlite3.connect(self.app_module.DATABASE_PATH)) as conn:
            cur = conn.cursor()
            cur.execute(
                'INSERT INTO songs (user_id, title, artist, filename, album_art, duration_seconds) VALUES (?, ?, ?, ?, ?, ?)',
                (1, 'Orphan', 'Artist', 'orphan_song.mp3', shared_art, 120),
            )
            cur.execute('INSERT INTO playlist_songs (playlist_id, song_id, position) VALUES (?, ?, 0)', (pl_to_delete, cur.lastrowid))
            conn.commit()

        del_res = client.delete(f'/api/playlists/{pl_to_delete}', headers={'X-CSRF-Token': csrf})
        self.assertEqual(del_res.status_code, 200)
        _file_cleanup_queue.join()
        self.assertFalse(os.path.exists(audio_path))
        self.assertTrue(os.path.exists(shared_art_path), 'Art still referenced by playlists.cover_art must not be deleted')

        # Verify role update endpoint via update_user_role
        user2_res = client.post(
            '/api/users',
            headers={'X-CSRF-Token': csrf},
            json={'username': 'member1', 'password': 'password123'},
        )
        user2_id = user2_res.get_json()['user_id']
        role_res = client.put(
            f'/api/admin/users/{user2_id}/role',
            headers={'X-CSRF-Token': csrf},
            json={'role': 'admin'},
        )
        self.assertEqual(role_res.status_code, 200)
        with closing(sqlite3.connect(self.app_module.DATABASE_PATH)) as conn:
            role_row = conn.execute('SELECT role FROM users WHERE id = ?', (user2_id,)).fetchone()
        self.assertEqual(role_row[0], 'admin')

    def test_upload_cover_preserves_old_cover_on_db_commit_failure(self):
        from PIL import Image

        client = self.app_module.app.test_client()
        setup_res = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        csrf = self._csrf_token_from_response(setup_res)

        os.makedirs(self.app_module.ALBUM_ART_DIR, exist_ok=True)
        old_cover = 'pl_cover_1_old.png'
        old_path = os.path.join(self.app_module.ALBUM_ART_DIR, old_cover)
        with open(old_path, 'wb') as f:
            f.write(b'old-cover-bytes')
        pl_id = self._create_playlist(user_id=1, name='Cover Safe', cover_art=old_cover)

        buf = io.BytesIO()
        Image.new('RGB', (16, 16), color='blue').save(buf, format='PNG')
        buf.seek(0)

        real_get_db = self.app_module.get_db

        class FailingCommitDb:
            def __init__(self, inner):
                self._inner = inner
            def execute(self, *args, **kwargs):
                return self._inner.execute(*args, **kwargs)
            def commit(self):
                raise sqlite3.OperationalError('disk full')
            def rollback(self):
                return self._inner.rollback()

        with patch('routes.playlists.get_db', side_effect=lambda: FailingCommitDb(real_get_db())):
            res = client.post(
                f'/api/playlists/{pl_id}/cover',
                headers={'X-CSRF-Token': csrf},
                data={'cover': (buf, 'new.png')},
                content_type='multipart/form-data',
            )
        self.assertEqual(res.status_code, 500)
        self.assertTrue(os.path.exists(old_path), 'Old cover must remain intact when DB commit fails')

    def test_playlists_can_be_reordered(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf = self._csrf_token_from_response(setup_response)

        p1 = client.post('/api/playlists', headers={'X-CSRF-Token': csrf}, json={'name': 'First'}).get_json()['id']
        p2 = client.post('/api/playlists', headers={'X-CSRF-Token': csrf}, json={'name': 'Second'}).get_json()['id']
        p3 = client.post('/api/playlists', headers={'X-CSRF-Token': csrf}, json={'name': 'Third'}).get_json()['id']

        # Newly created playlists appear at the top (Third, Second, First)
        initial_ids = [p['id'] for p in client.get('/api/playlists').get_json()]
        self.assertEqual(initial_ids, [p3, p2, p1])

        # Reorder to First, Third, Second
        reorder_res = client.put(
            '/api/playlists/reorder',
            headers={'X-CSRF-Token': csrf},
            json={'playlist_ids': [p1, p3, p2]},
        )
        self.assertEqual(reorder_res.status_code, 200)
        reordered_ids = [p['id'] for p in client.get('/api/playlists').get_json()]
        self.assertEqual(reordered_ids, [p1, p3, p2])

        # Reject incomplete or duplicate playlist list
        bad_res = client.put(
            '/api/playlists/reorder',
            headers={'X-CSRF-Token': csrf},
            json={'playlist_ids': [p1, p3]},
        )
        self.assertEqual(bad_res.status_code, 400)


if __name__ == '__main__':
    unittest.main()
