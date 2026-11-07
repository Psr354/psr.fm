import calendar
import math
import os
import shutil
import time
import uuid
from datetime import datetime, timezone, timedelta
from flask import Blueprint, request, jsonify, current_app
from flask_login import login_required, current_user

from services.common import (
    get_db, get_owned_song, playback_timestamp, valid_playback_id
)

recap_bp = Blueprint('recap', __name__)


@recap_bp.route('/api/listen', methods=['POST'])
@login_required
def log_listen():
    data = request.get_json(silent=True) or {}
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
    if not get_owned_song(db, song_id):
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
          AND seconds_listened + ? <=
              CASE WHEN ? THEN duration_seconds + 10
                   ELSE ((julianday('now') - julianday(started_at)) * 86400) + 10
              END
        ''',
        (seconds, session_id, song_id, current_user.id, seconds, offline_reconciliation),
    )
    if accepted.rowcount != 1:
        db.rollback()
        return jsonify({'error': 'Listening exceeds elapsed playback time', 'code': 'playback_time_exceeded'}), 409

    db.execute(
        'INSERT INTO listening_logs (song_id, user_id, seconds_listened, timestamp) VALUES (?, ?, ?, ?)',
        (song_id, current_user.id, seconds, timestamp),
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
    data = request.get_json(silent=True) or {}
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
    db.execute('INSERT INTO play_events (song_id, user_id, timestamp) VALUES (?, ?, ?)', (song_id, current_user.id, client_timestamp))
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
    album_art_dir = current_app.config.get('ALBUM_ART_DIR', '')

    total_size = _get_storage_used(download_dir, album_art_dir)

    storage_usage = shutil.disk_usage(download_dir) if download_dir and os.path.exists(download_dir) else (0, 0, 0)
    free_space = storage_usage.free if hasattr(storage_usage, 'free') else 0
    total_space = storage_usage.total if hasattr(storage_usage, 'total') else 0

    return jsonify({
        'total_playlists': total_playlists,
        'total_songs': total_songs,
        'total_listened': int(total_listened),
        'storage_used': total_size,
        'storage_free': free_space,
        'storage_total': total_space
    })


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

    top_played_rows = db.execute('''
        SELECT s.id, s.title, s.artist, s.album_art, COUNT(pe.id) as play_count,
               COALESCE((SELECT SUM(l.seconds_listened) FROM listening_logs l
                         WHERE l.song_id = s.id AND l.user_id = pe.user_id
                           AND l.timestamp >= ? AND l.timestamp <= ?), 0) as total_listened
        FROM play_events pe
        JOIN songs s ON pe.song_id = s.id
        WHERE pe.user_id = ? AND pe.timestamp >= ? AND pe.timestamp <= ?
        GROUP BY s.id
        ORDER BY play_count DESC
        LIMIT 10
    ''', (start_str, end_str, current_user.id, start_str, end_str)).fetchall()

    top_listened_rows = db.execute('''
        SELECT s.id, s.title, s.artist, s.album_art,
               SUM(l.seconds_listened) as total_listened,
               (SELECT COUNT(pe.id) FROM play_events pe
                WHERE pe.song_id = s.id AND pe.user_id = l.user_id
                  AND pe.timestamp >= ? AND pe.timestamp <= ?) as play_count
        FROM listening_logs l
        JOIN songs s ON l.song_id = s.id
        WHERE l.user_id = ? AND l.timestamp >= ? AND l.timestamp <= ?
        GROUP BY s.id
        ORDER BY total_listened DESC
        LIMIT 10
    ''', (start_str, end_str, current_user.id, start_str, end_str)).fetchall()

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

    stats_row = db.execute('''
        SELECT 
            COALESCE(SUM(seconds_listened), 0) as total_seconds,
            COUNT(DISTINCT song_id) as unique_songs
        FROM listening_logs
        WHERE user_id = ? AND timestamp >= ? AND timestamp <= ?
    ''', (current_user.id, start_str, end_str)).fetchone()

    plays_row = db.execute('''
        SELECT COUNT(id) as total_plays
        FROM play_events
        WHERE user_id = ? AND timestamp >= ? AND timestamp <= ?
    ''', (current_user.id, start_str, end_str)).fetchone()

    monthly_breakdown = []
    if period == 'year':
        monthly_listening_rows = db.execute('''
            SELECT
                CAST(strftime('%m', datetime(timestamp, ?)) AS INTEGER) as month_num,
                COALESCE(SUM(seconds_listened), 0) as total_seconds,
                COUNT(DISTINCT song_id) as unique_songs
            FROM listening_logs
            WHERE user_id = ? AND timestamp >= ? AND timestamp <= ?
            GROUP BY month_num
            ORDER BY month_num
        ''', (local_modifier, current_user.id, start_str, end_str)).fetchall()
        monthly_play_rows = db.execute('''
            SELECT
                CAST(strftime('%m', datetime(timestamp, ?)) AS INTEGER) as month_num,
                COUNT(id) as total_plays
            FROM play_events
            WHERE user_id = ? AND timestamp >= ? AND timestamp <= ?
            GROUP BY month_num
            ORDER BY month_num
        ''', (local_modifier, current_user.id, start_str, end_str)).fetchall()

        monthly_stats = {
            row['month_num']: {
                'total_seconds': row['total_seconds'],
                'unique_songs': row['unique_songs'],
                'total_plays': 0,
            }
            for row in monthly_listening_rows
        }
        for row in monthly_play_rows:
            monthly_stats.setdefault(row['month_num'], {
                'total_seconds': 0,
                'unique_songs': 0,
                'total_plays': 0,
            })
            monthly_stats[row['month_num']]['total_plays'] = row['total_plays']

        month_names = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
        for m in sorted(monthly_stats):
            top_song = db.execute('''
                SELECT s.title, s.artist, s.album_art,
                       SUM(l.seconds_listened) as total_listened
                FROM listening_logs l JOIN songs s ON l.song_id = s.id
                WHERE l.user_id = ? AND strftime('%m', datetime(l.timestamp, ?)) = ?
                    AND l.timestamp >= ? AND l.timestamp <= ?
                GROUP BY s.id ORDER BY total_listened DESC LIMIT 1
            ''', (current_user.id, local_modifier, f'{m:02d}', start_str, end_str)).fetchone()
            monthly_breakdown.append({
                'month': month_names[m],
                'month_num': m,
                'total_seconds': monthly_stats[m]['total_seconds'],
                'unique_songs': monthly_stats[m]['unique_songs'],
                'total_plays': monthly_stats[m]['total_plays'],
                'top_song': dict(top_song) if top_song else None
            })

    stats = dict(stats_row) if stats_row else {"total_seconds": 0, "unique_songs": 0}
    stats["total_plays"] = plays_row["total_plays"] if plays_row else 0

    result = {
        "period": {
            "type": period,
            "start": start_date.isoformat(),
            "end": end_date.isoformat(),
            "label": label
        },
        "top_played": [dict(r) for r in top_played_rows],
        "top_listened": [dict(r) for r in top_listened_rows],
        "peak_hour": dict(peak_hour_row) if peak_hour_row else None,
        "stats": stats
    }
    if monthly_breakdown:
        result["monthly_breakdown"] = monthly_breakdown

    return jsonify(result)
