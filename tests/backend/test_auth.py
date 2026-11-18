import io
import os
import sqlite3
import unittest
from contextlib import closing
from unittest.mock import patch

from tests.backend.base import PsrFmTestCase


class AuthTests(PsrFmTestCase):
    def test_setup_and_login_flow(self):
        client = self.app_module.app.test_client()

        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
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

        login_response = client.post('/api/login', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        self.assertEqual(login_response.status_code, 200)
        self.assertEqual(login_response.get_json()['username'], 'admin')

    def test_login_rate_limit_blocks_repeated_failures(self):
        client = self.app_module.app.test_client()
        client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })

        for _ in range(self.app_module.LOGIN_RATE_LIMIT_MAX_ATTEMPTS):
            response = client.post('/api/login', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
                'username': 'admin',
                'password': 'wrong-password',
            })
            self.assertEqual(response.status_code, 401)

        limited_response = client.post('/api/login', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'wrong-password',
        })

        self.assertEqual(limited_response.status_code, 429)
        self.assertIn('retry_after', limited_response.get_json())

    def test_delete_user_cleans_up_playlist_cover_art_file(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_token = self._csrf_token_from_response(setup_response)

        user2_res = client.post(
            '/api/users',
            headers={'X-CSRF-Token': csrf_token},
            json={'username': 'user2', 'password': 'password123'},
        )
        self.assertEqual(user2_res.status_code, 201)
        user2_id = user2_res.get_json()['user_id']

        album_art_dir = self.app_module.ALBUM_ART_DIR
        os.makedirs(album_art_dir, exist_ok=True)
        cover_filename = 'pl_cover_user2.jpg'
        cover_path = os.path.join(album_art_dir, cover_filename)
        with open(cover_path, 'wb') as f:
            f.write(b'dummy-cover-bytes-user2')

        self._create_playlist(user_id=user2_id, name='User2 Playlist', cover_art=cover_filename)

        del_user_res = client.delete(
            f'/api/admin/users/{user2_id}',
            headers={'X-CSRF-Token': csrf_token},
        )
        self.assertEqual(del_user_res.status_code, 200)
        self.assertFalse(os.path.exists(cover_path))

    def test_csrf_rejects_missing_token_globally(self):
        client = self.app_module.app.test_client()
        for path, payload in (
            ('/api/playlists', {'name': 'No CSRF'}),
            ('/api/login', {'username': 'admin', 'password': 'secret123'}),
            ('/api/setup', {'username': 'admin', 'password': 'secret123'}),
        ):
            response = client.post(path, json=payload)
            self.assertEqual(response.status_code, 403, f'{path} did not reject missing CSRF')
            self.assertEqual(response.get_json()['error'], 'CSRF token missing')

    def test_user_role_loaded_and_is_admin_evaluates_in_memory(self):
        client = self.app_module.app.test_client()
        client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        from services.common import is_admin
        from services.database import get_user_by_id
        user_row = get_user_by_id(self.app_module.DATABASE_PATH, 1)
        with self.app_module.app.test_request_context():
            user = self.app_module.load_user(f"1:{user_row['session_token']}")
            self.assertIsNotNone(user)
            self.assertEqual(user.role, 'admin')
            with patch('services.common.get_db_connection') as mock_conn:
                with patch('flask_login.utils._get_user', return_value=user):
                    self.assertTrue(is_admin())
                    mock_conn.assert_not_called()

    def test_change_password_flow(self):
        client = self.app_module.app.test_client()
        setup_res = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_token = self._csrf_token_from_response(setup_res)

        bad_pw_res = client.post(
            '/api/user/change-password',
            headers={'X-CSRF-Token': csrf_token},
            json={'current_password': 'wrongpassword', 'new_password': 'newsecret123'},
        )
        self.assertEqual(bad_pw_res.status_code, 400)
        self.assertEqual(bad_pw_res.get_json()['error'], 'Current password is incorrect')

        short_pw_res = client.post(
            '/api/user/change-password',
            headers={'X-CSRF-Token': csrf_token},
            json={'current_password': 'secret123', 'new_password': '123'},
        )
        self.assertEqual(short_pw_res.status_code, 400)
        self.assertIn('at least 6 characters', short_pw_res.get_json()['error'])

        change_res = client.post(
            '/api/user/change-password',
            headers={'X-CSRF-Token': csrf_token},
            json={'current_password': 'secret123', 'new_password': 'newsecret123'},
        )
        self.assertEqual(change_res.status_code, 200)

        login_old_res = client.post('/api/login', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        self.assertEqual(login_old_res.status_code, 401)

        login_new_res = client.post('/api/login', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'newsecret123',
        })
        self.assertEqual(login_new_res.status_code, 200)

    def test_password_change_invalidates_other_sessions_and_reencodes_apic(self):
        from routes.songs import _save_reencoded_album_art
        from PIL import Image

        client_a = self.app_module.app.test_client()
        client_b = self.app_module.app.test_client()
        setup_res = client_a.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client_a)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        csrf_a = self._csrf_token_from_response(setup_res)

        login_b = client_b.post('/api/login', headers={'X-CSRF-Token': self._csrf_token(client_b)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        self.assertEqual(login_b.status_code, 200)
        self.assertEqual(client_b.get('/api/me').status_code, 200)

        change_res = client_a.post(
            '/api/user/change-password',
            headers={'X-CSRF-Token': csrf_a},
            json={'current_password': 'secret123', 'new_password': 'newsecret123'},
        )
        self.assertEqual(change_res.status_code, 200)
        # Current session stays authenticated, other session is immediately invalidated
        self.assertEqual(client_a.get('/api/me').status_code, 200)
        self.assertEqual(client_b.get('/api/me').status_code, 401)

        # Embedded APIC validation rejects non-image payload and re-encodes valid PNG
        with self.assertRaises(Exception):
            _save_reencoded_album_art(b'<script>alert(1)</script>', self.app_module.ALBUM_ART_DIR)
        buf = io.BytesIO()
        Image.new('RGB', (16, 16), color='purple').save(buf, format='PNG')
        fname, fpath = _save_reencoded_album_art(buf.getvalue(), self.app_module.ALBUM_ART_DIR)
        self.assertTrue(fname.endswith('.png') and os.path.exists(fpath))

    def test_first_run_login_redirects_to_setup_and_failed_thumbnail_leaves_empty_art(self):
        from services import downloader
        client = self.app_module.app.test_client()

        # Before any user exists, /login must redirect to /setup
        first_login = client.get('/login')
        self.assertEqual(first_login.status_code, 302)
        self.assertTrue(first_login.headers['Location'].endswith('/setup'))

        # Setup admin
        setup_res = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        self.assertEqual(setup_res.status_code, 200)
        playlist_id = self._create_playlist()

        class FakeYDLWithThumb:
            def __init__(self, opts):
                self.opts = opts
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def extract_info(self, url, download=False):
                return {'title': 'No Thumb', 'uploader': 'Artist', 'duration': 60, 'thumbnail': 'https://example.com/thumb.jpg', 'webpage_url': url}
            def download(self, urls):
                with open(f"{self.opts['outtmpl']}.mp3", 'wb') as handle:
                    handle.write(b'ID3fake-audio')

        class FailedThumbResp:
            status_code = 404
            content = b''

        with patch.object(downloader.yt_dlp, 'YoutubeDL', FakeYDLWithThumb), \
             patch.object(downloader, 'extract_duration', return_value=60), \
             patch.object(downloader, 'search_lyrics', return_value=None), \
             patch.object(downloader.requests, 'get', return_value=FailedThumbResp()):
            downloader.process_download(
                {'url': 'https://www.youtube.com/watch?v=zzzzzzzzzzz', 'playlist_ids': [playlist_id], 'user_id': 1},
                self.app_module.DATABASE_PATH,
                self.app_module.DOWNLOAD_DIR,
                self.app_module.ALBUM_ART_DIR,
            )

        with closing(sqlite3.connect(self.app_module.DATABASE_PATH)) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute('SELECT album_art FROM songs ORDER BY id DESC LIMIT 1').fetchone()
        self.assertEqual(row['album_art'], '')

    def test_security_headers_and_no_csrf_cookie_on_static_assets(self):
        client = self.app_module.app.test_client()

        page_resp = client.get('/setup')
        self.assertEqual(page_resp.status_code, 200)
        self.assertEqual(page_resp.headers.get('X-Content-Type-Options'), 'nosniff')
        self.assertEqual(page_resp.headers.get('X-Frame-Options'), 'SAMEORIGIN')
        self.assertEqual(page_resp.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin')
        self.assertTrue(
            any('csrf_token=' in h for h in page_resp.headers.getlist('Set-Cookie')),
            'HTML/API responses must still set csrf_token cookie',
        )

        for static_path in ('/static/css/style.css', '/static/img/psrfm.png'):
            static_client = self.app_module.app.test_client()
            static_resp = static_client.get(static_path)
            try:
                self.assertEqual(static_resp.status_code, 200)
                self.assertEqual(static_resp.headers.get('X-Content-Type-Options'), 'nosniff')
                self.assertEqual(static_resp.headers.getlist('Set-Cookie'), [], f'{static_path} must not emit Set-Cookie')
            finally:
                static_resp.close()

    def test_delete_nonexistent_user_returns_404(self):
        client = self.app_module.app.test_client()
        setup_res = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        csrf = self._csrf_token_from_response(setup_res)
        res = client.delete('/api/admin/users/99999', headers={'X-CSRF-Token': csrf})
        self.assertEqual(res.status_code, 404)
        self.assertEqual(res.get_json()['error'], 'User not found')

    def test_change_password_rate_limit_and_max_password_length(self):
        from services.common import PASSWORD_CHANGE_RATE_LIMIT_MAX_ATTEMPTS, MAX_PASSWORD_LENGTH

        client = self.app_module.app.test_client()
        too_long = 'a' * (MAX_PASSWORD_LENGTH + 1)
        bad_setup = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin', 'password': too_long
        })
        self.assertEqual(bad_setup.status_code, 400)

        setup_res = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        csrf = self._csrf_token_from_response(setup_res)

        long_change = client.post(
            '/api/user/change-password',
            headers={'X-CSRF-Token': csrf},
            json={'current_password': 'secret123', 'new_password': too_long},
        )
        self.assertEqual(long_change.status_code, 400)

        for _ in range(PASSWORD_CHANGE_RATE_LIMIT_MAX_ATTEMPTS):
            wrong = client.post(
                '/api/user/change-password',
                headers={'X-CSRF-Token': csrf},
                json={'current_password': 'wrong-password', 'new_password': 'newpassword123'},
            )
            self.assertEqual(wrong.status_code, 400)

        blocked = client.post(
            '/api/user/change-password',
            headers={'X-CSRF-Token': csrf},
            json={'current_password': 'secret123', 'new_password': 'newpassword123'},
        )
        self.assertEqual(blocked.status_code, 429)

    def test_login_unknown_username_runs_dummy_hash_check(self):
        import routes.auth as auth_routes

        client = self.app_module.app.test_client()
        client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        with patch.object(auth_routes, 'check_password_hash', wraps=auth_routes.check_password_hash) as mock_check:
            res = client.post('/api/login', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
                'username': 'nonexistent_user', 'password': 'some-password'
            })
        self.assertEqual(res.status_code, 401)
        mock_check.assert_called_once()

    def test_csp_enforce_header_and_no_inline_scripts(self):
        client = self.app_module.app.test_client()
        setup_res = client.get('/setup')
        self.assertEqual(setup_res.status_code, 200)
        csp = setup_res.headers.get('Content-Security-Policy', '')
        self.assertIn("default-src 'self'", csp)
        self.assertIn("script-src 'self' https://cdnjs.cloudflare.com", csp)
        self.assertIn("object-src 'none'", csp)
        self.assertNotIn('<script>', setup_res.get_data(as_text=True))

        client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        client.post('/api/logout', headers={'X-CSRF-Token': self._csrf_token(client)})
        login_res = client.get('/login')
        self.assertEqual(login_res.status_code, 200)
        self.assertNotIn('<script>', login_res.get_data(as_text=True))

    def test_socketio_rejects_unauthenticated_and_closes_room_on_revocation(self):
        client = self.app_module.app.test_client()
        # Unauthenticated connect returns False
        with self.app_module.app.test_request_context('/'):
            self.assertFalse(self.app_module.on_socket_connect())

        setup_res = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        csrf = self._csrf_token_from_response(setup_res)
        u2_res = client.post('/api/users', headers={'X-CSRF-Token': csrf}, json={
            'username': 'member', 'password': 'password123'
        })
        u2_id = u2_res.get_json()['user_id']

        with patch.object(self.app_module.socketio, 'close_room') as mock_close_room:
            self.assertEqual(
                client.post(
                    '/api/user/change-password',
                    headers={'X-CSRF-Token': csrf},
                    json={'current_password': 'secret123', 'new_password': 'newsecret123'},
                ).status_code,
                200,
            )
            mock_close_room.assert_any_call('user_1')

            self.assertEqual(
                client.post(
                    f'/api/admin/users/{u2_id}/reset-password',
                    headers={'X-CSRF-Token': csrf},
                    json={'password': 'resetpassword123'},
                ).status_code,
                200,
            )
            mock_close_room.assert_any_call(f'user_{u2_id}')

            self.assertEqual(
                client.delete(f'/api/admin/users/{u2_id}', headers={'X-CSRF-Token': csrf}).status_code,
                200,
            )
            self.assertEqual(mock_close_room.call_args_list[-1].args, (f'user_{u2_id}',))

    def test_socketio_origins_multi_origin_parsing(self):
        parse = self.app_module._parse_socketio_origins
        self.assertIsNone(parse(''))
        self.assertEqual(parse('*'), '*')
        self.assertEqual(
            parse('https://a.example.com, https://b.example.com , '),
            ['https://a.example.com', 'https://b.example.com'],
        )

    def test_logout_revokes_only_current_device_and_logout_all_revokes_all(self):
        client_a = self.app_module.app.test_client()
        client_b = self.app_module.app.test_client()

        setup_res = client_a.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client_a)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        csrf_a = self._csrf_token_from_response(setup_res)
        saved_cookie_a = client_a.get_cookie('session')

        login_b = client_b.post('/api/login', headers={'X-CSRF-Token': self._csrf_token(client_b)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        csrf_b = self._csrf_token_from_response(login_b)
        self.assertEqual(client_b.get('/api/me').status_code, 200)

        # Logout device A
        self.assertEqual(client_a.post('/api/logout', headers={'X-CSRF-Token': csrf_a}).status_code, 200)
        # Replaying old session cookie of device A must fail server-side
        replay_client = self.app_module.app.test_client()
        if saved_cookie_a is not None:
            replay_client.set_cookie(saved_cookie_a.key, saved_cookie_a.value)
        self.assertEqual(replay_client.get('/api/me').status_code, 401)
        # Device B remains signed in
        self.assertEqual(client_b.get('/api/me').status_code, 200)

        # Logout all from device B revokes B too
        self.assertEqual(client_b.post('/api/logout-all', headers={'X-CSRF-Token': csrf_b}).status_code, 200)
        self.assertEqual(client_b.get('/api/me').status_code, 401)

    def test_private_playlist_cover_blocked_across_accounts(self):
        client_a = self.app_module.app.test_client()
        setup_res = client_a.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client_a)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        csrf_a = self._csrf_token_from_response(setup_res)
        client_a.post('/api/users', headers={'X-CSRF-Token': csrf_a}, json={
            'username': 'user2', 'password': 'password123'
        })

        os.makedirs(self.app_module.ALBUM_ART_DIR, exist_ok=True)
        cover_name = 'pl_cover_1_private.jpg'
        with open(os.path.join(self.app_module.ALBUM_ART_DIR, cover_name), 'wb') as f:
            f.write(b'fake-jpeg-bytes')
        self._create_playlist(user_id=1, name='Private PL', cover_art=cover_name)

        owner_resp = client_a.get(f'/static/album_art/{cover_name}')
        try:
            self.assertEqual(owner_resp.status_code, 200)
        finally:
            owner_resp.close()

        client_b = self.app_module.app.test_client()
        client_b.post('/api/login', headers={'X-CSRF-Token': self._csrf_token(client_b)}, json={
            'username': 'user2', 'password': 'password123'
        })
        other_resp = client_b.get(f'/static/album_art/{cover_name}')
        self.assertEqual(other_resp.status_code, 404)


if __name__ == '__main__':
    unittest.main()
