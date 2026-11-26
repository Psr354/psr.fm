import json
import unittest
from unittest.mock import patch

from services.lyrics import clean_text, parse_lrc, _build_search_variants
from tests.backend.base import PsrFmTestCase


class LyricsAndAssetsTests(PsrFmTestCase):
    def test_lyrics_helpers_parse_and_clean(self):
        self.assertEqual(clean_text('Song Title (Official Video) feat. Guest'), 'Song Title')
        parsed = parse_lrc('[00:01.00][00:03.00] Hello\n[00:05.50] World')
        self.assertEqual(len(parsed), 3)
        self.assertAlmostEqual(parsed[1]['timestamp'], 3.0, places=1)
        self.assertAlmostEqual(parsed[2]['timestamp'], 5.5, places=1)

    def test_lyrics_variants_split_multi_artist(self):
        # A multi-artist credit must yield per-artist variants plus a
        # title-only fallback so LRCLIB (single-artist indexed) can match.
        variants = _build_search_variants('cool enough for you', 'Gerald Timotheus / Skyline')
        self.assertIn(('cool enough for you', 'Gerald Timotheus'), variants)
        self.assertIn(('cool enough for you', 'Skyline'), variants)
        self.assertIn(('cool enough for you', ''), variants)

    def test_lyrics_endpoints(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
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
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
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

    def test_manual_lyrics_survive_try_again_refresh(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_token = self._csrf_token_from_response(setup_response)
        song_id = self._create_song()

        # User writes lyrics by hand.
        client.put(
            f'/api/songs/{song_id}/lyrics',
            headers={'X-CSRF-Token': csrf_token},
            json={'lyrics': 'My hand-typed lyrics', 'synced_lyrics': ''},
        )

        # "Try again" must NOT overwrite manual lyrics, even if LRCLIB has a hit.
        with patch.object(self.app_module, 'search_lyrics', return_value={
            'lyrics': 'Remote lyrics',
            'synced_lyrics': '[00:01.00] Remote lyrics',
        }) as search_mock:
            refresh_response = client.post(
                f'/api/songs/{song_id}/lyrics',
                headers={'X-CSRF-Token': csrf_token},
            )

        search_mock.assert_not_called()
        self.assertEqual(refresh_response.status_code, 200)
        self.assertEqual(refresh_response.get_json()['lyrics'], 'My hand-typed lyrics')
        self.assertEqual(refresh_response.get_json()['lyrics_status'], 'manual')

        stored = client.get(f'/api/songs/{song_id}/lyrics').get_json()
        self.assertEqual(stored['lyrics'], 'My hand-typed lyrics')
        self.assertEqual(stored['lyrics_status'], 'manual')

    def test_added_library_song_does_not_inherit_other_users_lyrics(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_token = self._csrf_token_from_response(setup_response)
        playlist_id = self._create_playlist()
        source_song_id = self._create_song(
            user_id=2,
            title='Shared With Lyrics',
            artist='Someone Else',
            filename='shared-with-lyrics.mp3',
            source_url='https://www.youtube.com/watch?v=abc12345678',
            source_id='abc12345678',
            lyrics='Other user lyrics',
            synced_lyrics='[00:01.00] Other user lyrics',
            lyrics_status='manual',
        )

        add_response = client.post(
            f'/api/library-songs/{source_song_id}/add',
            headers={'X-CSRF-Token': csrf_token},
            json={'playlist_ids': [playlist_id]},
        )
        self.assertEqual(add_response.status_code, 200)
        new_song_id = add_response.get_json()['song_id']
        self.assertNotEqual(new_song_id, source_song_id)

        lyrics = client.get(f'/api/songs/{new_song_id}/lyrics').get_json()
        self.assertEqual(lyrics['lyrics'], '')
        self.assertEqual(lyrics['synced_lyrics'], '')
        self.assertEqual(lyrics['lyrics_status'], 'none')

    def test_lyrics_malformed_word_sync_and_invalid_json_do_not_crash(self):
        from services import lyrics as lyrics_service
        lines = lyrics_service._parse_word_synced_lyrics(json.dumps({
            'lines': [
                {'text': 'ok', 'start_ms': 'bad', 'end_ms': None, 'words': [{'text': 'ok', 'start_ms': 0, 'end_ms': 500}]}
            ]
        }))
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]['start'], 0.0)

        class BadJsonResponse:
            ok = True
            def json(self):
                raise ValueError('bad json')

        with patch.object(lyrics_service, '_throttled_request', return_value=BadJsonResponse()):
            self.assertIsNone(lyrics_service._search_lyrics_variant('Song', 'Artist', 120))

    def test_service_worker_is_served_from_root_without_http_caching(self):
        client = self.app_module.app.test_client()

        response = client.get('/service-worker.js')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, 'application/javascript')
        self.assertEqual(response.headers['Cache-Control'], 'no-cache, no-store, must-revalidate')
        self.assertEqual(response.headers['Service-Worker-Allowed'], '/')

    def test_all_static_shell_manifest_and_template_assets_resolve(self):
        import re
        client = self.app_module.app.test_client()

        # 1. Every asset listed in service-worker SHELL_FILES must return 200
        sw_res = client.get('/service-worker.js')
        self.assertEqual(sw_res.status_code, 200)
        sw_text = sw_res.get_data(as_text=True)
        sw_res.close()
        shell_block = re.search(r'SHELL_FILES\s*=\s*\[(.*?)\];', sw_text, re.DOTALL)
        self.assertIsNotNone(shell_block)
        shell_urls = re.findall(r"['\"](/static/[^'\"]+)['\"]", shell_block.group(1))
        self.assertGreater(len(shell_urls), 10)
        for asset_url in shell_urls:
            resp = client.get(asset_url)
            self.assertEqual(resp.status_code, 200, f'Missing SW asset: {asset_url}')
            resp.close()

        # 2. Manifest icons (both dynamic /site.webmanifest and static file) must return 200
        for manifest_url in ('/site.webmanifest', '/static/site.webmanifest'):
            m_res = client.get(manifest_url)
            self.assertEqual(m_res.status_code, 200, f'Missing manifest: {manifest_url}')
            manifest = json.loads(m_res.get_data(as_text=True))
            m_res.close()
            for icon in manifest.get('icons', []):
                i_res = client.get(icon['src'])
                self.assertEqual(i_res.status_code, 200, f'Missing manifest icon: {icon["src"]}')
                i_res.close()

        # 3. Rendered setup, login, index, and offline pages must have no broken /static/ URLs
        pages_to_check = []
        setup_page = client.get('/setup')
        self.assertEqual(setup_page.status_code, 200)
        pages_to_check.append(('setup', setup_page.get_data(as_text=True)))

        client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={'username': 'admin', 'password': 'secret123'})
        index_page = client.get('/')
        self.assertEqual(index_page.status_code, 200)
        pages_to_check.append(('index', index_page.get_data(as_text=True)))

        offline_page = client.get('/static/offline.html')
        self.assertEqual(offline_page.status_code, 200)
        pages_to_check.append(('offline', offline_page.get_data(as_text=True)))
        offline_page.close()

        client.post('/api/logout', headers={'X-CSRF-Token': self._csrf_token_from_response(index_page)})
        login_page = client.get('/login')
        self.assertEqual(login_page.status_code, 200)
        pages_to_check.append(('login', login_page.get_data(as_text=True)))

        for name, html in pages_to_check:
            static_urls = set(re.findall(r'(?:href|src)=["\'](/static/[^"\'?]+)', html))
            self.assertTrue(static_urls, f'No static assets found on {name}')
            for asset_url in static_urls:
                resp = client.get(asset_url)
                self.assertEqual(resp.status_code, 200, f'Broken static URL on {name}: {asset_url}')
                resp.close()

    def test_lyrics_mutations_return_non_null_lyrics_updated_at(self):
        client = self.app_module.app.test_client()
        setup_res = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        csrf = self._csrf_token_from_response(setup_res)
        song_id = self._create_song(user_id=1, title='Timestamp Song', artist='Artist', filename='ts-song.mp3')

        with patch.object(self.app_module, 'search_lyrics', return_value=None):
            not_found_res = client.post(f'/api/songs/{song_id}/lyrics', headers={'X-CSRF-Token': csrf})
        self.assertEqual(not_found_res.status_code, 404)
        self.assertIsNotNone(not_found_res.get_json()['lyrics_updated_at'])

        with patch.object(self.app_module, 'search_lyrics', return_value={'lyrics': 'Line 1', 'synced_lyrics': '', 'word_synced_lyrics': ''}):
            found_res = client.post(f'/api/songs/{song_id}/lyrics', headers={'X-CSRF-Token': csrf})
        self.assertEqual(found_res.status_code, 200)
        self.assertIsNotNone(found_res.get_json()['lyrics_updated_at'])

        manual_res = client.put(
            f'/api/songs/{song_id}/lyrics',
            headers={'X-CSRF-Token': csrf},
            json={'lyrics': 'Edited line', 'synced_lyrics': ''},
        )
        self.assertEqual(manual_res.status_code, 200)
        self.assertIsNotNone(manual_res.get_json()['lyrics_updated_at'])

    def test_lyrics_throttled_request_releases_lock_during_http_io(self):
        import threading
        from services import lyrics as lyrics_service

        started = threading.Event()
        release = threading.Event()
        lock_was_free = []

        class DummyResp:
            ok = True
            status_code = 200

        def slow_request(*args, **kwargs):
            started.set()
            lock_was_free.append(not lyrics_service._request_lock.locked())
            release.wait(timeout=2)
            return DummyResp()

        with patch.object(lyrics_service, 'REQUEST_INTERVAL_SECONDS', 0.01), \
             patch.object(lyrics_service, '_next_request_time', 0.0), \
             patch.object(lyrics_service.requests, 'request', side_effect=slow_request):
            worker = threading.Thread(target=lyrics_service._throttled_request, args=('GET', 'https://lrclib.net/api/get'))
            worker.start()
            self.assertTrue(started.wait(timeout=1))
            self.assertFalse(lyrics_service._request_lock.locked(), '_request_lock must not be held during HTTP I/O')
            release.set()
            worker.join(timeout=2)
        self.assertEqual(lock_was_free, [True])

    def test_save_song_lyrics_rejects_oversized_payload(self):
        from routes.lyrics import MAX_LYRICS_LENGTH

        client = self.app_module.app.test_client()
        setup_res = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        csrf = self._csrf_token_from_response(setup_res)
        song_id = self._create_song(user_id=1, title='Long Lyrics', filename='long-lyrics.mp3')

        res = client.put(
            f'/api/songs/{song_id}/lyrics',
            headers={'X-CSRF-Token': csrf},
            json={'lyrics': 'A' * (MAX_LYRICS_LENGTH + 1), 'synced_lyrics': ''},
        )
        self.assertEqual(res.status_code, 400)

    def test_library_song_lyrics_get_and_try_again_for_unowned_song(self):
        client = self.app_module.app.test_client()
        setup_res = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        csrf = self._csrf_token_from_response(setup_res)

        # Create a library song owned by another user with private manual lyrics
        other_song_id = self._create_song(
            user_id=2,
            title='Langit Tak Seharusnya Biru',
            artist='The Jansen',
            filename='the-jansen.mp3',
            lyrics='Private manual lyrics',
            synced_lyrics='',
            lyrics_status='manual',
        )

        # GET must succeed (200) without leaking the other user's manual lyrics
        get_res = client.get(f'/api/songs/{other_song_id}/lyrics')
        self.assertEqual(get_res.status_code, 200)
        get_data = get_res.get_json()
        self.assertEqual(get_data['lyrics'], '')
        self.assertEqual(get_data['lyrics_status'], 'none')

        # POST (Try Again) must fetch public lyrics for the library song
        with patch.object(self.app_module, 'search_lyrics', return_value={
            'lyrics': 'Public LRCLIB lyrics',
            'synced_lyrics': '[00:05.00] Public LRCLIB lyrics',
        }):
            post_res = client.post(
                f'/api/songs/{other_song_id}/lyrics',
                headers={'X-CSRF-Token': csrf},
            )
        self.assertEqual(post_res.status_code, 200)
        self.assertEqual(post_res.get_json()['lyrics'], 'Public LRCLIB lyrics')
        self.assertEqual(post_res.get_json()['lyrics_status'], 'found')

        # Other user's manual lyrics must remain intact in DB
        with self.app_module.app.app_context():
            from services.common import get_db
            row = get_db().execute('SELECT lyrics, lyrics_status FROM songs WHERE id = ?', (other_song_id,)).fetchone()
            self.assertEqual(row['lyrics'], 'Private manual lyrics')
            self.assertEqual(row['lyrics_status'], 'manual')

        # PUT (manual edit) on an unowned library song must still be rejected
        put_res = client.put(
            f'/api/songs/{other_song_id}/lyrics',
            headers={'X-CSRF-Token': csrf},
            json={'lyrics': 'Attempted overwrite', 'synced_lyrics': ''},
        )
        self.assertEqual(put_res.status_code, 404)


if __name__ == '__main__':
    unittest.main()
