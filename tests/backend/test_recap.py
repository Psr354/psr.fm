import sqlite3
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timezone, timedelta

from tests.backend.base import PsrFmTestCase


class RecapAndSettingsTests(PsrFmTestCase):
    def test_recap_uses_play_events_not_listen_chunks(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_token = self._csrf_token_from_response(setup_response)
        song_id = self._create_song()

        for _ in range(2):
            play_response = client.post(
                f'/api/songs/{song_id}/play',
                headers={'X-CSRF-Token': csrf_token},
            )
            self.assertEqual(play_response.status_code, 200)
            session_id = play_response.get_json()['playback_session_id']

        conn = sqlite3.connect(self.app_module.DATABASE_PATH)
        try:
            conn.execute(
                "UPDATE playback_sessions SET started_at = datetime('now', '-1 minute') WHERE id = ?",
                (session_id,),
            )
            conn.commit()
        finally:
            conn.close()

        for _ in range(3):
            listen_response = client.post(
                '/api/listen',
                headers={'X-CSRF-Token': csrf_token},
                json={
                    'song_id': song_id,
                    'seconds': 10,
                    'playback_session_id': session_id,
                },
            )
            self.assertEqual(listen_response.status_code, 200)

        now = datetime.now(timezone.utc)
        recap_response = client.get(f'/api/recap?period=month&month={now.month}&year={now.year}')
        self.assertEqual(recap_response.status_code, 200)
        recap = recap_response.get_json()

        self.assertEqual(recap['stats']['total_plays'], 2)
        self.assertEqual(recap['stats']['total_seconds'], 30)
        self.assertEqual(recap['top_played'][0]['play_count'], 2)

    def test_recap_respects_user_timezone_at_month_boundary(self):
        client = self.app_module.app.test_client()
        client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={'username': 'psr354', 'password': 'secret123'})
        song_id = self._create_song()
        with closing(sqlite3.connect(self.app_module.DATABASE_PATH)) as conn:
            conn.execute('INSERT INTO play_events (song_id, user_id, timestamp) VALUES (?, 1, ?)',
                         (song_id, '2020-09-30 18:00:00'))
            conn.execute('INSERT INTO listening_logs (song_id, user_id, seconds_listened, timestamp) VALUES (?, 1, 20, ?)',
                         (song_id, '2020-09-30 18:00:00'))
            conn.commit()
        utc = client.get('/api/recap?period=month&year=2020&month=10').get_json()
        local = client.get('/api/recap?period=month&year=2020&month=10&tz_offset=-420').get_json()
        self.assertEqual(utc['stats']['total_plays'], 0)
        self.assertEqual(local['stats']['total_plays'], 1)
        self.assertEqual(local['stats']['total_seconds'], 20)
        yearly = client.get('/api/recap?period=year&year=2020&tz_offset=-420').get_json()
        self.assertEqual(yearly['monthly_breakdown'][0]['month_num'], 10)
        self.assertEqual(yearly['monthly_breakdown'][0]['top_song']['title'], 'Test Track')
        for query in ('period=invalid', 'month=13', 'year=invalid', 'tz_offset=invalid'):
            self.assertEqual(client.get('/api/recap?' + query).status_code, 400)

    def test_recap_keeps_play_and_listening_rankings_separate(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        song_by_plays = self._create_song(title='Most Played')
        song_by_listening = self._create_song(title='Most Listened', filename='most-listened.mp3')
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

        conn = sqlite3.connect(self.app_module.DATABASE_PATH)
        try:
            conn.executemany(
                'INSERT INTO play_events (song_id, user_id, timestamp) VALUES (?, 1, ?)',
                [(song_by_plays, timestamp)] * 3 + [(song_by_listening, timestamp)],
            )
            conn.executemany(
                'INSERT INTO listening_logs (song_id, user_id, seconds_listened, timestamp) VALUES (?, 1, ?, ?)',
                [
                    (song_by_plays, 10, timestamp),
                    (song_by_listening, 100, timestamp),
                ],
            )
            conn.commit()
        finally:
            conn.close()

        year = datetime.now().year
        recap = client.get(f'/api/recap?period=year&year={year}').get_json()

        self.assertEqual(recap['top_played'][0]['title'], 'Most Played')
        self.assertEqual(recap['top_listened'][0]['title'], 'Most Listened')
        self.assertEqual(recap['monthly_breakdown'][0]['top_song']['title'], 'Most Listened')

    def test_listening_statistics_indexes_are_created(self):
        conn = sqlite3.connect(self.app_module.DATABASE_PATH)
        try:
            indexes = {
                row[1]
                for row in conn.execute("SELECT type, name FROM sqlite_master WHERE type = 'index'")
            }
        finally:
            conn.close()

        self.assertIn('idx_listening_logs_user_timestamp', indexes)

    def test_listen_rejects_invalid_or_oversized_chunks(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        csrf_token = self._csrf_token_from_response(setup_response)
        song_id = self._create_song()
        play_response = client.post(
            f'/api/songs/{song_id}/play',
            headers={'X-CSRF-Token': csrf_token},
        )
        session_id = play_response.get_json()['playback_session_id']

        for seconds in [0, 31, 'not-a-number']:
            response = client.post(
                '/api/listen',
                headers={'X-CSRF-Token': csrf_token},
                json={
                    'song_id': song_id,
                    'seconds': seconds,
                    'playback_session_id': session_id,
                },
            )
            self.assertEqual(response.status_code, 400)

        response = client.post(
            '/api/listen',
            headers={'X-CSRF-Token': csrf_token},
            json={
                'song_id': song_id,
                'seconds': 10,
                'playback_session_id': session_id,
            },
        )
        self.assertEqual(response.status_code, 200)

        forged_response = client.post(
            '/api/listen',
            headers={'X-CSRF-Token': csrf_token},
            json={
                'song_id': song_id,
                'seconds': 10,
                'playback_session_id': 'forged-session',
            },
        )
        self.assertEqual(forged_response.status_code, 409)

    def test_queued_play_and_listen_retries_count_once(self):
        client = self.app_module.app.test_client()
        setup = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={'username': 'psr354', 'password': 'secret123'})
        headers = {'X-CSRF-Token': self._csrf_token_from_response(setup)}
        song_id = self._create_song(duration_seconds=338)
        started = datetime.now(timezone.utc) - timedelta(minutes=10)
        play = {'user_id': 1, 'playback_session_id': 'psr354-retry', 'occurred_at': started.isoformat()}
        for _ in range(3):
            response = client.post(f'/api/songs/{song_id}/play', json=play, headers=headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()['playback_session_id'], play['playback_session_id'])
        listen = {'user_id': 1, 'song_id': song_id, 'playback_session_id': play['playback_session_id'],
                  'event_id': 'psr354-chunk', 'seconds': 30,
                  'occurred_at': (started + timedelta(seconds=30)).isoformat()}
        for _ in range(3):
            self.assertEqual(client.post('/api/listen', json=listen, headers=headers).status_code, 200)
        self.assertEqual(client.post('/api/listen', json={**listen, 'seconds': 20}, headers=headers).status_code, 409)
        self.assertEqual(client.post('/api/listen', json={**listen, 'user_id': 2}, headers=headers).status_code, 403)
        with closing(sqlite3.connect(self.app_module.DATABASE_PATH)) as conn:
            self.assertEqual(conn.execute('SELECT play_count FROM songs WHERE id = ?', (song_id,)).fetchone()[0], 1)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM play_events').fetchone()[0], 1)
            self.assertEqual(conn.execute('SELECT SUM(seconds_listened) FROM listening_logs').fetchone()[0], 30)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM listening_receipts').fetchone()[0], 1)

    def test_concurrent_play_and_listen_retries_count_once(self):
        client = self.app_module.app.test_client()
        setup = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={'username': 'psr354', 'password': 'secret123'})
        token = self._csrf_token_from_response(setup)
        with client.session_transaction() as session:
            original_session = dict(session)
        song_id = self._create_song()

        def post(url, payload):
            worker = self.app_module.app.test_client()
            with worker.session_transaction() as session:
                session.update(original_session)
            response = worker.post(url, json=payload, headers={'X-CSRF-Token': token})
            return response.status_code

        play = {'user_id': 1, 'playback_session_id': 'psr354-concurrent'}
        listen = {'user_id': 1, 'song_id': song_id, 'playback_session_id': play['playback_session_id'],
                  'event_id': 'psr354-concurrent-chunk', 'seconds': 5}
        with ThreadPoolExecutor(max_workers=4) as pool:
            self.assertEqual(list(pool.map(lambda _: post(f'/api/songs/{song_id}/play', play), range(4))), [200] * 4)
            self.assertEqual(list(pool.map(lambda _: post('/api/listen', listen), range(4))), [200] * 4)
        with closing(sqlite3.connect(self.app_module.DATABASE_PATH)) as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM play_events').fetchone()[0], 1)
            self.assertEqual(conn.execute('SELECT SUM(seconds_listened) FROM listening_logs').fetchone()[0], 5)

    def test_offline_full_repeats_keep_original_period(self):
        client = self.app_module.app.test_client()
        setup = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={'username': 'psr354', 'password': 'secret123'})
        headers = {'X-CSRF-Token': self._csrf_token_from_response(setup)}
        song_id = self._create_song(duration_seconds=338)
        started = datetime(2020, 1, 31, 23, 50, tzinfo=timezone.utc)
        for repeat in range(3):
            session_id = f'psr354-offline-{repeat}'
            session_start = started + timedelta(seconds=338 * repeat)
            play = {'user_id': 1, 'playback_session_id': session_id, 'occurred_at': session_start.isoformat()}
            self.assertEqual(client.post(f'/api/songs/{song_id}/play', json=play, headers=headers).status_code, 200)
            for offset in range(0, 338, 30):
                seconds = min(30, 338 - offset)
                listen = {'user_id': 1, 'song_id': song_id, 'playback_session_id': session_id,
                          'event_id': f'{session_id}-{offset}', 'seconds': seconds,
                          'occurred_at': (session_start + timedelta(seconds=offset + seconds)).isoformat()}
                self.assertEqual(client.post('/api/listen', json=listen, headers=headers).status_code, 200)
                self.assertEqual(client.post('/api/listen', json=listen, headers=headers).status_code, 200)
        recap = client.get('/api/recap?period=year&year=2020').get_json()
        self.assertEqual(recap['stats']['total_seconds'], 1014)
        self.assertEqual(recap['stats']['total_plays'], 3)
        with closing(sqlite3.connect(self.app_module.DATABASE_PATH)) as conn:
            self.assertEqual([row[0] for row in conn.execute('SELECT seconds_listened FROM playback_sessions')], [338, 338, 338])

    def test_replayed_sections_can_exceed_song_duration_but_not_elapsed_time(self):
        client = self.app_module.app.test_client()
        setup = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={'username': 'psr354', 'password': 'secret123'})
        headers = {'X-CSRF-Token': self._csrf_token_from_response(setup)}
        song_id = self._create_song(duration_seconds=10)
        session_id = 'psr354-seek-replay'
        started = datetime.now(timezone.utc) - timedelta(minutes=1)
        client.post(f'/api/songs/{song_id}/play', headers=headers, json={
            'playback_session_id': session_id, 'occurred_at': started.isoformat()})
        for index in range(2):
            response = client.post('/api/listen', headers=headers, json={
                'song_id': song_id, 'playback_session_id': session_id,
                'event_id': f'psr354-replay-{index}', 'seconds': 10})
            self.assertEqual(response.status_code, 200)
        with closing(sqlite3.connect(self.app_module.DATABASE_PATH)) as conn:
            self.assertEqual(conn.execute('SELECT seconds_listened FROM playback_sessions').fetchone()[0], 20)
            self.assertEqual(conn.execute('SELECT play_count FROM songs').fetchone()[0], 1)
        # Sixty more seconds would exceed the actual one-minute session age.
        client.post('/api/listen', headers=headers, json={
            'song_id': song_id, 'playback_session_id': session_id, 'event_id': 'psr354-budget-1', 'seconds': 30})
        response = client.post('/api/listen', headers=headers, json={
            'song_id': song_id, 'playback_session_id': session_id, 'event_id': 'psr354-budget-2', 'seconds': 30})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()['code'], 'playback_time_exceeded')

    def test_queued_events_reject_bad_timestamp_and_session(self):
        client = self.app_module.app.test_client()
        setup = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={'username': 'psr354', 'password': 'secret123'})
        headers = {'X-CSRF-Token': self._csrf_token_from_response(setup)}
        song_id = self._create_song()
        for timestamp in ['invalid', 123, (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()]:
            self.assertEqual(client.post(f'/api/songs/{song_id}/play', headers=headers,
                                        json={'playback_session_id': 'psr354-bad', 'occurred_at': timestamp}).status_code, 400)
        response = client.post('/api/listen', headers=headers, json={
            'song_id': song_id, 'playback_session_id': 'psr354-missing', 'event_id': 'psr354-event', 'seconds': 5})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()['code'], 'session_missing')

    def test_dashboard_storage_caching(self):
        client = self.app_module.app.test_client()
        setup_response = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin',
            'password': 'secret123',
        })
        self.assertEqual(setup_response.status_code, 200)

        # Call dashboard multiple times
        res1 = client.get('/api/dashboard')
        res2 = client.get('/api/dashboard')
        self.assertEqual(res1.status_code, 200)
        self.assertEqual(res2.status_code, 200)
        self.assertEqual(res1.get_json()['storage_used'], res2.get_json()['storage_used'])

    def test_status_bar_color_matches_frontend_modes(self):
        from services.common import get_user_status_bar_color
        from services.database import save_user_theme
        client = self.app_module.app.test_client()
        client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        cases = [
            ({'statusBarMode': 'accent', 'accent': '#112233'}, '#112233'),
            ({'statusBarMode': 'background', 'bg': 'midnight'}, '#0b0f19'),
            ({'statusBarMode': 'background', 'bg': 'custom', 'bgCustom': '#123456'}, '#123456'),
            ({'statusBarMode': 'black'}, '#000000'),
            ({'statusBarMode': 'custom', 'statusBarCustom': '#abcdef'}, '#abcdef'),
            ({'statusBarMode': 'match', 'card': '#223344'}, '#223344'),
        ]
        with self.app_module.app.app_context():
            for theme_payload, expected in cases:
                save_user_theme(self.app_module.DATABASE_PATH, 1, theme_payload)
                self.assertEqual(get_user_status_bar_color(1), expected)

    def test_non_object_json_and_null_duration_edge_cases(self):
        client = self.app_module.app.test_client()
        setup_res = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        csrf = self._csrf_token_from_response(setup_res)
        song_id = self._create_song(title='No Duration', duration_seconds=None)

        for method, path in (
            ('POST', f'/api/library-songs/{song_id}/add'),
            ('POST', f'/api/songs/{song_id}/playlists'),
            ('PUT', f'/api/songs/{song_id}/lyrics'),
            ('POST', '/api/listen'),
            ('POST', f'/api/songs/{song_id}/play'),
        ):
            res = client.open(path, method=method, headers={'X-CSRF-Token': csrf}, json=['not', 'an', 'object'])
            self.assertEqual(res.status_code, 400, f'Expected 400 for non-object JSON on {method} {path}')

        # Null duration_seconds on offline reconciliation must not fail due to NULL arithmetic
        play_res = client.post(
            f'/api/songs/{song_id}/play',
            headers={'X-CSRF-Token': csrf},
            json={'playback_session_id': 'null-dur-sess-1'},
        )
        self.assertEqual(play_res.status_code, 200)
        past_ts = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
        listen_res = client.post(
            '/api/listen',
            headers={'X-CSRF-Token': csrf},
            json={
                'song_id': song_id,
                'playback_session_id': 'null-dur-sess-1',
                'seconds': 5,
                'occurred_at': past_ts,
            },
        )
        self.assertEqual(listen_res.status_code, 200)

    def test_user_settings_validation(self):
        client = self.app_module.app.test_client()
        setup_res = client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        csrf = self._csrf_token_from_response(setup_res)

        self.assertEqual(client.post(
            '/api/user-settings/theme',
            headers={'X-CSRF-Token': csrf},
            json={'accent': 'not-a-hex'},
        ).status_code, 400)
        self.assertEqual(client.post(
            '/api/user-settings/theme',
            headers={'X-CSRF-Token': csrf},
            json={'unknownKey': 'bad'},
        ).status_code, 400)
        self.assertEqual(client.post(
            '/api/user-settings/theme',
            headers={'X-CSRF-Token': csrf},
            json={'accent': '#30d66b', 'statusBarMode': 'custom', 'statusBarCustom': '#112233', 'scale': '1.0'},
        ).status_code, 200)

        self.assertEqual(client.post(
            '/api/user-settings/theme',
            headers={'X-CSRF-Token': csrf},
            json={'scale': True},
        ).status_code, 400)
        self.assertEqual(client.post(
            '/api/playback-state',
            headers={'X-CSRF-Token': csrf},
            json={'unknownKey': 'x' * 100},
        ).status_code, 400)
        for bad_repeat in ('one', 'off', True, False, 3, -1):
            self.assertEqual(client.post(
                '/api/playback-state',
                headers={'X-CSRF-Token': csrf},
                json={'songId': 1, 'repeatMode': bad_repeat},
            ).status_code, 400)
        for valid_repeat in (0, 1, 2):
            self.assertEqual(client.post(
                '/api/playback-state',
                headers={'X-CSRF-Token': csrf},
                json={
                    'songId': 1,
                    'playlistId': 1,
                    'songIndex': 0,
                    'currentTime': 12.5,
                    'duration': 180.0,
                    'repeatMode': valid_repeat,
                    'isPlaying': True,
                    'isShuffle': False,
                    'isMuted': False,
                    'volume': 0.8,
                    'timestamp': 1700000000000,
                },
            ).status_code, 200)

    def test_dashboard_hides_server_disk_stats_from_non_admin(self):
        import os

        admin_client = self.app_module.app.test_client()
        setup_res = admin_client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(admin_client)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        csrf_admin = self._csrf_token_from_response(setup_res)
        user_res = admin_client.post(
            '/api/users',
            headers={'X-CSRF-Token': csrf_admin},
            json={'username': 'regular', 'password': 'password123'},
        )
        regular_id = user_res.get_json()['user_id']

        os.makedirs(self.app_module.LIBRARY_DIR, exist_ok=True)
        with open(os.path.join(self.app_module.LIBRARY_DIR, 'admin-big.mp3'), 'wb') as f:
            f.write(b'A' * 4096)
        with open(os.path.join(self.app_module.LIBRARY_DIR, 'user-small.mp3'), 'wb') as f:
            f.write(b'U' * 512)
        self._create_song(user_id=1, filename='admin-big.mp3', create_file=False)
        self._create_song(user_id=regular_id, filename='user-small.mp3', create_file=False)

        admin_dash = admin_client.get('/api/dashboard').get_json()
        self.assertIn('storage_free', admin_dash)
        self.assertIn('storage_total', admin_dash)
        self.assertGreaterEqual(admin_dash['storage_used'], 4096 + 512)

        user_client = self.app_module.app.test_client()
        login_res = user_client.post('/api/login', headers={'X-CSRF-Token': self._csrf_token(user_client)}, json={
            'username': 'regular', 'password': 'password123'
        })
        self.assertEqual(login_res.status_code, 200)
        user_dash = user_client.get('/api/dashboard').get_json()
        self.assertNotIn('storage_free', user_dash)
        self.assertNotIn('storage_total', user_dash)
        self.assertEqual(user_dash['storage_used'], 512)

    def test_yearly_recap_monthly_breakdown_top_song_window_query(self):
        client = self.app_module.app.test_client()
        client.post('/api/setup', headers={'X-CSRF-Token': self._csrf_token(client)}, json={
            'username': 'admin', 'password': 'secret123'
        })
        song_a = self._create_song(user_id=1, title='January Hit', artist='Artist A', filename='jan-a.mp3')
        song_b = self._create_song(user_id=1, title='January Minor', artist='Artist B', filename='jan-b.mp3')
        song_c = self._create_song(user_id=1, title='March Hit', artist='Artist C', filename='mar-c.mp3')

        with closing(sqlite3.connect(self.app_module.DATABASE_PATH)) as conn:
            conn.executemany(
                'INSERT INTO listening_logs (song_id, user_id, seconds_listened, timestamp) VALUES (?, ?, ?, ?)',
                [
                    (song_a, 1, 240, '2025-01-10 10:00:00'),
                    (song_b, 1, 90, '2025-01-12 10:00:00'),
                    (song_c, 1, 180, '2025-03-05 12:00:00'),
                ],
            )
            conn.commit()

        recap = client.get('/api/recap?period=year&year=2025&tz_offset=0').get_json()
        breakdown = {item['month_num']: item for item in recap['monthly_breakdown']}
        self.assertEqual(breakdown[1]['top_song']['title'], 'January Hit')
        self.assertEqual(breakdown[1]['top_song']['total_listened'], 240)
        self.assertEqual(breakdown[3]['top_song']['title'], 'March Hit')
        self.assertEqual(breakdown[3]['top_song']['total_listened'], 180)


if __name__ == '__main__':
    unittest.main()
