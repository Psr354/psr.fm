import io
import os
import uuid
import queue
import threading
import html
import json
import re
from urllib.parse import urlparse
import yt_dlp
import requests
from PIL import Image
from services.metadata import extract_duration
from services.database import extract_song_source_id, get_db_connection, update_song_lyrics
from services.lyrics import search_lyrics


class PersistentDownloadQueue(queue.Queue):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.db_path = None

    def init_db(self, db_path):
        self.db_path = db_path
        self._recover_unprocessed()

    def _recover_unprocessed(self):
        if not self.db_path or not os.path.exists(self.db_path):
            return
        try:
            conn = get_db_connection(self.db_path)
            conn.execute(
                "UPDATE download_jobs SET status = 'queued', updated_at = CURRENT_TIMESTAMP WHERE status = 'processing'"
            )
            conn.commit()
            rows = conn.execute(
                "SELECT id, user_id, url, playlist_ids FROM download_jobs WHERE status = 'queued' ORDER BY id ASC"
            ).fetchall()
            for row in rows:
                try:
                    pids = json.loads(row['playlist_ids'])
                except Exception:
                    pids = []
                super().put({
                    'job_id': row['id'],
                    'url': row['url'],
                    'playlist_ids': pids,
                    'user_id': row['user_id'],
                })
            conn.close()
        except Exception as e:
            print(f"[WARN] Failed to recover download queue: {e}")

    def put(self, item, block=True, timeout=None):
        if isinstance(item, dict) and 'job_id' not in item and self.db_path and os.path.exists(self.db_path):
            try:
                conn = get_db_connection(self.db_path)
                cursor = conn.cursor()
                cursor.execute(
                    '''
                    INSERT INTO download_jobs (user_id, url, playlist_ids, status)
                    VALUES (?, ?, ?, 'queued')
                    ''',
                    (item.get('user_id'), item.get('url'), json.dumps(item.get('playlist_ids', [])))
                )
                conn.commit()
                item['job_id'] = cursor.lastrowid
                conn.close()
            except Exception as e:
                print(f"[WARN] Failed to persist download job: {e}")
        super().put(item, block=block, timeout=timeout)


download_queue = PersistentDownloadQueue()
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
    'fragment_retries': 3,
    'extractor_args': {
        'youtube': {
            'player_client': ['android', 'web'],
        },
    },
}


def build_ytdlp_options(extra_options=None):
    options = {
        **YTDLP_NETWORK_OPTIONS,
        'noplaylist': True,
        **(extra_options or {}),
    }
    cookiefile = os.environ.get('PSR_FM_YTDLP_COOKIEFILE')
    if cookiefile:
        options['cookiefile'] = cookiefile
    cookies_from_browser = os.environ.get('PSR_FM_YTDLP_COOKIES_FROM_BROWSER')
    if cookies_from_browser:
        parts = [part.strip() for part in cookies_from_browser.split(':') if part.strip()]
        if parts:
            options['cookiesfrombrowser'] = tuple(parts)
    return options


def validate_song_url(url):
    if not url or not isinstance(url, str):
        return False, 'URL is required'

    parsed = urlparse(url.strip())
    host = parsed.netloc.lower()
    if host.startswith('www.'):
        host = host[4:]

    if parsed.scheme not in ('http', 'https'):
        return False, 'Only YouTube, YouTube Music, and Spotify song URLs are allowed'

    youtube_hosts = {'youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'}
    if host in youtube_hosts:
        return True, ''

    if host == 'open.spotify.com':
        if extract_song_source_id(url).startswith('spotify:'):
            return True, ''
        return False, 'Only individual Spotify track URLs are supported'

    return False, 'Only YouTube, YouTube Music, and Spotify song URLs are allowed'


# Backward-compatible import for older integrations.
validate_youtube_url = validate_song_url


def _spotify_track_metadata(url):
    source_id = extract_song_source_id(url)
    track_id = source_id.removeprefix('spotify:')
    embed_url = f'https://open.spotify.com/embed/track/{track_id}'
    response = requests.get(embed_url, timeout=15, headers=YOUTUBE_HTTP_HEADERS)
    response.raise_for_status()

    match = re.search(
        r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>',
        response.text,
        re.DOTALL,
    )
    if not match:
        raise Exception('Could not read Spotify track metadata')

    payload = json.loads(html.unescape(match.group(1)))
    entity = payload['props']['pageProps']['state']['data']['entity']
    artists = ', '.join(item['name'] for item in entity.get('artists', []) if item.get('name'))
    images = entity.get('visualIdentity', {}).get('image', [])
    thumbnail = next((item.get('url') for item in reversed(images) if item.get('url')), '')
    return {
        'title': entity.get('title') or entity.get('name') or 'Unknown',
        'artist': artists or 'Unknown',
        'duration': int((entity.get('duration') or 0) / 1000),
        'thumbnail': thumbnail,
        'source_id': source_id,
        'source_url': url,
    }


def _first_media_entry(info, desired_duration=0):
    if info and info.get('_type') in {'playlist', 'multi_video'}:
        entries = [entry for entry in info.get('entries') or [] if entry]
        if desired_duration:
            compatible_entries = [
                entry for entry in entries
                if entry.get('duration') and abs(entry['duration'] - desired_duration) <= 30
            ]
            if compatible_entries:
                return min(
                    compatible_entries,
                    key=lambda entry: (
                        'official audio' not in (entry.get('title') or '').lower(),
                        abs(entry['duration'] - desired_duration),
                    ),
                )
            return None
        return entries[0] if entries else None
    return info

def download_worker(db_path, download_dir, album_art_dir, sio):
    global socketio_instance
    socketio_instance = sio
    os.makedirs(os.path.join(download_dir, 'library'), exist_ok=True)
    while True:
        task = download_queue.get()
        if task is None:
            break
        job_id = task.get('job_id')
        if job_id and db_path and os.path.exists(db_path):
            try:
                conn = get_db_connection(db_path)
                conn.execute("UPDATE download_jobs SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?", (job_id,))
                conn.commit()
                conn.close()
            except Exception:
                pass
        try:
            process_download(task, db_path, download_dir, album_art_dir)
            if job_id and db_path and os.path.exists(db_path):
                try:
                    conn = get_db_connection(db_path)
                    conn.execute("UPDATE download_jobs SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?", (job_id,))
                    conn.commit()
                    conn.close()
                except Exception:
                    pass
        except Exception as e:
            print(f"Error: {e}")
            if job_id and db_path and os.path.exists(db_path):
                try:
                    conn = get_db_connection(db_path)
                    conn.execute("UPDATE download_jobs SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (str(e)[:500], job_id))
                    conn.commit()
                    conn.close()
                except Exception:
                    pass
            if socketio_instance:
                socketio_instance.emit('download_error', {'url': task['url'], 'error': str(e)}, room=f"user_{task['user_id']}")
        finally:
            download_queue.task_done()


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

MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024
ALLOWED_THUMBNAIL_FORMATS = {'JPEG': '.jpg', 'PNG': '.png', 'WEBP': '.webp'}


def _download_and_save_thumbnail(thumbnail_url, album_art_dir, file_uuid):
    """Download, verify, and re-encode a remote thumbnail via Pillow."""
    if not thumbnail_url or not album_art_dir:
        return ""
    try:
        resp = requests.get(
            thumbnail_url,
            timeout=10,
            headers=YOUTUBE_HTTP_HEADERS,
            stream=True,
        )
        try:
            if resp.status_code != 200:
                return ""
            chunks = []
            total = 0
            if hasattr(resp, 'iter_content'):
                for chunk in resp.iter_content(chunk_size=65536):
                    if not chunk:
                        continue
                    total += len(chunk)
                    if total > MAX_THUMBNAIL_BYTES:
                        return ""
                    chunks.append(chunk)
                raw_bytes = b''.join(chunks)
            else:
                raw_bytes = resp.content or b''
                if len(raw_bytes) > MAX_THUMBNAIL_BYTES:
                    return ""
        finally:
            if hasattr(resp, 'close'):
                resp.close()

        if not raw_bytes:
            return ""
        img = Image.open(io.BytesIO(raw_bytes))
        img.verify()
        img = Image.open(io.BytesIO(raw_bytes))
        if img.format not in ALLOWED_THUMBNAIL_FORMATS:
            return ""
        width, height = img.size
        if width * height > 25_000_000 or width > 8000 or height > 8000:
            return ""
        save_format = img.format
        ext = ALLOWED_THUMBNAIL_FORMATS[save_format]
        if save_format == 'JPEG' and img.mode in ('RGBA', 'P'):
            img = img.convert('RGB')
        candidate_art = f"{file_uuid}{ext}"
        img.save(os.path.join(album_art_dir, candidate_art), format=save_format)
        return candidate_art
    except Exception as e:
        print(f"[WARN] Failed to download thumbnail: {e}")
        return ""


def _populate_song_lyrics(db_path, song_id, title, artist, duration_seconds):
    try:
        lyrics_data = search_lyrics(title, artist, duration_seconds)
        if lyrics_data:
            update_song_lyrics(
                db_path,
                song_id,
                lyrics_data.get('lyrics', ''),
                lyrics_data.get('synced_lyrics', ''),
                word_synced_lyrics=lyrics_data.get('word_synced_lyrics', ''),
                status='found',
            )
        else:
            update_song_lyrics(
                db_path,
                song_id,
                '',
                '',
                word_synced_lyrics='',
                status='not_found',
            )
    except Exception as exc:
        print(f"[WARN] lyrics lookup failed for {song_id}: {exc}")


def _dispatch_lyrics_lookup(db_path, song_id, title, artist, duration_seconds):
    if os.environ.get('PSR_FM_DISABLE_WORKER') == '1':
        _populate_song_lyrics(db_path, song_id, title, artist, duration_seconds)
    else:
        threading.Thread(
            target=_populate_song_lyrics,
            args=(db_path, song_id, title, artist, duration_seconds),
            daemon=True,
        ).start()


def _reuse_existing_song_by_source_id(db_path, library_dir, user_id, source_id, source_url, playlist_ids):
    """Reuse an existing song row (same user or global cross-account) if already on disk."""
    if not source_id:
        return False
    conn = get_db_connection(db_path)
    try:
        conn.execute('BEGIN IMMEDIATE')
        existing_song = conn.execute(
            'SELECT * FROM songs WHERE user_id = ? AND source_id = ? ORDER BY id LIMIT 1',
            (user_id, source_id),
        ).fetchone()
        if existing_song:
            add_song_to_playlists(conn.cursor(), existing_song['id'], playlist_ids)
            conn.commit()
            emit_song_added(existing_song, playlist_ids)
            return True

        global_song = conn.execute(
            'SELECT * FROM songs WHERE source_id = ? ORDER BY id LIMIT 1',
            (source_id,),
        ).fetchone()
        if global_song and global_song['filename'] and os.path.exists(os.path.join(library_dir, global_song['filename'])):
            cursor = conn.cursor()
            cursor.execute(
                '''
                INSERT INTO songs (title, artist, filename, album_art, duration_seconds, source_url, source_id, user_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ''',
                (
                    global_song['title'],
                    global_song['artist'],
                    global_song['filename'],
                    global_song['album_art'],
                    global_song['duration_seconds'],
                    global_song['source_url'] or source_url,
                    source_id,
                    user_id,
                ),
            )
            cloned_id = cursor.lastrowid
            add_song_to_playlists(cursor, cloned_id, playlist_ids)
            conn.commit()
            cloned_payload = {
                'id': cloned_id,
                'playlist_ids': playlist_ids,
                'title': global_song['title'],
                'artist': global_song['artist'],
                'filename': global_song['filename'],
                'album_art': global_song['album_art'],
                'duration_seconds': global_song['duration_seconds'],
                'source_url': global_song['source_url'] or source_url,
                'source_id': source_id,
                'user_id': user_id,
            }
            emit_song_added(cloned_payload, playlist_ids)
            _dispatch_lyrics_lookup(
                db_path, cloned_id, global_song['title'], global_song['artist'], global_song['duration_seconds']
            )
            return True
        conn.rollback()
        return False
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def process_download(task, db_path, download_dir, album_art_dir):
    url = task['url']
    playlist_ids = task['playlist_ids']
    user_id = task['user_id']

    is_valid, validation_error = validate_song_url(url)
    if not is_valid:
        raise Exception(validation_error)

    library_dir = os.path.join(download_dir, 'library')
    requested_source_id = extract_song_source_id(url)
    if requested_source_id and _reuse_existing_song_by_source_id(
        db_path, library_dir, user_id, requested_source_id, url, playlist_ids
    ):
        return
    
    def progress_hook(d):
        if socketio_instance:
            if d['status'] == 'downloading':
                downloaded = d.get('downloaded_bytes')
                total = d.get('total_bytes') or d.get('total_bytes_estimate')
                if isinstance(downloaded, (int, float)) and isinstance(total, (int, float)) and total > 0:
                    percent = round(min(100.0, max(0.0, (downloaded / total) * 100.0)), 1)
                else:
                    percent_str = re.sub(r'\x1b\[[0-9;]*m', '', str(d.get('_percent_str', '0%'))).strip().replace('%', '').replace(' ', '')
                    try:
                        percent = float(percent_str)
                    except (ValueError, TypeError):
                        percent = 0.0
                socketio_instance.emit('download_progress', {'url': url, 'percent': percent}, room=f'user_{user_id}')
            elif d['status'] == 'finished':
                socketio_instance.emit('download_progress', {'url': url, 'percent': 100}, room=f'user_{user_id}')

    ydl_opts_info = build_ytdlp_options({
        'quiet': True,
        'no_warnings': True,
        'extract_flat': False,
    })
    spotify_metadata = _spotify_track_metadata(url) if requested_source_id.startswith('spotify:') else None
    extraction_url = (
        f"ytsearch5:{spotify_metadata['title']} {spotify_metadata['artist']} official audio"
        if spotify_metadata else url
    )
    with yt_dlp.YoutubeDL(ydl_opts_info) as ydl:
        info = _first_media_entry(
            ydl.extract_info(extraction_url, download=False),
            spotify_metadata['duration'] if spotify_metadata else 0,
        )
        if not info:
            raise Exception('No matching audio source was found')
        title = spotify_metadata['title'] if spotify_metadata else info.get('title', 'Unknown')
        artist = spotify_metadata['artist'] if spotify_metadata else info.get('uploader', 'Unknown')
        thumbnail_url = spotify_metadata['thumbnail'] if spotify_metadata else info.get('thumbnail', '')
        duration = spotify_metadata['duration'] if spotify_metadata else (info.get('duration', 0) or 0)
        source_id = requested_source_id or info.get('id') or ''
        source_url = spotify_metadata['source_url'] if spotify_metadata else (info.get('webpage_url') or url)
        download_url = info.get('webpage_url') or info.get('url') or extraction_url

    if duration and duration > MAX_DOWNLOAD_DURATION_SECONDS:
        raise Exception('Video exceeds the 10 minute limit')

    # Recheck after yt-dlp resolves the canonical video ID. This covers queued
    # requests whose initial URL lookup happened before another download ended,
    # and reuses audio files already downloaded by another account.
    if _reuse_existing_song_by_source_id(db_path, library_dir, user_id, source_id, source_url, playlist_ids):
        return
        
    file_uuid = str(uuid.uuid4())
    
    ydl_opts_download = build_ytdlp_options({
        'format': 'bestaudio/best',
        'postprocessors': [{'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3', 'preferredquality': '192'}],
        'outtmpl': os.path.join(library_dir, file_uuid),
        'quiet': True,
        'no_warnings': True,
        'progress_hooks': [progress_hook],
    })
    
    with yt_dlp.YoutubeDL(ydl_opts_download) as ydl:
        ydl.download([download_url])

    expected_file = f"{file_uuid}.mp3"
    if not os.path.exists(os.path.join(library_dir, expected_file)):
        raise Exception("Audio missing")

    duration_seconds = extract_duration(os.path.join(library_dir, expected_file))
    if duration_seconds == 0 and duration > 0:
        duration_seconds = int(duration)

    album_art_filename = _download_and_save_thumbnail(thumbnail_url, album_art_dir, file_uuid)
            
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
        audio_path = os.path.join(library_dir, expected_file)
        if os.path.exists(audio_path):
            try:
                os.remove(audio_path)
            except OSError:
                pass
        if album_art_filename:
            album_art_path = os.path.join(album_art_dir, album_art_filename)
            if os.path.exists(album_art_path):
                try:
                    os.remove(album_art_path)
                except OSError:
                    pass
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

    _dispatch_lyrics_lookup(db_path, song_id, title, artist, duration_seconds)

def start_worker(db_path, download_dir, album_art_dir, sio):
    download_queue.init_db(db_path)
    threading.Thread(target=download_worker, args=(db_path, download_dir, album_art_dir, sio), daemon=True).start()
