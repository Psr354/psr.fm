import argparse
import os
import sys

import yt_dlp
from dotenv import load_dotenv

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from services.database import extract_youtube_video_id, get_db_connection


BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))


def resolve_database_path():
    load_dotenv(os.path.join(BASE_DIR, '.env'))
    return os.environ.get(
        'PSR_FM_DATABASE_PATH',
        os.path.join(BASE_DIR, 'database.db', 'psr_fm.sqlite3'),
    )


def find_source_for_song(title, artist):
    query_parts = [title or '', artist or '']
    query = ' '.join(part.strip() for part in query_parts if part and part.strip())
    if not query:
        return None

    opts = {
        'quiet': True,
        'no_warnings': True,
        'extract_flat': True,
        'skip_download': True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        result = ydl.extract_info(f'ytsearch1:{query}', download=False)

    entries = result.get('entries') or []
    if not entries:
        return None

    entry = entries[0]
    source_id = entry.get('id') or extract_youtube_video_id(entry.get('url', ''))
    if not source_id:
        return None

    return {
        'source_id': source_id,
        'source_url': entry.get('webpage_url') or f'https://www.youtube.com/watch?v={source_id}',
    }


def backfill_sources(database_path, dry_run=False, limit=None):
    conn = get_db_connection(database_path)
    try:
        cursor = conn.cursor()
        sql = '''
            SELECT id, title, artist, source_url, source_id
            FROM songs
            WHERE source_id IS NULL OR source_id = ''
            ORDER BY id ASC
        '''
        params = []
        if limit:
            sql += ' LIMIT ?'
            params.append(limit)

        cursor.execute(sql, params)
        songs = cursor.fetchall()
        updated = 0
        skipped = 0
        failed = 0

        for song in songs:
            existing_source_id = extract_youtube_video_id(song['source_url'])
            source = None
            if existing_source_id:
                source = {
                    'source_id': existing_source_id,
                    'source_url': song['source_url'],
                }
            else:
                try:
                    source = find_source_for_song(song['title'], song['artist'])
                except Exception as exc:
                    failed += 1
                    print(f"[WARN] song {song['id']} lookup failed: {exc}")
                    continue

            if not source:
                skipped += 1
                print(f"[SKIP] song {song['id']}: no match for {song['title']}")
                continue

            print(f"[OK] song {song['id']}: {song['title']} -> {source['source_id']}")
            if not dry_run:
                cursor.execute(
                    'UPDATE songs SET source_url = ?, source_id = ? WHERE id = ?',
                    (source['source_url'], source['source_id'], song['id']),
                )
                conn.commit()
            updated += 1

        return updated, skipped, failed, len(songs)
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(description='Backfill YouTube source_url/source_id for old songs.')
    parser.add_argument('--database', default=resolve_database_path(), help='SQLite database path.')
    parser.add_argument('--dry-run', action='store_true', help='Show matches without updating the database.')
    parser.add_argument('--limit', type=int, default=None, help='Process at most this many songs.')
    args = parser.parse_args()

    updated, skipped, failed, total = backfill_sources(args.database, dry_run=args.dry_run, limit=args.limit)
    mode = 'dry-run' if args.dry_run else 'updated'
    print(f"Done ({mode}). Updated: {updated}, skipped: {skipped}, failed: {failed}, total scanned: {total}")


if __name__ == '__main__':
    main()
