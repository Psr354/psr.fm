import json
import os
import re
import uuid
from flask import Blueprint, request, jsonify, send_from_directory, current_app
from flask_login import login_required, current_user
from werkzeug.utils import secure_filename

from services.common import (
    get_db, get_database_path, get_owned_playlist, get_owned_song, get_global_song,
    add_global_song_to_playlists, get_json_object, audio_mimetype,
    queue_file_deletion, save_validated_image, resolve_owned_playlists,
    collect_unreferenced_media_paths, check_download_rate_limit
)
from services.downloader import download_queue, validate_song_url, dispatch_lyrics_lookup
from services.database import extract_song_source_id

songs_bp = Blueprint('songs', __name__)

MAX_SONG_META_LENGTH = 200
SONG_LIST_COLUMNS = (
    'id, title, artist, filename, album_art, duration_seconds, '
    'source_url, source_id, play_count, lyrics_status, lyrics_updated_at, user_id, created_at'
)
SONG_LIST_COLUMNS_ALIASED = ', '.join(f's.{col.strip()}' for col in SONG_LIST_COLUMNS.split(','))


def _max_active_downloads_per_user():
    raw = os.environ.get('PSR_FM_MAX_ACTIVE_DOWNLOADS_PER_USER', '5').strip()
    try:
        return max(1, int(raw))
    except ValueError:
        return 5


def _user_storage_quota_bytes():
    raw = os.environ.get('PSR_FM_USER_STORAGE_QUOTA_MB', '2048').strip()
    try:
        mb = int(raw)
    except ValueError:
        mb = 2048
    return mb * 1024 * 1024 if mb > 0 else 0


def _calculate_user_audio_usage_bytes(db, user_id, library_dir):
    if not library_dir or not os.path.exists(library_dir):
        return 0
    total = 0
    rows = db.execute(
        "SELECT DISTINCT filename FROM songs WHERE user_id = ? AND filename IS NOT NULL AND filename != ''",
        (user_id,),
    ).fetchall()
    for row in rows:
        safe_name = secure_filename(row['filename'])
        if not safe_name:
            continue
        fpath = os.path.join(library_dir, safe_name)
        if os.path.isfile(fpath):
            total += os.path.getsize(fpath)
    return total


def _fallback_song_title(raw_filename):
    base = os.path.splitext(raw_filename or '')[0]
    cleaned = re.sub(r'[_\-]+', ' ', base)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    if not cleaned or not any(ch.isalnum() for ch in cleaned):
        return 'Untitled'
    return cleaned[:MAX_SONG_META_LENGTH]


def _library_audio_exists(filename):
    if not filename:
        return False
    library_dir = current_app.config.get('LIBRARY_DIR', '')
    if not library_dir:
        return False
    safe_name = secure_filename(filename)
    if not safe_name:
        return False
    return os.path.isfile(os.path.join(library_dir, safe_name))


def _maybe_dispatch_cloned_lyrics(source_song, song_id, created):
    if not created:
        return
    if (source_song['lyrics_status'] or 'none') == 'found':
        return
    if os.environ.get('PSR_FM_DISABLE_WORKER') == '1':
        return
    dispatch_lyrics_lookup(
        get_database_path(),
        song_id,
        source_song['title'],
        source_song['artist'],
        source_song['duration_seconds'] or 0,
    )


def _extract_embedded_artwork(file_path):
    """Extract raw embedded artwork bytes from MP3 (APIC), FLAC, or MP4/M4A files."""
    from mutagen import File as MutagenFile
    audio_file = MutagenFile(file_path)
    if not audio_file:
        return None
    if getattr(audio_file, 'pictures', None):
        return bytes(audio_file.pictures[0].data)
    tags = getattr(audio_file, 'tags', None)
    if not tags:
        return None
    if hasattr(tags, 'getall'):
        apics = tags.getall('APIC')
        if apics:
            return bytes(apics[0].data)
    if 'covr' in tags and tags['covr']:
        return bytes(tags['covr'][0])
    return None


def _save_reencoded_album_art(raw_bytes, album_art_dir):
    """Validate and re-encode embedded cover bytes via Pillow before saving to disk."""
    if not album_art_dir or not raw_bytes:
        return None, None
    return save_validated_image(raw_bytes, album_art_dir, f"upload_art_{uuid.uuid4().hex[:12]}")


@songs_bp.route('/api/download', methods=['POST'])
@login_required
def download_song():
    allowed, retry_after = check_download_rate_limit(current_user.id)
    if not allowed:
        return jsonify({'error': 'Too many download requests. Please try again later.', 'retry_after': retry_after}), 429

    data = get_json_object()
    if data is None:
        return jsonify({'error': 'JSON object required'}), 400
    url = data.get('url')
    playlist_ids = data.get('playlist_ids', [])
    if not url or not playlist_ids:
        return jsonify({'error': 'Missing data'}), 400
    is_valid, validation_error = validate_song_url(url)
    if not is_valid:
        return jsonify({'error': validation_error}), 400

    db = get_db()
    owned_playlist_ids, err_msg, err_code = resolve_owned_playlists(db, current_user.id, playlist_ids)
    if err_msg:
        return jsonify({'error': err_msg}), err_code

    source_id = extract_song_source_id(url)
    if source_id:
        candidate_songs = db.execute(
            'SELECT * FROM songs WHERE source_id = ? ORDER BY created_at ASC, id ASC',
            (source_id,)
        ).fetchall()
        source_song = next((row for row in candidate_songs if _library_audio_exists(row['filename'])), None)
        if source_song:
            song_id, created, added_playlist_ids, skipped_playlist_ids = add_global_song_to_playlists(
                db,
                source_song,
                owned_playlist_ids,
            )
            db.commit()
            _maybe_dispatch_cloned_lyrics(source_song, song_id, created)
            return jsonify({
                'status': 'added_from_library',
                'song_id': song_id,
                'created': created,
                'playlist_ids': added_playlist_ids,
                'skipped_playlist_ids': skipped_playlist_ids,
                'title': source_song['title'],
                'artist': source_song['artist'],
            })

    active_jobs = db.execute(
        "SELECT COUNT(*) AS count FROM download_jobs WHERE user_id = ? AND status IN ('queued', 'processing')",
        (current_user.id,),
    ).fetchone()['count']
    max_active = _max_active_downloads_per_user()
    if active_jobs >= max_active:
        return jsonify({'error': f'Too many active downloads (max {max_active}). Please wait for current jobs to finish.'}), 429

    download_queue.put({'url': url, 'playlist_ids': owned_playlist_ids, 'user_id': current_user.id})
    return jsonify({'status': 'processing', 'url': url})


@songs_bp.route('/api/upload', methods=['POST'])
@login_required
def upload_song():
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400

    allowed_extensions = {'.mp3', '.wav', '.flac', '.ogg', '.m4a'}
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in allowed_extensions:
        return jsonify({'error': f'Unsupported file format. Allowed: {", ".join(allowed_extensions)}'}), 400

    max_file_size = 50 * 1024 * 1024
    file.seek(0, os.SEEK_END)
    file_size = file.tell()
    file.seek(0)
    if file_size > max_file_size:
        return jsonify({'error': 'File too large. Maximum size is 50MB'}), 400

    title = (request.form.get('title') or '').strip()
    artist = (request.form.get('artist') or '').strip() or 'Unknown'
    if len(title) > MAX_SONG_META_LENGTH:
        return jsonify({'error': f'Title must be at most {MAX_SONG_META_LENGTH} characters'}), 400
    if len(artist) > MAX_SONG_META_LENGTH:
        return jsonify({'error': f'Artist must be at most {MAX_SONG_META_LENGTH} characters'}), 400

    playlist_ids_raw = request.form.get('playlist_ids', '[]')
    try:
        parsed_playlist_ids = json.loads(playlist_ids_raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return jsonify({'error': 'Invalid playlist data'}), 400

    db = get_db()
    owned_playlist_ids, err_msg, err_code = resolve_owned_playlists(db, current_user.id, parsed_playlist_ids)
    if err_msg:
        return jsonify({'error': err_msg}), err_code

    if not title:
        title = _fallback_song_title(file.filename)

    library_dir = current_app.config.get('LIBRARY_DIR', '')
    album_art_dir = current_app.config.get('ALBUM_ART_DIR', '')

    quota_bytes = _user_storage_quota_bytes()
    if quota_bytes > 0:
        current_usage = _calculate_user_audio_usage_bytes(db, current_user.id, library_dir)
        if current_usage + file_size > quota_bytes:
            return jsonify({'error': 'Storage quota exceeded for this account'}), 413

    unique_filename = f"{uuid.uuid4().hex}{ext}"
    save_path = os.path.join(library_dir, unique_filename)
    file.save(save_path)

    from services.metadata import extract_duration
    try:
        duration = extract_duration(save_path)
    except Exception:
        if os.path.exists(save_path):
            os.remove(save_path)
        current_app.logger.exception('Could not extract uploaded audio metadata')
        return jsonify({'error': 'The uploaded file is not a readable audio file'}), 400
    if duration <= 0:
        if os.path.exists(save_path):
            os.remove(save_path)
        return jsonify({'error': 'The uploaded file is not a readable audio file'}), 400

    album_art_filename = None
    album_art_path = None
    try:
        raw_art = _extract_embedded_artwork(save_path)
        if raw_art:
            album_art_filename, album_art_path = _save_reencoded_album_art(raw_art, album_art_dir)
    except Exception:
        if album_art_path and os.path.exists(album_art_path):
            os.remove(album_art_path)
        album_art_filename = None
        album_art_path = None

    try:
        cursor = db.execute(
            '''
            INSERT INTO songs (
                title, artist, filename, album_art, duration_seconds,
                source_url, source_id, lyrics, synced_lyrics, lyrics_status, lyrics_updated_at, user_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''',
            (title, artist, unique_filename, album_art_filename, duration, None, None, '', '', 'none', None, current_user.id)
        )
        song_id = cursor.lastrowid

        added_playlist_ids = []
        for playlist_id in owned_playlist_ids:
            cursor = db.execute(
                'SELECT 1 FROM playlist_songs WHERE playlist_id = ? AND song_id = ?',
                (playlist_id, song_id)
            )
            if cursor.fetchone():
                continue
            pos_cursor = db.execute(
                'SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_songs WHERE playlist_id = ?',
                (playlist_id,)
            )
            next_position = pos_cursor.fetchone()[0]
            db.execute(
                'INSERT INTO playlist_songs (playlist_id, song_id, position) VALUES (?, ?, ?)',
                (playlist_id, song_id, next_position)
            )
            added_playlist_ids.append(playlist_id)
        db.commit()
    except Exception:
        db.rollback()
        if os.path.exists(save_path):
            os.remove(save_path)
        if album_art_path and os.path.exists(album_art_path):
            os.remove(album_art_path)
        current_app.logger.exception('Uploaded song could not be saved')
        return jsonify({'error': 'Uploaded song could not be saved'}), 500

    try:
        sio = getattr(current_app, 'socketio', None)
        if sio:
            sio.emit('song_added', {
                'id': song_id,
                'title': title,
                'artist': artist,
                'filename': unique_filename,
                'album_art': album_art_filename,
                'duration_seconds': duration,
                'playlist_ids': added_playlist_ids,
            }, room=f'user_{current_user.id}')
    except Exception:
        current_app.logger.warning('Failed to emit song_added event after upload', exc_info=True)

    return jsonify({
        'status': 'success',
        'song_id': song_id,
        'title': title,
        'artist': artist,
        'filename': unique_filename,
        'album_art': album_art_filename,
        'duration_seconds': duration,
        'playlist_ids': added_playlist_ids,
    }), 201


@songs_bp.route('/api/library-songs', methods=['GET'])
@login_required
def get_library_songs():
    query = request.args.get('q', '').strip()
    try:
        limit = int(request.args.get('limit', 100))
        offset = int(request.args.get('offset', 0))
    except (TypeError, ValueError):
        return jsonify({'error': 'limit and offset must be integers'}), 400
    if not 1 <= limit <= 500 or offset < 0:
        return jsonify({'error': 'limit must be between 1 and 500 and offset cannot be negative'}), 400

    search_param = f"%{query}%"
    db = get_db()
    params = [current_user.id, current_user.id]
    where_clause = ''
    if query:
        where_clause = 'WHERE s.title LIKE ? OR s.artist LIKE ?'
        params.extend([search_param, search_param])

    cursor = db.execute(
        f'''
        WITH grouped AS (
            SELECT
                MIN(s.id) AS id,
                COUNT(DISTINCT s.user_id) AS owner_count,
                MAX(CASE WHEN s.user_id = ? THEN 1 ELSE 0 END) AS in_my_library,
                MAX(CASE WHEN s.user_id = ? THEN s.id ELSE NULL END) AS owned_song_id,
                MAX(s.created_at) AS latest_created_at
            FROM songs s
            {where_clause}
            GROUP BY CASE
                WHEN s.source_id IS NOT NULL AND s.source_id != '' THEN 'src:' || s.source_id
                ELSE 'file:' || s.filename
            END
        )
        SELECT
            s.id, s.title, s.artist, s.filename, s.album_art, s.duration_seconds,
            s.source_url, s.source_id, grouped.owner_count, grouped.in_my_library, grouped.owned_song_id
        FROM grouped
        JOIN songs s ON s.id = grouped.id
        ORDER BY grouped.latest_created_at DESC, s.title COLLATE NOCASE ASC
        LIMIT ? OFFSET ?
        ''',
        tuple(params + [limit, offset])
    )
    return jsonify([dict(row) for row in cursor.fetchall()])


@songs_bp.route('/api/library-songs/<int:song_id>/stream')
@login_required
def stream_library_song(song_id):
    db = get_db()
    song = db.execute(
        'SELECT id, title, artist, filename FROM songs WHERE id = ?',
        (song_id,)
    ).fetchone()
    if not song:
        return jsonify({'error': 'Not found'}), 404

    library_dir = current_app.config.get('LIBRARY_DIR', '')
    safe_filename = secure_filename(song['filename'])
    full_path = os.path.join(library_dir, safe_filename)
    if not os.path.exists(full_path):
        return jsonify({'error': 'Audio file not found'}), 404

    return send_from_directory(library_dir, safe_filename, mimetype=audio_mimetype(safe_filename))


@songs_bp.route('/api/library-songs/<int:song_id>/download')
@login_required
def download_library_song(song_id):
    """Download any song from Library Songs (including ones uploaded by other users)."""
    db = get_db()
    song = db.execute(
        'SELECT id, title, artist, filename FROM songs WHERE id = ?',
        (song_id,)
    ).fetchone()
    if not song:
        return jsonify({'error': 'Song not found'}), 404

    library_dir = current_app.config.get('LIBRARY_DIR', '')
    safe_filename = secure_filename(song['filename'])
    full_path = os.path.join(library_dir, safe_filename)
    if not os.path.exists(full_path):
        return jsonify({'error': 'Audio file not found'}), 404

    ext = os.path.splitext(safe_filename)[1] or '.mp3'
    download_name = f"{song['title']} - {song['artist'] or 'Unknown'}{ext}"
    download_name = secure_filename(download_name) or f"song{ext}"

    return send_from_directory(
        library_dir,
        safe_filename,
        mimetype=audio_mimetype(safe_filename),
        as_attachment=True,
        download_name=download_name
    )


@songs_bp.route('/api/library-songs/check-url')
@login_required
def check_library_song_url():
    url = request.args.get('url', '').strip()
    is_valid, validation_error = validate_song_url(url)
    if not is_valid:
        return jsonify({'matched': False, 'error': validation_error}), 400

    source_id = extract_song_source_id(url)
    if not source_id:
        return jsonify({'matched': False})

    db = get_db()
    candidates = db.execute(
        '''
        SELECT id, title, artist, filename, album_art, duration_seconds, source_url, source_id
        FROM songs
        WHERE source_id = ?
        ORDER BY created_at ASC, id ASC
        ''',
        (source_id,)
    ).fetchall()
    song = next((row for row in candidates if _library_audio_exists(row['filename'])), None)
    if not song:
        return jsonify({'matched': False, 'source_id': source_id})

    return jsonify({'matched': True, 'song': dict(song)})


@songs_bp.route('/api/library-songs/<int:song_id>/add', methods=['POST'])
@login_required
def add_library_song(song_id):
    data = get_json_object()
    if data is None:
        return jsonify({'error': 'JSON object required'}), 400
    db = get_db()
    owned_playlist_ids, err_msg, err_code = resolve_owned_playlists(db, current_user.id, data.get('playlist_ids', []))
    if err_msg:
        return jsonify({'error': err_msg}), err_code

    source_song = get_global_song(db, song_id)
    if not source_song:
        return jsonify({'error': 'Library song not found'}), 404
    if not _library_audio_exists(source_song['filename']):
        return jsonify({'error': 'Audio file not found on server'}), 404

    new_song_id, created, added_playlist_ids, skipped_playlist_ids = add_global_song_to_playlists(
        db,
        source_song,
        owned_playlist_ids,
    )
    db.commit()
    _maybe_dispatch_cloned_lyrics(source_song, new_song_id, created)
    return jsonify({
        'status': 'success',
        'song_id': new_song_id,
        'created': created,
        'playlist_ids': added_playlist_ids,
        'skipped_playlist_ids': skipped_playlist_ids,
        'title': source_song['title'],
        'artist': source_song['artist'],
    })


@songs_bp.route('/api/songs', methods=['GET'])
@login_required
def get_songs():
    playlist_id = request.args.get('playlist_id')
    raw_limit = request.args.get('limit')
    limit = None
    if raw_limit is not None:
        try:
            limit = int(raw_limit)
        except ValueError:
            return jsonify({'error': 'Invalid limit'}), 400
        if limit < 1 or limit > 500:
            return jsonify({'error': 'Limit must be between 1 and 500'}), 400
    db = get_db()
    cursor = db.cursor()
    if playlist_id:
        if not get_owned_playlist(db, playlist_id):
            return jsonify({'error': 'Playlist not found'}), 404
        cursor.execute(f'''
            SELECT {SONG_LIST_COLUMNS_ALIASED} FROM songs s 
            JOIN playlist_songs ps ON s.id = ps.song_id 
            WHERE ps.playlist_id = ? AND s.user_id = ?
            ORDER BY ps.position ASC, ps.added_at ASC
        ''', (playlist_id, current_user.id))
    else:
        if limit:
            cursor.execute(
                f'SELECT {SONG_LIST_COLUMNS} FROM songs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
                (current_user.id, limit),
            )
        else:
            cursor.execute(
                f'SELECT {SONG_LIST_COLUMNS} FROM songs WHERE user_id = ? ORDER BY created_at DESC',
                (current_user.id,),
            )
    return jsonify([dict(row) for row in cursor.fetchall()])


@songs_bp.route('/api/songs/<int:song_id>', methods=['DELETE'])
@login_required
def delete_song(song_id):
    playlist_id = None
    if 'playlist_id' in request.args:
        playlist_id = request.args.get('playlist_id', type=int)
        if playlist_id is None:
            return jsonify({'error': 'Invalid playlist id'}), 400

    db = get_db()
    cursor = db.cursor()
    try:
        db.execute('BEGIN IMMEDIATE')
        cursor.execute('SELECT filename, album_art FROM songs WHERE id = ? AND user_id = ?', (song_id, current_user.id))
        song = cursor.fetchone()
        if not song:
            db.rollback()
            return jsonify({'error': 'Not found'}), 404
        if playlist_id is not None:
            if not get_owned_playlist(db, playlist_id):
                db.rollback()
                return jsonify({'error': 'Playlist not found'}), 404

            membership = db.execute(
                'SELECT 1 FROM playlist_songs WHERE playlist_id = ? AND song_id = ?',
                (playlist_id, song_id)
            ).fetchone()
            if not membership:
                db.rollback()
                return jsonify({'error': 'Song not found in playlist'}), 404

            db.execute(
                'DELETE FROM playlist_songs WHERE playlist_id = ? AND song_id = ?',
                (playlist_id, song_id)
            )
            remaining_playlist_count = db.execute(
                'SELECT COUNT(*) AS count FROM playlist_songs WHERE song_id = ?',
                (song_id,)
            ).fetchone()['count']
            if remaining_playlist_count > 0:
                db.commit()
                return jsonify({
                    'status': 'removed_from_playlist',
                    'song_deleted': False,
                    'remaining_playlist_count': remaining_playlist_count,
                })

        cursor.execute('DELETE FROM playlist_songs WHERE song_id = ?', (song_id,))
        cursor.execute('DELETE FROM listening_logs WHERE song_id = ?', (song_id,))
        cursor.execute('DELETE FROM songs WHERE id = ?', (song_id,))

        library_dir = current_app.config.get('LIBRARY_DIR', '')
        album_art_dir = current_app.config.get('ALBUM_ART_DIR', '')
        files_to_delete = collect_unreferenced_media_paths(
            db,
            filenames=[song['filename']],
            art_files=[song['album_art']] if song['album_art'] else [],
            library_dir=library_dir,
            album_art_dir=album_art_dir,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    for path in files_to_delete:
        queue_file_deletion(path)

    return jsonify({
        'status': 'deleted',
        'song_deleted': True,
        'remaining_playlist_count': 0,
    })


@songs_bp.route('/api/songs/<int:song_id>/playlists', methods=['POST'])
@login_required
def add_owned_song_to_playlists(song_id):
    data = get_json_object()
    if data is None:
        return jsonify({'error': 'JSON object required'}), 400

    db = get_db()
    owned_playlist_ids, err_msg, err_code = resolve_owned_playlists(db, current_user.id, data.get('playlist_ids', []))
    if err_msg:
        return jsonify({'error': err_msg}), err_code

    song = get_owned_song(db, song_id)
    if not song:
        return jsonify({'error': 'Song not found'}), 404

    added_playlist_ids = []
    skipped_playlist_ids = []
    for playlist_id in owned_playlist_ids:
        existing = db.execute(
            'SELECT 1 FROM playlist_songs WHERE playlist_id = ? AND song_id = ?',
            (playlist_id, song_id)
        ).fetchone()
        if existing:
            skipped_playlist_ids.append(playlist_id)
            continue

        cursor = db.execute(
            'SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_songs WHERE playlist_id = ?',
            (playlist_id,)
        )
        next_position = cursor.fetchone()[0]
        db.execute(
            'INSERT INTO playlist_songs (playlist_id, song_id, position) VALUES (?, ?, ?)',
            (playlist_id, song_id, next_position)
        )
        added_playlist_ids.append(playlist_id)

    db.commit()
    return jsonify({
        'status': 'success',
        'song_id': song_id,
        'playlist_ids': added_playlist_ids,
        'skipped_playlist_ids': skipped_playlist_ids,
        'title': song['title'],
        'artist': song['artist'],
    })


@songs_bp.route('/audio/<filename>')
@login_required
def stream_audio(filename):
    safe_filename = secure_filename(filename)
    db = get_db()
    song = db.execute(
        'SELECT id, title, artist, filename FROM songs WHERE filename = ? AND user_id = ?',
        (safe_filename, current_user.id)
    ).fetchone()
    if not song:
        return jsonify({'error': 'Not found'}), 404
    library_dir = current_app.config.get('LIBRARY_DIR', '')

    accel_prefix = os.environ.get('PSR_FM_ACCEL_REDIRECT_PREFIX')
    if accel_prefix:
        response = current_app.response_class()
        response.headers['X-Accel-Redirect'] = f"{accel_prefix.rstrip('/')}/{safe_filename}"
        response.headers['Content-Type'] = audio_mimetype(safe_filename)
        return response

    return send_from_directory(library_dir, safe_filename, mimetype=audio_mimetype(safe_filename))


@songs_bp.route('/api/songs/<int:song_id>/offline-audio')
@login_required
def download_offline_audio(song_id):
    """Return a complete audio response for the browser's offline cache."""
    db = get_db()
    song = get_owned_song(db, song_id)
    if not song:
        return jsonify({'error': 'Not found'}), 404
    library_dir = current_app.config.get('LIBRARY_DIR', '')
    return send_from_directory(
        library_dir,
        secure_filename(song['filename']),
        mimetype=audio_mimetype(song['filename']),
        conditional=False,
    )


@songs_bp.route('/api/songs/<int:song_id>/download')
@login_required
def download_song_file(song_id):
    db = get_db()
    song = get_owned_song(db, song_id)
    if not song:
        return jsonify({'error': 'Not found'}), 404

    library_dir = current_app.config.get('LIBRARY_DIR', '')
    safe_filename = secure_filename(song['filename'])
    full_path = os.path.join(library_dir, safe_filename)
    if not os.path.exists(full_path):
        return jsonify({'error': 'Audio file not found'}), 404

    ext = os.path.splitext(safe_filename)[1] or '.mp3'
    download_name = f"{song['title']} - {song['artist'] or 'Unknown'}{ext}"
    download_name = secure_filename(download_name) or f"song{ext}"

    return send_from_directory(
        library_dir,
        safe_filename,
        mimetype=audio_mimetype(safe_filename),
        as_attachment=True,
        download_name=download_name
    )


@songs_bp.route('/api/search')
@login_required
def search_songs():
    query = request.args.get('q', '').strip()
    try:
        limit = int(request.args.get('limit', 100))
        offset = int(request.args.get('offset', 0))
    except (TypeError, ValueError):
        return jsonify({'error': 'limit and offset must be integers'}), 400
    if not 1 <= limit <= 500 or offset < 0:
        return jsonify({'error': 'limit must be between 1 and 500 and offset cannot be negative'}), 400
    db = get_db()
    search_param = f"%{query}%"
    cursor = db.cursor()
    cursor.execute(f'''
        SELECT {SONG_LIST_COLUMNS} FROM songs
        WHERE user_id = ? AND (title LIKE ? OR artist LIKE ?)
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
    ''', (current_user.id, search_param, search_param, limit, offset))
    return jsonify([dict(row) for row in cursor.fetchall()])
