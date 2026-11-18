import io
import json
import os
import sqlite3
import unittest
from contextlib import closing
from unittest.mock import patch

from tests.backend.base import PsrFmTestCase


class DownloadAndLibraryTests(PsrFmTestCase):
    def test_download_rejects_unsupported_urls(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
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
        self.assertIn('Only YouTube, YouTube Music, and Spotify', response.get_json()['error'])

    def test_download_enqueues_valid_youtube_url(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
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

    def test_download_enqueues_valid_youtube_music_url(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_token = self._csrf_token_from_response(setup_response)
        playlist_id = self._create_playlist()
        url = 'https://music.youtube.com/watch?v=dQw4w9WgXcQ'

        captured_tasks = []
        with patch.object(self.app_module.download_queue, 'put', side_effect=captured_tasks.append):
            response = client.post(
                '/api/download',
                headers={'X-CSRF-Token': csrf_token},
                json={'url': url, 'playlist_ids': [playlist_id]},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(captured_tasks[0]['url'], url)

    def test_download_enqueues_valid_spotify_track_url(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_token = self._csrf_token_from_response(setup_response)
        playlist_id = self._create_playlist()
        url = 'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b'

        captured_tasks = []
        with patch.object(self.app_module.download_queue, 'put', side_effect=captured_tasks.append):
            response = client.post(
                '/api/download',
                headers={'X-CSRF-Token': csrf_token},
                json={'url': url, 'playlist_ids': [playlist_id]},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(captured_tasks[0]['url'], url)

    def test_download_rejects_spotify_playlist_url(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_token = self._csrf_token_from_response(setup_response)
        playlist_id = self._create_playlist()

        response = client.post(
            '/api/download',
            headers={'X-CSRF-Token': csrf_token},
            json={
                'url': 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
                'playlist_ids': [playlist_id],
            },
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn('individual Spotify track', response.get_json()['error'])

    def test_download_existing_library_song_adds_without_queueing(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
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
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
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

    def test_shared_library_exposes_current_users_song_copy(self):
        client = self.app_module.app.test_client()
        client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={'username': 'psr354', 'password': 'secret123'})
        source_id = self._create_song(user_id=2, filename='psr354-shared.wav')
        owned_id = self._create_song(user_id=1, filename='psr354-shared.wav')
        external_id = self._create_song(user_id=2, filename='psr354-preview.wav')
        songs = client.get('/api/library-songs').get_json()
        shared = next(song for song in songs if song['id'] == source_id)
        preview = next(song for song in songs if song['id'] == external_id)
        self.assertEqual(shared['owned_song_id'], owned_id)
        self.assertTrue(shared['in_my_library'])
        self.assertIsNone(preview['owned_song_id'])

    def test_library_song_can_be_previewed_without_adding_to_playlist(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        self._csrf_token_from_response(setup_response)

        filename = 'library-preview-track.mp3'
        file_path = os.path.join(self.app_module.LIBRARY_DIR, filename)
        with open(file_path, 'wb') as handle:
            handle.write(b'preview-audio-bytes')

        source_song_id = self._create_song(
            user_id=2,
            title='Preview Track',
            artist='Preview Artist',
            filename=filename,
            source_url='https://www.youtube.com/watch?v=preview123',
            source_id='preview123',
        )

        response = client.get(f'/api/library-songs/{source_song_id}/stream')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, 'audio/mpeg')
        self.assertEqual(response.data, b'preview-audio-bytes')

    def test_library_pagination_rejects_invalid_values(self):
        client = self.app_module.app.test_client()
        client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={'username': 'admin', 'password': 'secret123'})

        for query in ('limit=abc', 'offset=abc', 'limit=0', 'limit=501', 'offset=-1'):
            response = client.get(f'/api/library-songs?{query}')
            self.assertEqual(response.status_code, 400)

    def test_upload_rejects_invalid_audio_and_removes_file(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={'username': 'admin', 'password': 'secret123'})
        csrf_token = self._csrf_token_from_response(setup_response)
        playlist_id = self._create_playlist()

        response = client.post(
            '/api/upload',
            headers={'X-CSRF-Token': csrf_token},
            data={
                'playlist_ids': json.dumps([playlist_id]),
                'file': (io.BytesIO(b'not-audio'), 'broken.mp3'),
            },
            content_type='multipart/form-data',
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(os.listdir(self.app_module.LIBRARY_DIR), [])

    def test_offline_audio_returns_complete_file_with_its_real_mimetype(self):
        client = self.app_module.app.test_client()
        client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })

        filename = 'offline-track.m4a'
        file_path = os.path.join(self.app_module.LIBRARY_DIR, filename)
        with open(file_path, 'wb') as handle:
            handle.write(b'complete-offline-audio')
        song_id = self._create_song(filename=filename)

        response = client.get(f'/api/songs/{song_id}/offline-audio')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, 'audio/mp4')
        self.assertEqual(response.data, b'complete-offline-audio')

    def test_persistent_download_queue_persists_and_recovers_jobs(self):
        client = self.app_module.app.test_client()
        client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={'username': 'admin', 'password': 'secret123'})

        from services.downloader import PersistentDownloadQueue
        q = PersistentDownloadQueue()
        q.init_db(self.app_module.DATABASE_PATH)
        task = {
            'user_id': 1,
            'url': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            'playlist_ids': [1, 2],
        }
        q.put(task)
        self.assertIn('job_id', task)
        job_id = task['job_id']

        from services.database import get_db_connection
        conn = get_db_connection(self.app_module.DATABASE_PATH)
        try:
            row = conn.execute("SELECT status, url FROM download_jobs WHERE id = ?", (job_id,)).fetchone()
            self.assertIsNotNone(row)
            self.assertEqual(row['status'], 'queued')
            self.assertEqual(row['url'], task['url'])
            conn.execute("UPDATE download_jobs SET status = 'processing' WHERE id = ?", (job_id,))
            conn.commit()
        finally:
            conn.close()

        q2 = PersistentDownloadQueue()
        q2.init_db(self.app_module.DATABASE_PATH)
        recovered_task = q2.get_nowait()
        self.assertEqual(recovered_task['job_id'], job_id)
        self.assertEqual(recovered_task['url'], task['url'])
        self.assertEqual(recovered_task['playlist_ids'], [1, 2])

    def test_download_song_file_preserves_audio_format_and_mimetype(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        self.assertEqual(setup_response.status_code, 200)

        library_dir = self.app_module.LIBRARY_DIR
        os.makedirs(library_dir, exist_ok=True)
        flac_path = os.path.join(library_dir, 'custom-track.flac')
        with open(flac_path, 'wb') as f:
            f.write(b'fLaCdummycontent')

        song_id = self._create_song(
            user_id=1,
            title='Flac Song',
            artist='Audiophile',
            filename='custom-track.flac',
        )

        response = client.get(f'/api/songs/{song_id}/download')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, 'audio/flac')
        content_disposition = response.headers.get('Content-Disposition', '')
        self.assertIn('Flac_Song_-_Audiophile.flac', content_disposition)

    def test_process_download_saves_word_synced_lyrics_and_not_found_status(self):
        from services import downloader
        client = self.app_module.app.test_client()
        client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        playlist_id = self._create_playlist()

        class FakeYDL:
            def __init__(self, opts):
                self.opts = opts
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def extract_info(self, url, download=False):
                return {'title': 'Song A', 'uploader': 'Artist A', 'duration': 120, 'thumbnail': '', 'webpage_url': url}
            def download(self, urls):
                target = f"{self.opts['outtmpl']}.mp3"
                with open(target, 'wb') as handle:
                    handle.write(b'ID3fake-audio')

        word_json = json.dumps([{'text': 'hello', 'start': 0.0, 'end': 1.0, 'words': [{'text': 'hello', 'start': 0.0, 'end': 1.0}]}])
        with patch.object(downloader.yt_dlp, 'YoutubeDL', FakeYDL), \
             patch.object(downloader, 'extract_duration', return_value=120), \
             patch.object(downloader, 'search_lyrics', return_value={'lyrics': 'hello', 'synced_lyrics': '[00:00.00] hello', 'word_synced_lyrics': word_json}):
            downloader.process_download(
                {'url': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'playlist_ids': [playlist_id], 'user_id': 1},
                self.app_module.DATABASE_PATH,
                self.app_module.DOWNLOAD_DIR,
                self.app_module.ALBUM_ART_DIR,
            )

        with patch.object(downloader.yt_dlp, 'YoutubeDL', FakeYDL), \
             patch.object(downloader, 'extract_duration', return_value=120), \
             patch.object(downloader, 'search_lyrics', return_value=None):
            downloader.process_download(
                {'url': 'https://www.youtube.com/watch?v=abcdefghijk', 'playlist_ids': [playlist_id], 'user_id': 1},
                self.app_module.DATABASE_PATH,
                self.app_module.DOWNLOAD_DIR,
                self.app_module.ALBUM_ART_DIR,
            )

        with closing(sqlite3.connect(self.app_module.DATABASE_PATH)) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute('SELECT lyrics_status, word_synced_lyrics FROM songs ORDER BY id').fetchall()
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['lyrics_status'], 'found')
        self.assertEqual(rows[0]['word_synced_lyrics'], word_json)
        self.assertEqual(rows[1]['lyrics_status'], 'not_found')
        self.assertEqual(rows[1]['word_synced_lyrics'], '')

    def test_downloader_noplaylist_and_thumbnail_validation(self):
        from PIL import Image
        from services import downloader

        opts = downloader.build_ytdlp_options()
        self.assertTrue(opts.get('noplaylist'))

        class FakeResp:
            def __init__(self, payload, status_code=200):
                self.status_code = status_code
                self._payload = payload

            def iter_content(self, chunk_size=65536):
                for i in range(0, len(self._payload), chunk_size):
                    yield self._payload[i:i + chunk_size]

            def close(self):
                pass

        # Untrusted host / http scheme rejected without calling requests.get
        with patch.object(downloader.requests, 'get', side_effect=AssertionError('should not fetch untrusted host')):
            self.assertEqual(
                downloader._download_and_save_thumbnail('https://example.com/bad.jpg', self.app_module.ALBUM_ART_DIR, 'bad0'),
                '',
            )
            self.assertEqual(
                downloader._download_and_save_thumbnail('http://i.ytimg.com/vi/abc/hqdefault.jpg', self.app_module.ALBUM_ART_DIR, 'http0'),
                '',
            )

        # Non-image payload from allowed host rejected
        with patch.object(downloader.requests, 'get', return_value=FakeResp(b'<svg><script>alert(1)</script></svg>')):
            self.assertEqual(
                downloader._download_and_save_thumbnail('https://i.ytimg.com/vi/abc/bad.jpg', self.app_module.ALBUM_ART_DIR, 'bad1'),
                '',
            )

        # Oversized payload rejected (> 5 MB)
        oversized = b'A' * (downloader.MAX_THUMBNAIL_BYTES + 1024)
        with patch.object(downloader.requests, 'get', return_value=FakeResp(oversized)):
            self.assertEqual(
                downloader._download_and_save_thumbnail('https://i.ytimg.com/vi/abc/big.jpg', self.app_module.ALBUM_ART_DIR, 'big1'),
                '',
            )

        # Valid PNG from allowed host re-encoded and saved
        buf = io.BytesIO()
        Image.new('RGBA', (20, 20), color=(10, 200, 120, 255)).save(buf, format='PNG')
        with patch.object(downloader.requests, 'get', return_value=FakeResp(buf.getvalue())) as mock_get:
            saved_name = downloader._download_and_save_thumbnail('https://i.ytimg.com/vi/abc/ok.png', self.app_module.ALBUM_ART_DIR, 'ok1')
        self.assertEqual(saved_name, 'ok1.png')
        self.assertTrue(os.path.exists(os.path.join(self.app_module.ALBUM_ART_DIR, saved_name)))
        self.assertFalse(mock_get.call_args.kwargs.get('allow_redirects', True))

    def test_process_download_global_deduplication_reuses_existing_file(self):
        from services import downloader

        client = self.app_module.app.test_client()
        setup_res = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf = self._csrf_token_from_response(setup_res)
        user2_res = client.post(
            '/api/users',
            headers={'X-CSRF-Token': csrf},
            json={'username': 'user2', 'password': 'password123'},
        )
        user2_id = user2_res.get_json()['user_id']

        library_dir = os.path.join(self.app_module.DOWNLOAD_DIR, 'library')
        os.makedirs(library_dir, exist_ok=True)
        existing_audio = 'shared-track.mp3'
        with open(os.path.join(library_dir, existing_audio), 'wb') as f:
            f.write(b'ID3shared-audio-bytes')

        user1_pl = self._create_playlist(user_id=1, name='Admin PL')
        user2_pl = self._create_playlist(user_id=user2_id, name='User2 PL')

        with closing(sqlite3.connect(self.app_module.DATABASE_PATH)) as conn:
            cur = conn.cursor()
            cur.execute(
                '''INSERT INTO songs (user_id, title, artist, filename, album_art, duration_seconds, source_url, source_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
                (1, 'Shared Song', 'Shared Artist', existing_audio, '', 185, 'https://www.youtube.com/watch?v=dedup123456', 'dedup123456'),
            )
            cur.execute('INSERT INTO playlist_songs (playlist_id, song_id, position) VALUES (?, ?, 0)', (user1_pl, cur.lastrowid))
            conn.commit()

        with patch.object(downloader.yt_dlp, 'YoutubeDL', side_effect=AssertionError('yt-dlp should not be called on global dedup')), \
             patch.object(downloader, 'search_lyrics', return_value=None):
            downloader.process_download(
                {
                    'url': 'https://www.youtube.com/watch?v=dedup123456',
                    'playlist_ids': [user2_pl],
                    'user_id': user2_id,
                },
                self.app_module.DATABASE_PATH,
                self.app_module.DOWNLOAD_DIR,
                self.app_module.ALBUM_ART_DIR,
            )

        with closing(sqlite3.connect(self.app_module.DATABASE_PATH)) as conn:
            conn.row_factory = sqlite3.Row
            cloned = conn.execute(
                'SELECT * FROM songs WHERE user_id = ? AND source_id = ?',
                (user2_id, 'dedup123456'),
            ).fetchone()
            link = conn.execute(
                'SELECT 1 FROM playlist_songs WHERE playlist_id = ? AND song_id = ?',
                (user2_pl, cloned['id']),
            ).fetchone()
        self.assertIsNotNone(cloned)
        self.assertEqual(cloned['filename'], existing_audio)
        self.assertEqual(cloned['title'], 'Shared Song')
        self.assertIsNotNone(link)

    def test_download_does_not_reuse_when_physical_file_missing(self):
        client = self.app_module.app.test_client()
        setup_res = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        csrf = self._csrf_token_from_response(setup_res)
        playlist_id = self._create_playlist()
        missing_song_id = self._create_song(
            user_id=2,
            title='Ghost Track',
            artist='Ghost Artist',
            filename='missing-file.mp3',
            source_url='https://www.youtube.com/watch?v=ghost123456',
            source_id='ghost123456',
            create_file=False,
        )

        check_res = client.get('/api/library-songs/check-url?url=https://www.youtube.com/watch?v=ghost123456')
        self.assertEqual(check_res.status_code, 200)
        self.assertFalse(check_res.get_json()['matched'])

        add_res = client.post(
            f'/api/library-songs/{missing_song_id}/add',
            headers={'X-CSRF-Token': csrf},
            json={'playlist_ids': [playlist_id]},
        )
        self.assertEqual(add_res.status_code, 404)

        with patch.object(self.app_module.download_queue, 'put') as queue_put:
            dl_res = client.post(
                '/api/download',
                headers={'X-CSRF-Token': csrf},
                json={'url': 'https://www.youtube.com/watch?v=ghost123456', 'playlist_ids': [playlist_id]},
            )
        self.assertEqual(dl_res.status_code, 200)
        self.assertEqual(dl_res.get_json()['status'], 'processing')
        queue_put.assert_called_once()

    def test_library_song_clone_copies_public_found_lyrics_and_dispatches_lookup_when_missing(self):
        import routes.songs as songs_routes

        client = self.app_module.app.test_client()
        setup_res = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        csrf = self._csrf_token_from_response(setup_res)
        playlist_id = self._create_playlist()

        public_song_id = self._create_song(
            user_id=2,
            title='Public Lyrics Track',
            artist='Public Artist',
            filename='public-lyrics.mp3',
            lyrics='Hello world',
            synced_lyrics='[00:01.00] Hello world',
            lyrics_status='found',
        )
        add_public = client.post(
            f'/api/library-songs/{public_song_id}/add',
            headers={'X-CSRF-Token': csrf},
            json={'playlist_ids': [playlist_id]},
        )
        self.assertEqual(add_public.status_code, 200)
        cloned_public_id = add_public.get_json()['song_id']
        lyrics_resp = client.get(f'/api/songs/{cloned_public_id}/lyrics').get_json()
        self.assertEqual(lyrics_resp['lyrics_status'], 'found')
        self.assertEqual(lyrics_resp['lyrics'], 'Hello world')

        unfetched_song_id = self._create_song(
            user_id=2,
            title='Needs Lookup',
            artist='Lookup Artist',
            filename='needs-lookup.mp3',
            lyrics_status='none',
        )
        with patch.dict(os.environ, {'PSR_FM_DISABLE_WORKER': '0'}), \
             patch.object(songs_routes, 'dispatch_lyrics_lookup') as mock_dispatch:
            add_unfetched = client.post(
                f'/api/library-songs/{unfetched_song_id}/add',
                headers={'X-CSRF-Token': csrf},
                json={'playlist_ids': [playlist_id]},
            )
        self.assertEqual(add_unfetched.status_code, 200)
        mock_dispatch.assert_called_once()

    def test_download_worker_sanitizes_unexpected_error_messages(self):
        from services import downloader

        emitted = []

        class FakeSio:
            def emit(self, event, payload, room=None):
                emitted.append((event, payload, room))

        # 1. Unexpected internal error is sanitized
        with patch.object(downloader, 'process_download', side_effect=RuntimeError('/srv/secret/internal.sqlite3 locked')):
            downloader.download_queue.put({'url': 'https://youtu.be/abc12345678', 'playlist_ids': [1], 'user_id': 7})
            downloader.download_queue.put(None)
            downloader.download_worker(self.app_module.DATABASE_PATH, self.app_module.DOWNLOAD_DIR, self.app_module.ALBUM_ART_DIR, FakeSio())

        self.assertEqual(len(emitted), 1)
        self.assertEqual(emitted[0][0], 'download_error')
        self.assertEqual(emitted[0][1]['error'], downloader.GENERIC_DOWNLOAD_ERROR)
        self.assertNotIn('/srv/secret', emitted[0][1]['error'])

        # 2. Explicit DownloadUserError message is preserved
        emitted.clear()
        with patch.object(downloader, 'process_download', side_effect=downloader.DownloadUserError('Video exceeds the 10 minute limit')):
            downloader.download_queue.put({'url': 'https://youtu.be/abc12345678', 'playlist_ids': [1], 'user_id': 7})
            downloader.download_queue.put(None)
            downloader.download_worker(self.app_module.DATABASE_PATH, self.app_module.DOWNLOAD_DIR, self.app_module.ALBUM_ART_DIR, FakeSio())

        self.assertEqual(emitted[0][1]['error'], 'Video exceeds the 10 minute limit')

    def test_youtube_channel_and_playlist_urls_rejected_and_active_job_limit(self):
        client = self.app_module.app.test_client()
        setup_res = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        csrf = self._csrf_token_from_response(setup_res)
        playlist_id = self._create_playlist()

        for bad_url in (
            'https://www.youtube.com/@somechannel',
            'https://www.youtube.com/playlist?list=PL1234567890',
            'https://music.youtube.com/browse/FEmusic_home',
        ):
            res = client.post(
                '/api/download',
                headers={'X-CSRF-Token': csrf},
                json={'url': bad_url, 'playlist_ids': [playlist_id]},
            )
            self.assertEqual(res.status_code, 400, f'Expected 400 for {bad_url}')

        # Active download jobs cap per user
        with closing(sqlite3.connect(self.app_module.DATABASE_PATH)) as conn:
            conn.executemany(
                "INSERT INTO download_jobs (user_id, url, playlist_ids, status) VALUES (?, ?, ?, ?)",
                [
                    (1, 'https://youtu.be/aaaaaaaaaaa', '[1]', 'queued'),
                    (1, 'https://youtu.be/bbbbbbbbbbb', '[1]', 'processing'),
                ],
            )
            conn.commit()
        with patch.dict(os.environ, {'PSR_FM_MAX_ACTIVE_DOWNLOADS_PER_USER': '2'}):
            blocked = client.post(
                '/api/download',
                headers={'X-CSRF-Token': csrf},
                json={'url': 'https://youtu.be/ccccccccccc', 'playlist_ids': [playlist_id]},
            )
        self.assertEqual(blocked.status_code, 429)

    def test_upload_quota_metadata_validation_and_symbol_title_fallback(self):
        import wave

        client = self.app_module.app.test_client()
        setup_res = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        csrf = self._csrf_token_from_response(setup_res)
        playlist_id = self._create_playlist()

        wav_buf = io.BytesIO()
        with wave.open(wav_buf, 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(8000)
            wf.writeframes(b'\x00\x00' * 8000)
        wav_bytes = wav_buf.getvalue()

        # Oversized title rejected
        long_res = client.post(
            '/api/upload',
            headers={'X-CSRF-Token': csrf},
            data={
                'file': (io.BytesIO(wav_bytes), 'track.wav'),
                'title': 'X' * 201,
                'playlist_ids': json.dumps([playlist_id]),
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(long_res.status_code, 400)

        # Symbol-only filename falls back to 'Untitled'
        sym_res = client.post(
            '/api/upload',
            headers={'X-CSRF-Token': csrf},
            data={
                'file': (io.BytesIO(wav_bytes), '---.wav'),
                'playlist_ids': json.dumps([playlist_id]),
            },
            content_type='multipart/form-data',
        )
        self.assertEqual(sym_res.status_code, 201)
        self.assertEqual(sym_res.get_json()['title'], 'Untitled')

        # Storage quota exceeded returns 413
        with patch('routes.songs._user_storage_quota_bytes', return_value=10):
            quota_res = client.post(
                '/api/upload',
                headers={'X-CSRF-Token': csrf},
                data={
                    'file': (io.BytesIO(wav_bytes), 'over.wav'),
                    'playlist_ids': json.dumps([playlist_id]),
                },
                content_type='multipart/form-data',
            )
        self.assertEqual(quota_res.status_code, 413)

    def test_worker_reuse_recovers_missing_file_and_scans_all_global_candidates(self):
        from services import downloader

        client = self.app_module.app.test_client()
        setup_res = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        csrf = self._csrf_token_from_response(setup_res)
        u2_id = client.post('/api/users', headers={'X-CSRF-Token': csrf}, json={
            'username': 'user2', 'password': 'password123'
        }).get_json()['user_id']
        u3_id = client.post('/api/users', headers={'X-CSRF-Token': csrf}, json={
            'username': 'user3', 'password': 'password123'
        }).get_json()['user_id']

        pl1 = self._create_playlist(user_id=1, name='P1')
        # First row (user 1) has missing file; second row (user 2) also missing; third row (user 3) has valid file + public lyrics
        self._create_song(user_id=1, filename='missing1.mp3', source_id='scan1234567', create_file=False)
        self._create_song(user_id=u2_id, filename='missing2.mp3', source_id='scan1234567', create_file=False)
        self._create_song(
            user_id=u3_id,
            filename='valid3.mp3',
            source_id='scan1234567',
            lyrics='Public found lyrics',
            lyrics_status='found',
            create_file=True,
        )

        reused = downloader._reuse_existing_song_by_source_id(
            self.app_module.DATABASE_PATH,
            self.app_module.LIBRARY_DIR,
            1,
            'scan1234567',
            'https://youtu.be/scan1234567',
            [pl1],
        )
        self.assertTrue(reused)
        with closing(sqlite3.connect(self.app_module.DATABASE_PATH)) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute('SELECT filename FROM songs WHERE user_id = 1 AND source_id = ?', ('scan1234567',)).fetchone()
        self.assertEqual(row['filename'], 'valid3.mp3')

    def test_songs_and_search_do_not_overfetch_lyrics_columns_and_backfill_spotify(self):
        from scripts.backfill_song_sources import backfill_sources

        client = self.app_module.app.test_client()
        client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        pl = self._create_playlist(user_id=1, name='Mix')
        sid = self._create_song(
            user_id=1,
            title='Heavy Lyrics Song',
            artist='Singer',
            filename='heavy.mp3',
            lyrics='A' * 5000,
            synced_lyrics='[00:01.00] A',
            lyrics_status='found',
            source_url='https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
            source_id='',
        )
        self._add_song_to_playlist(pl, sid)

        for url in ('/api/songs', f'/api/songs?playlist_id={pl}', '/api/search?q=Heavy'):
            items = client.get(url).get_json()
            self.assertEqual(len(items), 1)
            for forbidden in ('lyrics', 'synced_lyrics', 'word_synced_lyrics'):
                self.assertNotIn(forbidden, items[0], f'{url} over-fetched {forbidden}')

        # Backfill recognizes Spotify URL and skips IntegrityError duplicates
        self._create_song(
            user_id=1,
            title='Duplicate Spotify',
            artist='Singer',
            filename='heavy2.mp3',
            source_url='https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
            source_id='',
        )
        updated, skipped, failed, scanned = backfill_sources(self.app_module.DATABASE_PATH, dry_run=False)
        self.assertEqual(updated, 1)
        self.assertEqual(skipped, 1)
        self.assertEqual(failed, 0)
        with closing(sqlite3.connect(self.app_module.DATABASE_PATH)) as conn:
            val = conn.execute('SELECT source_id FROM songs WHERE id = ?', (sid,)).fetchone()[0]
        self.assertEqual(val, 'spotify:4cOdK2wGLETKBW3PvgPWqT')


if __name__ == '__main__':
    unittest.main()
