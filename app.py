import os
import sqlite3
import shutil
import uuid
from flask import Flask, request, jsonify, send_from_directory, render_template, g
from werkzeug.utils import secure_filename
from flask_socketio import SocketIO
from PIL import Image
import io

from services.database import init_db, get_db_connection
from services.downloader import download_queue, start_worker

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
DOWNLOAD_DIR = os.path.join(BASE_DIR, 'downloads')
LIBRARY_DIR = os.path.join(DOWNLOAD_DIR, 'library')
ALBUM_ART_DIR = os.path.join(BASE_DIR, 'static', 'album_art')
DATABASE_PATH = os.path.join(BASE_DIR, 'database.db')

os.makedirs(DOWNLOAD_DIR, exist_ok=True)
os.makedirs(LIBRARY_DIR, exist_ok=True)
os.makedirs(ALBUM_ART_DIR, exist_ok=True)
os.makedirs(os.path.join(BASE_DIR, 'logs'), exist_ok=True)

init_db(DATABASE_PATH)
start_worker(DATABASE_PATH, DOWNLOAD_DIR, ALBUM_ART_DIR, socketio)

def get_db():
    if 'db' not in g:
        g.db = get_db_connection(DATABASE_PATH)
    return g.db

@app.teardown_appcontext
def close_connection(exception):
    db = g.pop('db', None)
    if db is not None:
        db.close()

@app.route('/')
def index():
    return render_template('index.html')

# ==========================================
# PLAYLIST MANAGEMENT
# ==========================================
@app.route('/api/playlists', methods=['POST'])
def create_playlist():
    data = request.get_json()
    name = data.get('name')
    if not name:
        return jsonify({'error': 'Name is required'}), 400
    folder_name = secure_filename(name) or str(uuid.uuid4())
    db = get_db()
    cursor = db.cursor()
    cursor.execute('INSERT INTO playlists (name, folder_name) VALUES (?, ?)', (name, folder_name))
    db.commit()
    return jsonify({'status': 'success', 'id': cursor.lastrowid, 'folder_name': folder_name})

@app.route('/api/playlists', methods=['GET'])
def get_playlists():
    db = get_db()
    cursor = db.cursor()
    cursor.execute('SELECT * FROM playlists ORDER BY created_at DESC')
    return jsonify([dict(row) for row in cursor.fetchall()])

@app.route('/api/playlists/<int:playlist_id>', methods=['PUT'])
def rename_playlist(playlist_id):
    data = request.get_json()
    name = data.get('name')
    if not name:
        return jsonify({'error': 'Name required'}), 400
    db = get_db()
    db.execute('UPDATE playlists SET name = ? WHERE id = ?', (name, playlist_id))
    db.commit()
    return jsonify({'status': 'success'})

@app.route('/api/playlists/<int:playlist_id>/cover', methods=['POST'])
def upload_cover(playlist_id):
    if 'cover' not in request.files:
        return jsonify({'error': 'No file'}), 400
    
    file = request.files['cover']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400

    # ==========================================
    # SECURITY FIX: Validasi Konten dengan Pillow (PIL)
    # ==========================================
    try:
        # Baca isi file ke memory untuk diverifikasi
        file_bytes = file.read()
        file.seek(0)  # Reset pointer ke awal
        
        # Buka gambar menggunakan Pillow
        img = Image.open(io.BytesIO(file_bytes))
        
        # Verifikasi bahwa file benar-benar gambar yang valid (tidak korup)
        img.verify()
        
        # Setelah verify(), kita harus buka ulang karena verify() menutup file
        img = Image.open(io.BytesIO(file_bytes))
        
        # Cek format gambar yang diizinkan
        allowed_formats = ['JPEG', 'PNG', 'WEBP']
        if img.format not in allowed_formats:
            return jsonify({
                'error': f'Invalid image format: {img.format}. Only JPG, PNG, and WEBP are allowed.'
            }), 400
        
        # Tentukan ekstensi berdasarkan format asli
        ext_map = {
            'JPEG': '.jpg',
            'PNG': '.png',
            'WEBP': '.webp'
        }
        ext = ext_map[img.format]
        
    except Exception as e:
        # Jika Pillow gagal membuka file, berarti file bukan gambar atau korup
        return jsonify({
            'error': 'Invalid file content. The file is not a valid image or is corrupted.'
        }), 400

    # ==========================================
    # Simpan File dengan Ekstensi yang Valid
    # ==========================================
    filename = f"pl_cover_{playlist_id}{ext}"
    save_path = os.path.join(ALBUM_ART_DIR, filename)

    db = get_db()
    cursor = db.cursor()
    
    # Hapus cover lama jika ada
    cursor.execute('SELECT cover_art FROM playlists WHERE id = ?', (playlist_id,))
    old = cursor.fetchone()
    if old and old['cover_art']:
        old_path = os.path.join(ALBUM_ART_DIR, old['cover_art'])
        if os.path.exists(old_path):
            os.remove(old_path)

    # Simpan file
    file.seek(0)
    file.save(save_path)
    
    # Update database
    db.execute('UPDATE playlists SET cover_art = ? WHERE id = ?', (filename, playlist_id))
    db.commit()
    
    return jsonify({'status': 'success', 'cover_art': filename})

@app.route('/api/playlists/<int:playlist_id>', methods=['DELETE'])
def delete_playlist(playlist_id):
    db = get_db()
    db.execute('DELETE FROM playlist_songs WHERE playlist_id = ?', (playlist_id,))
    db.execute('DELETE FROM playlists WHERE id = ?', (playlist_id,))
    db.commit()
    return jsonify({'status': 'success'})

# ==========================================
# SONGS & DOWNLOAD (MANY-TO-MANY)
# ==========================================
@app.route('/api/download', methods=['POST'])
def download_song():
    data = request.get_json()
    url = data.get('url')
    playlist_ids = data.get('playlist_ids', [])
    if not url or not playlist_ids:
        return jsonify({'error': 'Missing data'}), 400

    download_queue.put({'url': url, 'playlist_ids': playlist_ids})
    return jsonify({'status': 'processing', 'url': url})

@app.route('/api/songs', methods=['GET'])
def get_songs():
    playlist_id = request.args.get('playlist_id')
    limit = request.args.get('limit', type=int)
    db = get_db()
    cursor = db.cursor()

    if playlist_id:
        cursor.execute('''
            SELECT s.* FROM songs s 
            JOIN playlist_songs ps ON s.id = ps.song_id 
            WHERE ps.playlist_id = ? 
            ORDER BY ps.added_at DESC
        ''', (playlist_id,))
    else:
        if limit:
            cursor.execute('SELECT * FROM songs ORDER BY created_at DESC LIMIT ?', (limit,))
        else:
            cursor.execute('SELECT * FROM songs ORDER BY created_at DESC')

    return jsonify([dict(row) for row in cursor.fetchall()])

@app.route('/api/songs/<int:song_id>', methods=['DELETE'])
def delete_song(song_id):
    db = get_db()
    cursor = db.cursor()
    cursor.execute('SELECT filename, album_art FROM songs WHERE id = ?', (song_id,))
    song = cursor.fetchone()
    if not song:
        return jsonify({'error': 'Not found'}), 404

    mp3 = os.path.join(LIBRARY_DIR, song['filename'])
    if os.path.exists(mp3):
        os.remove(mp3)
    if song['album_art']:
        art = os.path.join(ALBUM_ART_DIR, song['album_art'])
        if os.path.exists(art):
            os.remove(art)

    cursor.execute('DELETE FROM playlist_songs WHERE song_id = ?', (song_id,))
    cursor.execute('DELETE FROM listening_logs WHERE song_id = ?', (song_id,))
    cursor.execute('DELETE FROM songs WHERE id = ?', (song_id,))
    db.commit()
    return jsonify({'status': 'success'})

@app.route('/audio/<filename>')
def stream_audio(filename):
    return send_from_directory(LIBRARY_DIR, secure_filename(filename), mimetype='audio/mpeg')

@app.route('/api/search')
def search_songs():
    query = request.args.get('q', '')
    db = get_db()
    search_param = f"%{query}%"
    cursor = db.cursor()
    cursor.execute('SELECT * FROM songs WHERE title LIKE ? OR artist LIKE ? ORDER BY created_at DESC', (search_param, search_param))
    return jsonify([dict(row) for row in cursor.fetchall()])

# ==========================================
# LISTENING & STATS
# ==========================================
@app.route('/api/listen', methods=['POST'])
def log_listen():
    data = request.get_json()
    song_id = data.get('song_id')
    seconds = data.get('seconds', 0)
    if song_id and seconds > 0:
        db = get_db()
        db.execute('INSERT INTO listening_logs (song_id, seconds_listened) VALUES (?, ?)', (song_id, seconds))
        db.commit()
    return jsonify({'status': 'ok'})

@app.route('/api/songs/<int:song_id>/play', methods=['POST'])
def log_play(song_id):
    db = get_db()
    db.execute('UPDATE songs SET play_count = play_count + 1 WHERE id = ?', (song_id,))
    db.commit()
    return jsonify({'status': 'ok'})

@app.route('/api/dashboard')
def dashboard():
    db = get_db()
    cursor = db.cursor()
    cursor.execute('SELECT COUNT(*) as count FROM playlists')
    total_playlists = cursor.fetchone()['count']

    cursor.execute('SELECT COUNT(*) as count FROM songs')
    total_songs = cursor.fetchone()['count']

    cursor.execute('SELECT SUM(seconds_listened) as total_listened FROM listening_logs')
    total_listened = cursor.fetchone()['total_listened'] or 0

    total_size = sum(os.path.getsize(os.path.join(dp, f)) for dp, dn, filenames in os.walk(DOWNLOAD_DIR) for f in filenames if os.path.isfile(os.path.join(dp, f)))
    total_size += sum(os.path.getsize(os.path.join(ALBUM_ART_DIR, f)) for f in os.listdir(ALBUM_ART_DIR) if os.path.isfile(os.path.join(ALBUM_ART_DIR, f)))
    storage_usage = shutil.disk_usage(DOWNLOAD_DIR)

    return jsonify({
        'total_playlists': total_playlists,
        'total_songs': total_songs,
        'total_listened': int(total_listened),
        'storage_used': total_size,
        'storage_free': storage_usage.free,
        'storage_total': storage_usage.total
    })

@app.route('/api/top-songs')
def top_songs():
    db = get_db()
    cursor = db.cursor()
    cursor.execute('''
        SELECT s.id, s.title, s.artist, s.filename, s.album_art, s.duration_seconds,
               COALESCE(s.play_count, 0) as play_count,
               COALESCE(SUM(l.seconds_listened), 0) as total_listened
        FROM songs s
        LEFT JOIN listening_logs l ON s.id = l.song_id
        GROUP BY s.id
        ORDER BY s.play_count DESC, total_listened DESC
        LIMIT 5
    ''')
    return jsonify([dict(row) for row in cursor.fetchall()])

@app.route('/api/top-songs-duration')
def top_songs_duration():
    db = get_db()
    cursor = db.cursor()
    cursor.execute('''
        SELECT s.id, s.title, s.artist, s.filename, s.album_art, s.duration_seconds,
               COALESCE(s.play_count, 0) as play_count,
               COALESCE(SUM(l.seconds_listened), 0) as total_listened
        FROM songs s LEFT JOIN listening_logs l ON s.id = l.song_id
        GROUP BY s.id
        ORDER BY total_listened DESC
        LIMIT 5
    ''')
    return jsonify([dict(row) for row in cursor.fetchall()])


if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5000, debug=False, allow_unsafe_werkzeug=True)
