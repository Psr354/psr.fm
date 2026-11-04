from flask import Blueprint, jsonify, current_app
from flask_login import login_required, current_user

from services.database import (
    get_user_playback_state, save_user_playback_state,
    get_user_theme, save_user_theme
)
from services.common import get_json_object, get_database_path

user_settings_bp = Blueprint('user_settings', __name__)


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
    db_path = get_database_path()
    save_user_playback_state(db_path, current_user.id, payload)
    sio = getattr(current_app, 'socketio', None)
    if sio:
        sio.emit('playback_sync', payload, room=f'user_{current_user.id}')
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
    db_path = get_database_path()
    save_user_theme(db_path, current_user.id, payload)
    sio = getattr(current_app, 'socketio', None)
    if sio:
        sio.emit('theme_sync', payload, room=f'user_{current_user.id}')
    return jsonify({'status': 'success'})
