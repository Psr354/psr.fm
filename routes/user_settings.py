import json
import math
from flask import Blueprint, jsonify, current_app
from flask_login import login_required, current_user

from services.database import (
    get_user_playback_state, save_user_playback_state,
    get_user_theme, save_user_theme
)
from services.common import get_json_object, get_database_path, is_valid_hex_color

user_settings_bp = Blueprint('user_settings', __name__)

MAX_THEME_PAYLOAD_BYTES = 8 * 1024
MAX_PLAYBACK_PAYLOAD_BYTES = 64 * 1024
MAX_PLAYBACK_QUEUE_ITEMS = 100

THEME_HEX_FIELDS = {
    'accent', 'accentHover', 'bgCustom', 'sidebarCustom',
    'cardCustom', 'textColor', 'statusBarCustom', 'lyricColor', 'card',
}
THEME_ENUM_FIELDS = {
    'bg': {'dark', 'amoled', 'midnight', 'charcoal', 'warm', 'forest', 'custom'},
    'sidebarMode': {'harmonize', 'match', 'obsidian', 'custom'},
    'cardMode': {'glass', 'harmonize', 'contrast', 'custom'},
    'statusBarMode': {'accent', 'background', 'black', 'custom', 'match'},
    'lyricMode': {'accent', 'custom'},
}
ALLOWED_THEME_KEYS = THEME_HEX_FIELDS | set(THEME_ENUM_FIELDS.keys()) | {'scale'}

ALLOWED_PLAYBACK_KEYS = {
    'songId', 'songMeta', 'playlistId', 'playlistSongs', 'songIndex',
    'duration', 'repeatMode', 'isShuffle', 'currentTime', 'isPlaying',
    'timestamp', 'deviceId', 'volume', 'isMuted',
}
ALLOWED_SONG_META_KEYS = {'id', 'title', 'artist', 'album_art', 'filename', 'duration_seconds'}


def _validate_theme_payload(payload):
    if not isinstance(payload, dict) or not payload:
        return None, 'Invalid theme payload'
    if len(json.dumps(payload, separators=(',', ':')).encode('utf-8')) > MAX_THEME_PAYLOAD_BYTES:
        return None, 'Theme payload too large'

    cleaned = {}
    for key, value in payload.items():
        if key not in ALLOWED_THEME_KEYS:
            return None, f'Unknown theme field: {key}'
        if key in THEME_HEX_FIELDS:
            if not is_valid_hex_color(value):
                return None, f'Invalid hex color for {key}'
            cleaned[key] = value.strip()
        elif key in THEME_ENUM_FIELDS:
            if not isinstance(value, str) or value not in THEME_ENUM_FIELDS[key]:
                return None, f'Invalid value for {key}'
            cleaned[key] = value
        elif key == 'scale':
            if isinstance(value, bool):
                return None, 'Invalid scale'
            try:
                scale_val = float(value)
            except (TypeError, ValueError):
                return None, 'Invalid scale'
            if not math.isfinite(scale_val) or not (0.5 <= scale_val <= 2.0):
                return None, 'Scale out of range'
            cleaned[key] = str(value) if isinstance(value, str) else scale_val
    return cleaned, None


def _validate_song_meta(item):
    if not isinstance(item, dict):
        return False
    return set(item.keys()).issubset(ALLOWED_SONG_META_KEYS)


def _validate_playback_payload(payload):
    if not isinstance(payload, dict) or not payload:
        return None, 'Invalid playback payload'
    if len(json.dumps(payload, separators=(',', ':')).encode('utf-8')) > MAX_PLAYBACK_PAYLOAD_BYTES:
        return None, 'Playback payload too large'

    for key in payload:
        if key not in ALLOWED_PLAYBACK_KEYS:
            return None, f'Unknown playback field: {key}'

    if 'songMeta' in payload and payload['songMeta'] is not None:
        if not _validate_song_meta(payload['songMeta']):
            return None, 'Invalid songMeta'

    if 'playlistSongs' in payload and payload['playlistSongs'] is not None:
        songs = payload['playlistSongs']
        if not isinstance(songs, list) or len(songs) > MAX_PLAYBACK_QUEUE_ITEMS:
            return None, 'Invalid playlistSongs'
        if not all(_validate_song_meta(item) for item in songs):
            return None, 'Invalid playlistSongs item'

    for id_field in ('songId', 'playlistId'):
        if id_field in payload and payload[id_field] is not None:
            val = payload[id_field]
            if isinstance(val, bool) or not isinstance(val, (int, str)) or (isinstance(val, str) and len(val) > 64):
                return None, f'Invalid {id_field}'

    if 'songIndex' in payload and payload['songIndex'] is not None:
        val = payload['songIndex']
        if isinstance(val, bool) or not isinstance(val, int) or val < -1 or val > 100000:
            return None, 'Invalid songIndex'

    for bool_field in ('isPlaying', 'isShuffle', 'isMuted'):
        if bool_field in payload and payload[bool_field] is not None:
            if not isinstance(payload[bool_field], bool):
                return None, f'Invalid {bool_field}'

    for num_field in ('currentTime', 'duration', 'volume', 'timestamp'):
        if num_field in payload and payload[num_field] is not None:
            val = payload[num_field]
            if isinstance(val, bool) or not isinstance(val, (int, float)) or not math.isfinite(val):
                return None, f'Invalid {num_field}'

    if 'repeatMode' in payload and payload['repeatMode'] is not None:
        val = payload['repeatMode']
        if isinstance(val, bool) or val not in (0, 1, 2):
            return None, 'Invalid repeatMode'

    if 'deviceId' in payload and payload['deviceId'] is not None:
        if not isinstance(payload['deviceId'], str) or len(payload['deviceId']) > 128:
            return None, 'Invalid deviceId'

    return payload, None


@user_settings_bp.route('/api/playback-state', methods=['GET'])
@login_required
def get_playback_state_route():
    db_path = get_database_path()
    state = get_user_playback_state(db_path, current_user.id)
    return jsonify({'status': 'success', 'playback_state': state})


@user_settings_bp.route('/api/playback-state', methods=['POST'])
@login_required
def save_playback_state_route():
    payload = get_json_object()
    if not payload:
        return jsonify({'error': 'Invalid JSON'}), 400
    validated, error = _validate_playback_payload(payload)
    if error:
        return jsonify({'error': error}), 400
    db_path = get_database_path()
    save_user_playback_state(db_path, current_user.id, validated)
    sio = getattr(current_app, 'socketio', None)
    if sio:
        sio.emit('playback_sync', validated, room=f'user_{current_user.id}')
    return jsonify({'status': 'success'})


@user_settings_bp.route('/api/user-settings/theme', methods=['GET'])
@login_required
def get_user_theme_route():
    db_path = get_database_path()
    theme = get_user_theme(db_path, current_user.id)
    return jsonify({'status': 'success', 'theme': theme})


@user_settings_bp.route('/api/user-settings/theme', methods=['POST'])
@login_required
def save_user_theme_route():
    payload = get_json_object()
    if not payload:
        return jsonify({'error': 'Invalid JSON'}), 400
    validated, error = _validate_theme_payload(payload)
    if error:
        return jsonify({'error': error}), 400
    db_path = get_database_path()
    save_user_theme(db_path, current_user.id, validated)
    sio = getattr(current_app, 'socketio', None)
    if sio:
        sio.emit('theme_sync', validated, room=f'user_{current_user.id}')
    return jsonify({'status': 'success'})
