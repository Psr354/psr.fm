import sys
from flask import Blueprint, request, jsonify
from flask_login import login_required, current_user

from services.common import (
    get_db, get_owned_song, check_lyrics_rate_limit
)
import services.lyrics as lyrics_service

lyrics_bp = Blueprint('lyrics', __name__)


def _get_search_lyrics():
    app_module = sys.modules.get('app')
    if app_module and hasattr(app_module, 'search_lyrics'):
        return app_module.search_lyrics
    return lyrics_service.search_lyrics



@lyrics_bp.route('/api/songs/<int:song_id>/lyrics', methods=['GET'])
@login_required
def get_song_lyrics(song_id):
    db = get_db()
    song = get_owned_song(db, song_id)
    if not song:
        return jsonify({'error': 'Not found'}), 404

    return jsonify({
        'lyrics': song['lyrics'] or '',
        'synced_lyrics': song['synced_lyrics'] or '',
        'word_synced_lyrics': song['word_synced_lyrics'] or '',
        'lyrics_status': song['lyrics_status'] or 'none',
        'lyrics_updated_at': song['lyrics_updated_at'],
    })


@lyrics_bp.route('/api/songs/<int:song_id>/lyrics', methods=['POST'])
@login_required
def refresh_song_lyrics(song_id):
    db = get_db()
    song = get_owned_song(db, song_id)
    if not song:
        return jsonify({'error': 'Not found'}), 404

    if (song['lyrics_status'] or 'none') == 'manual':
        return jsonify({
            'lyrics': song['lyrics'] or '',
            'synced_lyrics': song['synced_lyrics'] or '',
            'word_synced_lyrics': song['word_synced_lyrics'] or '',
            'lyrics_status': 'manual',
            'lyrics_updated_at': song['lyrics_updated_at'],
        })

    allowed, retry_after = check_lyrics_rate_limit(current_user.id)
    if not allowed:
        return jsonify({'error': 'Too many lyrics requests', 'retry_after': retry_after}), 429

    search_fn = _get_search_lyrics()
    try:
        lyrics_data = search_fn(song['title'], song['artist'], song['duration_seconds'])
    except Exception:
        lyrics_data = None

    if not lyrics_data:
        db.execute(
            '''
            UPDATE songs
            SET lyrics = '', synced_lyrics = '', word_synced_lyrics = '', lyrics_status = 'not_found', lyrics_updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND user_id = ?
            ''',
            (song_id, current_user.id)
        )
        db.commit()
        return jsonify({
            'error': 'Lyrics not found',
            'lyrics': '',
            'synced_lyrics': '',
            'word_synced_lyrics': '',
            'lyrics_status': 'not_found',
            'lyrics_updated_at': None,
        }), 404

    db.execute(
        '''
        UPDATE songs
        SET lyrics = ?, synced_lyrics = ?, word_synced_lyrics = ?, lyrics_status = 'found', lyrics_updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
        ''',
        (
            lyrics_data.get('lyrics', ''),
            lyrics_data.get('synced_lyrics', ''),
            lyrics_data.get('word_synced_lyrics', ''),
            song_id,
            current_user.id,
        )
    )
    db.commit()

    return jsonify({
        'lyrics': lyrics_data.get('lyrics', ''),
        'synced_lyrics': lyrics_data.get('synced_lyrics', ''),
        'word_synced_lyrics': lyrics_data.get('word_synced_lyrics', ''),
        'lyrics_status': 'found',
        'lyrics_updated_at': None,
    })


@lyrics_bp.route('/api/songs/<int:song_id>/lyrics', methods=['PUT'])
@login_required
def save_song_lyrics(song_id):
    db = get_db()
    song = get_owned_song(db, song_id)
    if not song:
        return jsonify({'error': 'Not found'}), 404

    data = request.get_json() or {}
    lyrics = str(data.get('lyrics') or '').strip()
    synced_lyrics = str(data.get('synced_lyrics') or '').strip()
    status = 'manual' if lyrics or synced_lyrics else 'none'

    db.execute(
        '''
        UPDATE songs
        SET lyrics = ?, synced_lyrics = ?, word_synced_lyrics = '', lyrics_status = ?, lyrics_updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
        ''',
        (lyrics, synced_lyrics, status, song_id, current_user.id)
    )
    db.commit()

    return jsonify({
        'lyrics': lyrics,
        'synced_lyrics': synced_lyrics,
        'lyrics_status': status,
        'lyrics_updated_at': None,
    })
