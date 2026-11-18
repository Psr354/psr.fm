import os
import uuid
from flask import Blueprint, request, jsonify, current_app
from flask_login import login_required, current_user
from werkzeug.utils import secure_filename

from services.common import (
    get_db, get_owned_playlist, get_json_object, queue_file_deletion,
    save_validated_image, collect_unreferenced_media_paths, DEFAULT_MAX_IMAGE_BYTES
)

playlists_bp = Blueprint('playlists', __name__)


@playlists_bp.route('/api/playlists', methods=['POST'])
@login_required
def create_playlist():
    data = get_json_object()
    if data is None:
        return jsonify({'error': 'JSON object required'}), 400
    name = data.get('name')
    if not isinstance(name, str) or not name.strip():
        return jsonify({'error': 'Name is required'}), 400
    name = name.strip()
    if len(name) > 200:
        return jsonify({'error': 'Name is too long'}), 400
    folder_name = secure_filename(name) or str(uuid.uuid4())
    db = get_db()
    cursor = db.cursor()
    cursor.execute('INSERT INTO playlists (name, folder_name, user_id) VALUES (?, ?, ?)', (name, folder_name, current_user.id))
    db.commit()
    return jsonify({'status': 'success', 'id': cursor.lastrowid, 'folder_name': folder_name})


@playlists_bp.route('/api/playlists', methods=['GET'])
@login_required
def get_playlists():
    db = get_db()
    cursor = db.cursor()
    cursor.execute('SELECT * FROM playlists WHERE user_id = ? ORDER BY created_at DESC', (current_user.id,))
    return jsonify([dict(row) for row in cursor.fetchall()])


@playlists_bp.route('/api/playlists/<int:playlist_id>', methods=['PUT'])
@login_required
def rename_playlist(playlist_id):
    data = get_json_object()
    if data is None:
        return jsonify({'error': 'JSON object required'}), 400
    name = data.get('name')
    if not isinstance(name, str) or not name.strip():
        return jsonify({'error': 'Name required'}), 400
    name = name.strip()
    if len(name) > 200:
        return jsonify({'error': 'Name is too long'}), 400
    db = get_db()
    cursor = db.execute('UPDATE playlists SET name = ? WHERE id = ? AND user_id = ?', (name, playlist_id, current_user.id))
    db.commit()
    if cursor.rowcount == 0:
        return jsonify({'error': 'Playlist not found'}), 404
    return jsonify({'status': 'success'})


@playlists_bp.route('/api/playlists/<int:playlist_id>/cover', methods=['POST'])
@login_required
def upload_cover(playlist_id):
    db = get_db()
    if not get_owned_playlist(db, playlist_id):
        return jsonify({'error': 'Playlist not found'}), 404

    if 'cover' not in request.files:
        return jsonify({'error': 'No file'}), 400
    file = request.files['cover']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400

    album_art_dir = current_app.config.get('ALBUM_ART_DIR', '')
    file_bytes = file.read(DEFAULT_MAX_IMAGE_BYTES + 1)
    if len(file_bytes) > DEFAULT_MAX_IMAGE_BYTES:
        return jsonify({'error': 'Cover image is too large. Maximum size is 5MB'}), 400

    prefix = f"pl_cover_{playlist_id}_{uuid.uuid4().hex[:8]}"
    try:
        filename, save_path = save_validated_image(file_bytes, album_art_dir, prefix)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    except Exception:
        return jsonify({'error': 'Invalid or corrupted image file'}), 400

    old = db.execute(
        'SELECT cover_art FROM playlists WHERE id = ? AND user_id = ?',
        (playlist_id, current_user.id),
    ).fetchone()
    old_cover = old['cover_art'] if old else ''

    old_paths_to_delete = []
    try:
        db.execute(
            'UPDATE playlists SET cover_art = ? WHERE id = ? AND user_id = ?',
            (filename, playlist_id, current_user.id),
        )
        if old_cover and old_cover != filename and album_art_dir:
            old_paths_to_delete = collect_unreferenced_media_paths(
                db,
                art_files=[old_cover],
                album_art_dir=album_art_dir,
            )
        db.commit()
    except Exception:
        db.rollback()
        if save_path and os.path.exists(save_path):
            os.remove(save_path)
        current_app.logger.exception('Failed to update playlist cover')
        return jsonify({'error': 'Failed to save playlist cover'}), 500

    for old_path in old_paths_to_delete:
        queue_file_deletion(old_path)

    return jsonify({'status': 'success', 'cover_art': filename})


@playlists_bp.route('/api/playlists/<int:playlist_id>', methods=['DELETE'])
@login_required
def delete_playlist(playlist_id):
    db = get_db()
    files_to_delete = []
    orphaned_count = 0

    try:
        db.execute('BEGIN IMMEDIATE')
        playlist = get_owned_playlist(db, playlist_id)
        if not playlist:
            db.rollback()
            return jsonify({'error': 'Playlist not found'}), 404

        cover_art = playlist['cover_art'] if 'cover_art' in playlist.keys() else None

        playlist_songs = db.execute(
            '''
            SELECT s.id, s.filename, s.album_art
            FROM songs s
            JOIN playlist_songs ps ON ps.song_id = s.id
            WHERE ps.playlist_id = ? AND s.user_id = ?
            ''',
            (playlist_id, current_user.id)
        ).fetchall()

        db.execute('DELETE FROM playlist_songs WHERE playlist_id = ?', (playlist_id,))
        db.execute('DELETE FROM playlists WHERE id = ? AND user_id = ?', (playlist_id, current_user.id))

        orphaned_songs = []
        for song in playlist_songs:
            still_in_playlist = db.execute(
                'SELECT 1 FROM playlist_songs WHERE song_id = ? LIMIT 1',
                (song['id'],)
            ).fetchone()
            if not still_in_playlist:
                orphaned_songs.append(song)
                db.execute('DELETE FROM listening_logs WHERE song_id = ?', (song['id'],))
                db.execute('DELETE FROM play_events WHERE song_id = ?', (song['id'],))
                db.execute('DELETE FROM songs WHERE id = ? AND user_id = ?', (song['id'], current_user.id))

        orphaned_count = len(orphaned_songs)
        library_dir = current_app.config.get('LIBRARY_DIR', '')
        album_art_dir = current_app.config.get('ALBUM_ART_DIR', '')

        files_to_delete = collect_unreferenced_media_paths(
            db,
            filenames=[song['filename'] for song in orphaned_songs],
            art_files=[song['album_art'] for song in orphaned_songs if song['album_art']] + ([cover_art] if cover_art else []),
            library_dir=library_dir,
            album_art_dir=album_art_dir,
        )

        db.commit()
    except Exception:
        db.rollback()
        raise

    for path in dict.fromkeys(files_to_delete):
        queue_file_deletion(path)

    return jsonify({
        'status': 'success',
        'deleted_orphaned_songs': orphaned_count,
    })


@playlists_bp.route('/api/playlists/<int:playlist_id>/songs/order', methods=['PUT'])
@login_required
def reorder_playlist_songs(playlist_id):
    db = get_db()
    if not get_owned_playlist(db, playlist_id):
        return jsonify({'error': 'Playlist not found'}), 404

    data = get_json_object()
    if data is None:
        return jsonify({'error': 'JSON object required'}), 400
    song_ids = data.get('song_ids', [])
    if not isinstance(song_ids, list):
        return jsonify({'error': 'song_ids must be a list'}), 400

    try:
        ordered_song_ids = [int(song_id) for song_id in song_ids]
    except (TypeError, ValueError):
        return jsonify({'error': 'Invalid song order'}), 400

    if len(ordered_song_ids) != len(set(ordered_song_ids)):
        return jsonify({'error': 'Duplicate song ids are not allowed'}), 400

    cursor = db.execute(
        '''
        SELECT ps.song_id
        FROM playlist_songs ps
        JOIN songs s ON s.id = ps.song_id
        WHERE ps.playlist_id = ? AND s.user_id = ?
        ''',
        (playlist_id, current_user.id)
    )
    existing_song_ids = {row['song_id'] for row in cursor.fetchall()}
    if set(ordered_song_ids) != existing_song_ids:
        return jsonify({'error': 'Song order must include every song in the playlist'}), 400

    for position, song_id in enumerate(ordered_song_ids):
        db.execute(
            'UPDATE playlist_songs SET position = ? WHERE playlist_id = ? AND song_id = ?',
            (position, playlist_id, song_id)
        )
    db.commit()
    return jsonify({'status': 'success'})
