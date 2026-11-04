import io
import os
import uuid
from flask import Blueprint, request, jsonify, current_app
from flask_login import login_required, current_user
from werkzeug.utils import secure_filename
from PIL import Image

from services.common import (
    get_db, get_owned_playlist, get_json_object, queue_file_deletion
)

playlists_bp = Blueprint('playlists', __name__)


@playlists_bp.route('/api/playlists', methods=['POST'])
@login_required
def create_playlist():
    data = get_json_object()
    if data is None:
        return jsonify({'error': 'JSON object required'}), 400
    name = data.get('name')
    if not name:
        return jsonify({'error': 'Name is required'}), 400
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
    if not name:
        return jsonify({'error': 'Name required'}), 400
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

    try:
        max_cover_size = 5 * 1024 * 1024
        file_bytes = file.read(max_cover_size + 1)
        if len(file_bytes) > max_cover_size:
            return jsonify({'error': 'Cover image is too large. Maximum size is 5MB'}), 400
        file.seek(0)
        img = Image.open(io.BytesIO(file_bytes))
        img.verify()
        img = Image.open(io.BytesIO(file_bytes))
        allowed_formats = ['JPEG', 'PNG', 'WEBP']
        if img.format not in allowed_formats:
            return jsonify({'error': f'Invalid image format: {img.format}'}), 400
        width, height = img.size
        if width * height > 25_000_000 or width > 8000 or height > 8000:
            return jsonify({'error': 'Cover image dimensions are too large'}), 400
        ext_map = {'JPEG': '.jpg', 'PNG': '.png', 'WEBP': '.webp'}
        ext = ext_map[img.format]
    except Exception:
        return jsonify({'error': 'Invalid or corrupted image file'}), 400

    filename = f"pl_cover_{playlist_id}{ext}"
    save_path = os.path.join(album_art_dir, filename)
    cursor = db.cursor()
    cursor.execute('SELECT cover_art FROM playlists WHERE id = ? AND user_id = ?', (playlist_id, current_user.id))
    old = cursor.fetchone()
    if old and old['cover_art'] and album_art_dir:
        old_path = os.path.join(album_art_dir, old['cover_art'])
        if os.path.exists(old_path):
            os.remove(old_path)

    file.seek(0)
    file.save(save_path)
    db.execute('UPDATE playlists SET cover_art = ? WHERE id = ? AND user_id = ?', (filename, playlist_id, current_user.id))
    db.commit()
    return jsonify({'status': 'success', 'cover_art': filename})


@playlists_bp.route('/api/playlists/<int:playlist_id>', methods=['DELETE'])
@login_required
def delete_playlist(playlist_id):
    db = get_db()
    if not get_owned_playlist(db, playlist_id):
        return jsonify({'error': 'Playlist not found'}), 404

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

    db.commit()

    library_dir = current_app.config.get('LIBRARY_DIR', '')
    album_art_dir = current_app.config.get('ALBUM_ART_DIR', '')

    for song in orphaned_songs:
        filename_in_use = db.execute(
            'SELECT 1 FROM songs WHERE filename = ? LIMIT 1',
            (song['filename'],)
        ).fetchone()
        if not filename_in_use and library_dir:
            mp3 = os.path.join(library_dir, song['filename'])
            queue_file_deletion(mp3)

        if song['album_art'] and album_art_dir:
            album_art_in_use = db.execute(
                'SELECT 1 FROM songs WHERE album_art = ? LIMIT 1',
                (song['album_art'],)
            ).fetchone()
            if not album_art_in_use:
                art = os.path.join(album_art_dir, song['album_art'])
                queue_file_deletion(art)

    return jsonify({
        'status': 'success',
        'deleted_orphaned_songs': len(orphaned_songs),
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
