import os
import uuid
import queue
import threading
from urllib.parse import urlparse
import yt_dlp
import requests
from werkzeug.utils import secure_filename
from services.metadata import extract_duration
from services.database import get_db_connection, update_song_lyrics
from services.lyrics import search_lyrics

download_queue = queue.Queue()
socketio_instance = None
MAX_DOWNLOAD_DURATION_SECONDS = 600
YOUTUBE_HTTP_HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        'AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/120.0.0.0 Safari/537.36'
    ),
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.youtube.com/',
}
YTDLP_NETWORK_OPTIONS = {
    'http_headers': YOUTUBE_HTTP_HEADERS,
    'socket_timeout': 30,
    'retries': 3,
}


def validate_youtube_url(url):
    if not url or not isinstance(url, str):
        return False, 'URL is required'

    parsed = urlparse(url.strip())
    host = parsed.netloc.lower()
    if host.startswith('www.'):
        host = host[4:]

    allowed_hosts = {'youtube.com', 'm.youtube.com', 'youtu.be'}
    if parsed.scheme not in ('http', 'https') or host not in allowed_hosts:
        return False, 'Only YouTube URLs are allowed'

    return True, ''

def download_worker(db_path, download_dir, album_art_dir, sio):
    global socketio_instance
    socketio_instance = sio
    os.makedirs(os.path.join(download_dir, 'library'), exist_ok=True)
    while True:
        task = download_queue.get()
        if task is None: break
        try: process_download(task, db_path, download_dir, album_art_dir)
        except Exception as e:
            print(f"Error: {e}")
            if socketio_instance: socketio_instance.emit('download_error', {'url': task['url'], 'error': str(e)}, room=f"user_{task['user_id']}")
        finally: download_queue.task_done()


def add_song_to_playlists(cursor, song_id, playlist_ids):
    for pid in playlist_ids:
        existing = cursor.execute(
            'SELECT 1 FROM playlist_songs WHERE playlist_id = ? AND song_id = ?',
            (pid, song_id),
        ).fetchone()
        if existing:
            continue
        cursor.execute(
            'SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_songs WHERE playlist_id = ?',
            (pid,),
        )
        next_position = cursor.fetchone()[0]
        cursor.execute(
            'INSERT INTO playlist_songs (playlist_id, song_id, position) VALUES (?, ?, ?)',
            (pid, song_id, next_position),
        )


def emit_song_added(song, playlist_ids):
    if not socketio_instance:
        return
    socketio_instance.emit('song_added', {
        'id': song['id'],
        'playlist_ids': playlist_ids,
        'title': song['title'],
        'artist': song['artist'],
        'filename': song['filename'],
        'album_art': song['album_art'],
        'duration_seconds': song['duration_seconds'],
        'source_url': song['source_url'],
        'source_id': song['source_id'],
    }, room=f"user_{song['user_id']}")

def process_download(task, db_path, download_dir, album_art_dir):
    url = task['url']
    playlist_ids = task['playlist_ids']
    user_id = task['user_id']

    is_valid, validation_error = validate_youtube_url(url)
    if not is_valid:
        raise Exception(validation_error)
    
    def progress_hook(d):
        if socketio_instance:
            if d['status'] == 'downloading':
                percent_str = d.get('_percent_str', '0%').strip().replace('%', '').replace(' ', '')
                try: percent = float(percent_str)
                except: percent = 0
                socketio_instance.emit('download_progress', {'url': url, 'percent': percent}, room=f'user_{user_id}')
            elif d['status'] == 'finished':
                socketio_instance.emit('download_progress', {'url': url, 'percent': 100}, room=f'user_{user_id}')

    ydl_opts_info = {
        'quiet': True,
        'no_warnings': True,
        'extract_flat': False,
        **YTDLP_NETWORK_OPTIONS,
    }
    with yt_dlp.YoutubeDL(ydl_opts_info) as ydl:
        info = ydl.extract_info(url, download=False)
        title = info.get('title', 'Unknown')
        artist = info.get('uploader', 'Unknown')
        thumbnail_url = info.get('thumbnail', '')
        duration = info.get('duration', 0) or 0
        source_id = info.get('id') or ''
        source_url = info.get('webpage_url') or url

    if duration and duration > MAX_DOWNLOAD_DURATION_SECONDS:
        raise Exception('Video exceeds the 10 minute limit')

    # Recheck after yt-dlp resolves the canonical video ID. This covers queued
    # requests whose initial URL lookup happened before another download ended.
    if source_id:
        conn = get_db_connection(db_path)
        existing_song = conn.execute(
            'SELECT * FROM songs WHERE user_id = ? AND source_id = ? ORDER BY id LIMIT 1',
            (user_id, source_id),
        ).fetchone()
        if existing_song:
            add_song_to_playlists(conn.cursor(), existing_song['id'], playlist_ids)
            conn.commit()
            conn.close()
            emit_song_added(existing_song, playlist_ids)
            return
        conn.close()
        
    file_uuid = str(uuid.uuid4())
    library_dir = os.path.join(download_dir, 'library')
    
    ydl_opts_download = {
        'format': 'bestaudio/best',
        'postprocessors': [{'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3', 'preferredquality': '192'}],
        'outtmpl': os.path.join(library_dir, file_uuid),
        'quiet': True,
        'no_warnings': True,
        'progress_hooks': [progress_hook],
        **YTDLP_NETWORK_OPTIONS,
    }
    
    with yt_dlp.YoutubeDL(ydl_opts_download) as ydl: ydl.download([url])
        
    expected_file = f"{file_uuid}.mp3"
    if not os.path.exists(os.path.join(library_dir, expected_file)): raise Exception("Audio missing")
        
    duration_seconds = extract_duration(os.path.join(library_dir, expected_file))
    if duration_seconds == 0 and duration > 0: duration_seconds = int(duration)
        
    album_art_filename = ""
    if thumbnail_url:
        art_ext = os.path.splitext(thumbnail_url)[-1].split('?')[0]
        if art_ext not in ['.jpg', '.jpeg', '.png', '.webp']: art_ext = '.jpg'
        album_art_filename = f"{file_uuid}{art_ext}"
        try:
            r = requests.get(
                thumbnail_url,
                timeout=10,
                headers=YOUTUBE_HTTP_HEADERS,
            )
            if r.status_code == 200:
                with open(os.path.join(album_art_dir, album_art_filename), 'wb') as f: f.write(r.content)
        except: pass
            
    conn = get_db_connection(db_path)
    try:
        # Serialize the final lookup and insert so concurrent workers cannot both
        # create a row for the same user and canonical YouTube video.
        conn.execute('BEGIN IMMEDIATE')
        existing_song = None
        if source_id:
            existing_song = conn.execute(
                'SELECT * FROM songs WHERE user_id = ? AND source_id = ? ORDER BY id LIMIT 1',
                (user_id, source_id),
            ).fetchone()

        cursor = conn.cursor()
        if existing_song:
            song_id = existing_song['id']
        else:
            cursor.execute(
                '''
                INSERT INTO songs (title, artist, filename, album_art, duration_seconds, source_url, source_id, user_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ''',
                (title, artist, expected_file, album_art_filename, duration_seconds, source_url, source_id, user_id)
            )
            song_id = cursor.lastrowid

        add_song_to_playlists(cursor, song_id, playlist_ids)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    if existing_song:
        os.remove(os.path.join(library_dir, expected_file))
        if album_art_filename:
            album_art_path = os.path.join(album_art_dir, album_art_filename)
            if os.path.exists(album_art_path):
                os.remove(album_art_path)
        emit_song_added(existing_song, playlist_ids)
        return

    try:
        lyrics_data = search_lyrics(title, artist, duration_seconds)
        if lyrics_data:
            update_song_lyrics(
                db_path,
                song_id,
                lyrics_data.get('lyrics', ''),
                lyrics_data.get('synced_lyrics', ''),
                'found',
            )
        else:
            update_song_lyrics(db_path, song_id, '', '', 'not_found')
    except Exception as exc:
        print(f"[WARN] lyrics lookup failed for {song_id}: {exc}")

    emit_song_added({
        'id': song_id,
        'playlist_ids': playlist_ids,
        'title': title,
        'artist': artist,
        'filename': expected_file,
        'album_art': album_art_filename,
        'duration_seconds': duration_seconds,
        'source_url': source_url,
        'source_id': source_id,
        'user_id': user_id,
    }, playlist_ids)

def start_worker(db_path, download_dir, album_art_dir, sio):
    threading.Thread(target=download_worker, args=(db_path, download_dir, album_art_dir, sio), daemon=True).start()
