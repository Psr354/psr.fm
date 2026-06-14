import os
import uuid
import queue
import threading
import yt_dlp
import requests
from werkzeug.utils import secure_filename
from services.metadata import extract_duration
from services.database import get_db_connection

download_queue = queue.Queue()
socketio_instance = None

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
            if socketio_instance: socketio_instance.emit('download_error', {'url': task['url'], 'error': str(e)})
        finally: download_queue.task_done()

def process_download(task, db_path, download_dir, album_art_dir):
    url = task['url']
    playlist_ids = task['playlist_ids'] # List of IDs
    
    def progress_hook(d):
        if socketio_instance:
            if d['status'] == 'downloading':
                percent_str = d.get('_percent_str', '0%').strip().replace('%', '').replace(' ', '')
                try: percent = float(percent_str)
                except: percent = 0
                socketio_instance.emit('download_progress', {'url': url, 'percent': percent})
            elif d['status'] == 'finished':
                socketio_instance.emit('download_progress', {'url': url, 'percent': 100})

    ydl_opts_info = {'quiet': True, 'no_warnings': True, 'extract_flat': False}
    with yt_dlp.YoutubeDL(ydl_opts_info) as ydl:
        info = ydl.extract_info(url, download=False)
        title = info.get('title', 'Unknown')
        artist = info.get('uploader', 'Unknown')
        thumbnail_url = info.get('thumbnail', '')
        duration = info.get('duration', 0) or 0
        
    file_uuid = str(uuid.uuid4())
    library_dir = os.path.join(download_dir, 'library')
    
    ydl_opts_download = {
        'format': 'bestaudio/best',
        'postprocessors': [{'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3', 'preferredquality': '192'}],
        'outtmpl': os.path.join(library_dir, file_uuid),
        'quiet': True, 'no_warnings': True, 'progress_hooks': [progress_hook],
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
            r = requests.get(thumbnail_url, timeout=10)
            if r.status_code == 200:
                with open(os.path.join(album_art_dir, album_art_filename), 'wb') as f: f.write(r.content)
        except: pass
            
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    cursor.execute('INSERT INTO songs (title, artist, filename, album_art, duration_seconds) VALUES (?, ?, ?, ?, ?)',
                 (title, artist, expected_file, album_art_filename, duration_seconds))
    song_id = cursor.lastrowid
    
    for pid in playlist_ids:
        cursor.execute('INSERT OR IGNORE INTO playlist_songs (playlist_id, song_id) VALUES (?, ?)', (pid, song_id))
    conn.commit()
    conn.close()

    if socketio_instance:
        socketio_instance.emit('song_added', {'id': song_id, 'playlist_ids': playlist_ids, 'title': title, 'artist': artist, 'filename': expected_file, 'album_art': album_art_filename, 'duration_seconds': duration_seconds})

def start_worker(db_path, download_dir, album_art_dir, sio):
    threading.Thread(target=download_worker, args=(db_path, download_dir, album_art_dir, sio), daemon=True).start()
