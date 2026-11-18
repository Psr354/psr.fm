import calendar
import math
import os
import shutil
import time
import uuid
from datetime import datetime, timezone, timedelta
from threading import Lock
from flask import Blueprint, request, jsonify, current_app
from flask_login import login_required, current_user
from werkzeug.utils import secure_filename

from services.common import (
    get_db, get_owned_song, get_json_object, playback_timestamp, valid_playback_id, is_admin
)

recap_bp = Blueprint('recap', __name__)
MAX_SESSION_LISTEN_SECONDS = 7200


@recap_bp.route('/api/listen', methods=['POST'])
@login_required
def log_listen():
    data = get_json_object()
    if data is None:
        return jsonify({'error': 'JSON object required'}), 400
    song_id = data.get('song_id')
    session_id = data.get('playback_session_id')
    event_id = data.get('event_id')
    if 'user_id' in data and str(data['user_id']) != str(current_user.id):
        return jsonify({'error': 'Account changed', 'code': 'account_changed'}), 403
    try:
        seconds = float(data.get('seconds', 0))
        timestamp = playback_timestamp(data.get('occurred_at'))
    except (TypeError, ValueError, AttributeError):
        return jsonify({'error': 'Invalid listening duration'}), 400

    if not song_id or not session_id or not math.isfinite(seconds) or not 0 < seconds <= 30:
        return jsonify({'error': 'Invalid listening duration'}), 400
    if event_id is not None and not valid_playback_id(event_id):
        return jsonify({'error': 'Invalid event ID'}), 400

    db = get_db()
    song = get_owned_song(db, song_id)
    if not song:
        return jsonify({'error': 'Not found'}), 404

    db.execute('BEGIN IMMEDIATE')
    if event_id:
        receipt = db.execute(
            'SELECT session_id, seconds FROM listening_receipts WHERE user_id = ? AND event_id = ?',
            (current_user.id, event_id),
        ).fetchone()
        if receipt:
            db.rollback()
            if receipt['session_id'] != session_id or receipt['seconds'] != seconds:
                return jsonify({'error': 'Event ID reused with different data'}), 409
            return jsonify({'status': 'ok', 'duplicate': True})

    playback = db.execute(
        'SELECT started_at, duration_seconds FROM playback_sessions WHERE id = ? AND song_id = ? AND user_id = ?',
        (session_id, song_id, current_user.id),
    ).fetchone()
    if not playback:
        db.rollback()
        return jsonify({'error': 'Playback session missing', 'code': 'session_missing'}), 409

    offline_reconciliation = timestamp < playback['started_at']
    accepted = db.execute(
        '''
        UPDATE playback_sessions
        SET seconds_listened = seconds_listened + ?
        WHERE id = ? AND song_id = ? AND user_id = ?
          AND seconds_listened + ? <= ?
          AND seconds_listened + ? <=
              CASE WHEN ? THEN COALESCE(duration_seconds, 0) + 10
                   ELSE ((julianday('now') - julianday(started_at)) * 86400) + 10
              END
        ''',
        (
            seconds, session_id, song_id, current_user.id,
            seconds, MAX_SESSION_LISTEN_SECONDS,
            seconds, offline_reconciliation,
        ),
    )
    if accepted.rowcount != 1:
        db.rollback()
        return jsonify({'error': 'Listening exceeds elapsed playback time', 'code': 'playback_time_exceeded'}), 409

    db.execute(
        'INSERT INTO listening_logs (song_id, user_id, seconds_listened, timestamp, song_title, song_artist) VALUES (?, ?, ?, ?, ?, ?)',
        (song_id, current_user.id, seconds, timestamp, song['title'] or '', song['artist'] or 'Unknown'),
    )
    if event_id:
        db.execute(
            'INSERT INTO listening_receipts (user_id, event_id, session_id, seconds) VALUES (?, ?, ?, ?)',
            (current_user.id, event_id, session_id, seconds),
        )
    db.commit()
    return jsonify({'status': 'ok'})


@recap_bp.route('/api/songs/<int:song_id>/play', methods=['POST'])
@login_required
def log_play(song_id):
    raw = request.get_json(silent=True)
    if raw is not None and not isinstance(raw, dict):
        return jsonify({'error': 'JSON object required'}), 400
    data = raw or {}
    if 'user_id' in data and str(data['user_id']) != str(current_user.id):
        return jsonify({'error': 'Account changed', 'code': 'account_changed'}), 403
    session_id = data.get('playback_session_id')
    if session_id is not None and not valid_playback_id(session_id):
        return jsonify({'error': 'Invalid playback ID'}), 400
    try:
        client_timestamp = playback_timestamp(data.get('occurred_at'))
    except (TypeError, ValueError, AttributeError):
        return jsonify({'error': 'Invalid playback timestamp'}), 400

    db = get_db()
    song = get_owned_song(db, song_id)
    if not song:
        return jsonify({'error': 'Not found'}), 404

    session_id = session_id or uuid.uuid4().hex
    db.execute('BEGIN IMMEDIATE')
    existing = db.execute('SELECT song_id, user_id FROM playback_sessions WHERE id = ?', (session_id,)).fetchone()
    if existing:
        db.rollback()
        if existing['song_id'] != song_id or existing['user_id'] != current_user.id:
            return jsonify({'error': 'Playback ID already in use'}), 409
        return jsonify({'status': 'ok', 'playback_session_id': session_id, 'duplicate': True})

    db.execute('UPDATE songs SET play_count = play_count + 1 WHERE id = ? AND user_id = ?', (song_id, current_user.id))
    db.execute(
        'INSERT INTO play_events (song_id, user_id, timestamp, song_title, song_artist) VALUES (?, ?, ?, ?, ?)',
        (song_id, current_user.id, client_timestamp, song['title'] or '', song['artist'] or 'Unknown'),
    )
    db.execute(
        'INSERT INTO playback_sessions (id, song_id, user_id, duration_seconds, started_at) VALUES (?, ?, ?, ?, ?)',
        (session_id, song_id, current_user.id, song['duration_seconds'], client_timestamp),
    )
    db.commit()
    return jsonify({'status': 'ok', 'playback_session_id': session_id})


_storage_cache = {'timestamp': 0, 'size': 0, 'key': None}


def _get_storage_used(download_dir, album_art_dir, ttl_seconds=30):
    global _storage_cache
    now = time.time()
    cache_key = (download_dir, album_art_dir)
    if _storage_cache['key'] == cache_key and (now - _storage_cache['timestamp']) < ttl_seconds:
        return _storage_cache['size']

    total_size = 0
    if download_dir and os.path.exists(download_dir):
        total_size += sum(os.path.getsize(os.path.join(dp, f)) for dp, dn, filenames in os.walk(download_dir) for f in filenames if os.path.isfile(os.path.join(dp, f)))
    if album_art_dir and os.path.exists(album_art_dir):
        total_size += sum(os.path.getsize(os.path.join(album_art_dir, f)) for f in os.listdir(album_art_dir) if os.path.isfile(os.path.join(album_art_dir, f)))

    _storage_cache = {'timestamp': now, 'size': total_size, 'key': cache_key}
    return total_size


_user_storage_cache = {}
_user_storage_cache_lock = Lock()


def _get_user_storage_used(db, user_id, library_dir, album_art_dir, ttl_seconds=30):
    now = time.time()
    cache_key = (user_id, library_dir, album_art_dir)
    with _user_storage_cache_lock:
        cached = _user_storage_cache.get(cache_key)
        if cached and (now - cached['timestamp']) < ttl_seconds:
            return cached['size']

    total_size = 0
    if library_dir and os.path.exists(library_dir):
        song_files = {
            row['filename']
            for row in db.execute(
                "SELECT DISTINCT filename FROM songs WHERE user_id = ? AND filename IS NOT NULL AND filename != ''",
                (user_id,),
            ).fetchall()
        }
        for fname in song_files:
            safe_name = secure_filename(fname)
            if not safe_name:
                continue
            fpath = os.path.join(library_dir, safe_name)
            if os.path.isfile(fpath):
                total_size += os.path.getsize(fpath)

    if album_art_dir and os.path.exists(album_art_dir):
        art_files = {
            row['album_art']
            for row in db.execute(
                "SELECT DISTINCT album_art FROM songs WHERE user_id = ? AND album_art IS NOT NULL AND album_art != ''",
                (user_id,),
            ).fetchall()
        }
        art_files.update(
            row['cover_art']
            for row in db.execute(
                "SELECT DISTINCT cover_art FROM playlists WHERE user_id = ? AND cover_art IS NOT NULL AND cover_art != ''",
                (user_id,),
            ).fetchall()
        )
        for fname in art_files:
            safe_name = secure_filename(fname)
            if not safe_name:
                continue
            fpath = os.path.join(album_art_dir, safe_name)
            if os.path.isfile(fpath):
                total_size += os.path.getsize(fpath)

    with _user_storage_cache_lock:
        _user_storage_cache[cache_key] = {'timestamp': now, 'size': total_size}
    return total_size


@recap_bp.route('/api/dashboard')
@login_required
def dashboard():
    db = get_db()
    cursor = db.cursor()
    cursor.execute('SELECT COUNT(*) as count FROM playlists WHERE user_id = ?', (current_user.id,))
    total_playlists = cursor.fetchone()['count']
    cursor.execute('SELECT COUNT(*) as count FROM songs WHERE user_id = ?', (current_user.id,))
    total_songs = cursor.fetchone()['count']
    cursor.execute('SELECT SUM(seconds_listened) as total_listened FROM listening_logs WHERE user_id = ?', (current_user.id,))
    total_listened = cursor.fetchone()['total_listened'] or 0

    download_dir = current_app.config.get('DOWNLOAD_DIR', '')
    library_dir = current_app.config.get('LIBRARY_DIR', '') or (os.path.join(download_dir, 'library') if download_dir else '')
    album_art_dir = current_app.config.get('ALBUM_ART_DIR', '')

    payload = {
        'total_playlists': total_playlists,
        'total_songs': total_songs,
        'total_listened': int(total_listened),
    }

    if is_admin():
        total_size = _get_storage_used(download_dir, album_art_dir)
        storage_usage = shutil.disk_usage(download_dir) if download_dir and os.path.exists(download_dir) else (0, 0, 0)
        free_space = storage_usage.free if hasattr(storage_usage, 'free') else 0
        total_space = storage_usage.total if hasattr(storage_usage, 'total') else 0
        payload.update({
            'storage_used': total_size,
            'storage_free': free_space,
            'storage_total': total_space,
        })
    else:
        payload['storage_used'] = _get_user_storage_used(db, current_user.id, library_dir, album_art_dir)

    return jsonify(payload)


@recap_bp.route('/api/top-songs')
@login_required
def top_songs():
    db = get_db()
    cursor = db.cursor()
    cursor.execute('''
        SELECT s.id, s.title, s.artist, s.filename, s.album_art, s.duration_seconds,
               COALESCE(s.play_count, 0) as play_count,
               COALESCE(SUM(l.seconds_listened), 0) as total_listened
        FROM songs s
        LEFT JOIN listening_logs l ON s.id = l.song_id AND l.user_id = ?
        WHERE s.user_id = ?
        GROUP BY s.id
        ORDER BY s.play_count DESC, total_listened DESC
        LIMIT 5
    ''', (current_user.id, current_user.id))
    return jsonify([dict(row) for row in cursor.fetchall()])


@recap_bp.route('/api/top-songs-duration')
@login_required
def top_songs_duration():
    db = get_db()
    cursor = db.cursor()
    cursor.execute('''
        SELECT s.id, s.title, s.artist, s.filename, s.album_art, s.duration_seconds,
               COALESCE(s.play_count, 0) as play_count,
               COALESCE(SUM(l.seconds_listened), 0) as total_listened
        FROM songs s 
        LEFT JOIN listening_logs l ON s.id = l.song_id AND l.user_id = ?
        WHERE s.user_id = ?
        GROUP BY s.id
        ORDER BY total_listened DESC
        LIMIT 5
    ''', (current_user.id, current_user.id))
    return jsonify([dict(row) for row in cursor.fetchall()])


@recap_bp.route('/api/recap', methods=['GET'])
@login_required
def get_recap():
    period = request.args.get('period', 'month')
    try:
        offset = int(request.args.get('tz_offset', 0))
        if period not in ('month', 'year') or not -840 <= offset <= 720:
            raise ValueError('Invalid period or timezone')
        now = datetime.now(timezone.utc) - timedelta(minutes=offset)
        year = int(request.args.get('year', now.year))
        month = int(request.args.get('month', now.month))
        if not 2 <= year <= 9998 or not 1 <= month <= 12:
            raise ValueError('Invalid year or month')
    except (ValueError, TypeError):
        return jsonify({'error': 'Invalid recap period or timezone'}), 400

    if period == 'month':
        last_day = calendar.monthrange(year, month)[1]
        start_date = datetime(year, month, 1)
        end_date = datetime(year, month, last_day, 23, 59, 59)
        label = start_date.strftime('%B %Y')
    else:
        start_date = datetime(year, 1, 1)
        end_date = datetime(year, 12, 31, 23, 59, 59)
        label = str(year)

    start_str = (start_date + timedelta(minutes=offset)).strftime('%Y-%m-%d %H:%M:%S')
    end_str = (end_date + timedelta(minutes=offset)).strftime('%Y-%m-%d %H:%M:%S')
    local_modifier = f'{-offset} minutes'

    db = get_db()

    listen_by_key = {}
    play_by_key = {}
    monthly_stats = {}
    top_song_by_month = {}
    monthly_breakdown = []

    if period == 'year':
        monthly_listen_rows = db.execute('''
            SELECT
                CAST(strftime('%m', datetime(l.timestamp, ?)) AS INTEGER) AS month_num,
                CASE
                    WHEN l.song_id IS NOT NULL THEN 'id:' || l.song_id
                    ELSE 'del:' || COALESCE(l.song_title, '') || '|' || COALESCE(l.song_artist, '')
                END AS song_key,
                MAX(s.id) AS id,
                COALESCE(MAX(s.title), NULLIF(MAX(l.song_title), ''), 'Deleted Song') AS title,
                COALESCE(MAX(s.artist), NULLIF(MAX(l.song_artist), ''), 'Unknown') AS artist,
                COALESCE(MAX(s.album_art), '') AS album_art,
                COALESCE(SUM(l.seconds_listened), 0) AS total_listened
            FROM listening_logs l
            LEFT JOIN songs s ON l.song_id = s.id
            WHERE l.user_id = ? AND l.timestamp >= ? AND l.timestamp <= ?
            GROUP BY month_num, song_key
        ''', (local_modifier, current_user.id, start_str, end_str)).fetchall()

        top_song_rank_key = {}
        for row in monthly_listen_rows:
            secs = row['total_listened'] or 0
            skey = row['song_key']
            agg = listen_by_key.get(skey)
            if agg is None:
                listen_by_key[skey] = {
                    'id': row['id'],
                    'title': row['title'],
                    'artist': row['artist'],
                    'album_art': row['album_art'],
                    'total_listened': secs,
                }
            else:
                agg['total_listened'] += secs
                if agg['id'] is None and row['id'] is not None:
                    agg['id'] = row['id']
                if not agg['album_art'] and row['album_art']:
                    agg['album_art'] = row['album_art']

            m = row['month_num']
            if m is not None and 1 <= m <= 12:
                mstat = monthly_stats.setdefault(m, {
                    'total_seconds': 0,
                    'unique_songs': 0,
                    'total_plays': 0,
                })
                mstat['total_seconds'] += secs
                mstat['unique_songs'] += 1
                prev = top_song_rank_key.get(m)
                if prev is None or secs > prev[0] or (secs == prev[0] and skey < prev[1]):
                    top_song_rank_key[m] = (secs, skey)
                    top_song_by_month[m] = {
                        'title': row['title'],
                        'artist': row['artist'],
                        'album_art': row['album_art'],
                        'total_listened': secs,
                    }

        monthly_play_rows = db.execute('''
            SELECT
                CAST(strftime('%m', datetime(pe.timestamp, ?)) AS INTEGER) AS month_num,
                CASE
                    WHEN pe.song_id IS NOT NULL THEN 'id:' || pe.song_id
                    ELSE 'del:' || COALESCE(pe.song_title, '') || '|' || COALESCE(pe.song_artist, '')
                END AS song_key,
                MAX(s.id) AS id,
                COALESCE(MAX(s.title), NULLIF(MAX(pe.song_title), ''), 'Deleted Song') AS title,
                COALESCE(MAX(s.artist), NULLIF(MAX(pe.song_artist), ''), 'Unknown') AS artist,
                COALESCE(MAX(s.album_art), '') AS album_art,
                COUNT(pe.id) AS play_count
            FROM play_events pe
            LEFT JOIN songs s ON pe.song_id = s.id
            WHERE pe.user_id = ? AND pe.timestamp >= ? AND pe.timestamp <= ?
            GROUP BY month_num, song_key
        ''', (local_modifier, current_user.id, start_str, end_str)).fetchall()

        for row in monthly_play_rows:
            pcount = row['play_count'] or 0
            skey = row['song_key']
            agg = play_by_key.get(skey)
            if agg is None:
                play_by_key[skey] = {
                    'id': row['id'],
                    'title': row['title'],
                    'artist': row['artist'],
                    'album_art': row['album_art'],
                    'play_count': pcount,
                }
            else:
                agg['play_count'] += pcount
                if agg['id'] is None and row['id'] is not None:
                    agg['id'] = row['id']
                if not agg['album_art'] and row['album_art']:
                    agg['album_art'] = row['album_art']

            m = row['month_num']
            if m is not None and 1 <= m <= 12:
                mstat = monthly_stats.setdefault(m, {
                    'total_seconds': 0,
                    'unique_songs': 0,
                    'total_plays': 0,
                })
                mstat['total_plays'] += pcount

        month_names = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
        for m in sorted(monthly_stats):
            monthly_breakdown.append({
                'month': month_names[m],
                'month_num': m,
                'total_seconds': monthly_stats[m]['total_seconds'],
                'unique_songs': monthly_stats[m]['unique_songs'],
                'total_plays': monthly_stats[m]['total_plays'],
                'top_song': top_song_by_month.get(m),
            })
    else:
        listen_rows = db.execute('''
            SELECT
                CASE
                    WHEN l.song_id IS NOT NULL THEN 'id:' || l.song_id
                    ELSE 'del:' || COALESCE(l.song_title, '') || '|' || COALESCE(l.song_artist, '')
                END AS song_key,
                MAX(s.id) AS id,
                COALESCE(MAX(s.title), NULLIF(MAX(l.song_title), ''), 'Deleted Song') AS title,
                COALESCE(MAX(s.artist), NULLIF(MAX(l.song_artist), ''), 'Unknown') AS artist,
                COALESCE(MAX(s.album_art), '') AS album_art,
                COALESCE(SUM(l.seconds_listened), 0) AS total_listened
            FROM listening_logs l
            LEFT JOIN songs s ON l.song_id = s.id
            WHERE l.user_id = ? AND l.timestamp >= ? AND l.timestamp <= ?
            GROUP BY song_key
        ''', (current_user.id, start_str, end_str)).fetchall()

        for row in listen_rows:
            listen_by_key[row['song_key']] = {
                'id': row['id'],
                'title': row['title'],
                'artist': row['artist'],
                'album_art': row['album_art'],
                'total_listened': row['total_listened'] or 0,
            }

        play_rows = db.execute('''
            SELECT
                CASE
                    WHEN pe.song_id IS NOT NULL THEN 'id:' || pe.song_id
                    ELSE 'del:' || COALESCE(pe.song_title, '') || '|' || COALESCE(pe.song_artist, '')
                END AS song_key,
                MAX(s.id) AS id,
                COALESCE(MAX(s.title), NULLIF(MAX(pe.song_title), ''), 'Deleted Song') AS title,
                COALESCE(MAX(s.artist), NULLIF(MAX(pe.song_artist), ''), 'Unknown') AS artist,
                COALESCE(MAX(s.album_art), '') AS album_art,
                COUNT(pe.id) AS play_count
            FROM play_events pe
            LEFT JOIN songs s ON pe.song_id = s.id
            WHERE pe.user_id = ? AND pe.timestamp >= ? AND pe.timestamp <= ?
            GROUP BY song_key
        ''', (current_user.id, start_str, end_str)).fetchall()

        for row in play_rows:
            play_by_key[row['song_key']] = {
                'id': row['id'],
                'title': row['title'],
                'artist': row['artist'],
                'album_art': row['album_art'],
                'play_count': row['play_count'] or 0,
            }

    peak_hour_row = db.execute('''
        SELECT CAST(strftime('%H', datetime(timestamp, ?)) AS INTEGER) as hour,
               SUM(seconds_listened) as total_seconds,
               COUNT(id) as count
        FROM listening_logs
        WHERE user_id = ? AND timestamp >= ? AND timestamp <= ?
        GROUP BY hour
        ORDER BY total_seconds DESC
        LIMIT 1
    ''', (local_modifier, current_user.id, start_str, end_str)).fetchone()

    top_played = sorted(
        (
            {
                'id': p['id'],
                'title': p['title'],
                'artist': p['artist'],
                'album_art': p['album_art'],
                'play_count': p['play_count'],
                'total_listened': listen_by_key[skey]['total_listened'] if skey in listen_by_key else 0,
            }
            for skey, p in play_by_key.items()
        ),
        key=lambda item: (item['play_count'], item['total_listened']),
        reverse=True,
    )[:10]

    top_listened = sorted(
        (
            {
                'id': l['id'],
                'title': l['title'],
                'artist': l['artist'],
                'album_art': l['album_art'],
                'total_listened': l['total_listened'],
                'play_count': play_by_key[skey]['play_count'] if skey in play_by_key else 0,
            }
            for skey, l in listen_by_key.items()
        ),
        key=lambda item: (item['total_listened'], item['play_count']),
        reverse=True,
    )[:10]

    stats = {
        'total_seconds': sum(item['total_listened'] for item in listen_by_key.values()),
        'unique_songs': len(listen_by_key),
        'total_plays': sum(item['play_count'] for item in play_by_key.values()),
    }

    result = {
        "period": {
            "type": period,
            "start": start_date.isoformat(),
            "end": end_date.isoformat(),
            "label": label
        },
        "top_played": top_played,
        "top_listened": top_listened,
        "peak_hour": dict(peak_hour_row) if peak_hour_row else None,
        "stats": stats
    }
    if monthly_breakdown:
        result["monthly_breakdown"] = monthly_breakdown

    return jsonify(result)
