from flask import Blueprint, jsonify, render_template, redirect, url_for, current_app
from flask_login import login_user, login_required, logout_user, current_user
from werkzeug.security import check_password_hash, generate_password_hash

from services.database import (
    get_db_connection, get_user_by_id, get_user_by_username, create_user,
    create_initial_admin, has_any_user,
    get_all_users, get_user_files, delete_user_cascade, update_user_password,
    update_user_role, create_user_session, revoke_user_session, revoke_all_user_sessions
)
from services.common import (
    User, get_json_object, get_database_path, is_admin,
    check_login_rate_limit, record_failed_login, clear_login_rate_limit,
    check_password_change_rate_limit, record_failed_password_change, clear_password_change_rate_limit,
    cleanup_unreferenced_media, MAX_PASSWORD_LENGTH
)

auth_bp = Blueprint('auth', __name__)
_DUMMY_PASSWORD_HASH = generate_password_hash('psr-fm-dummy-timing-guard', method='pbkdf2:sha256', salt_length=16)


def _close_user_socket_room(user_id):
    sio = getattr(current_app, 'socketio', None)
    if not sio:
        return
    try:
        sio.close_room(f'user_{user_id}')
    except Exception:
        current_app.logger.warning('Failed to close Socket.IO room for user %s', user_id, exc_info=True)


@auth_bp.route('/login')
def login_page():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    if not has_any_user(get_database_path()):
        return redirect(url_for('auth.setup_page'))
    return render_template('login.html')


@auth_bp.route('/setup')
def setup_page():
    db_path = get_database_path()
    if has_any_user(db_path):
        return redirect(url_for('auth.login_page'))
    return render_template('setup.html')


@auth_bp.route('/api/setup', methods=['POST'])
def setup_account():
    db_path = get_database_path()
    if has_any_user(db_path):
        return jsonify({'error': 'Account already exists'}), 403
    data = get_json_object()
    if data is None:
        return jsonify({'error': 'JSON object required'}), 400
    raw_username = data.get('username', '')
    password = data.get('password', '')
    if not isinstance(raw_username, str) or not isinstance(password, str):
        return jsonify({'error': 'Username and password must be strings'}), 400
    username = raw_username.strip()
    if not username or not password:
        return jsonify({'error': 'Username and password required'}), 400
    if len(password) < 6:
        return jsonify({'error': 'Password must be at least 6 characters'}), 400
    if len(password) > MAX_PASSWORD_LENGTH:
        return jsonify({'error': f'Password must be at most {MAX_PASSWORD_LENGTH} characters'}), 400
    if len(username) < 3:
        return jsonify({'error': 'Username must be at least 3 characters'}), 400

    user_id, err = create_initial_admin(db_path, username, password)
    if err == 'exists':
        return jsonify({'error': 'Account already exists'}), 403
    if not user_id:
        return jsonify({'error': 'Username already taken'}), 400

    user_row = get_user_by_id(db_path, user_id)
    device_token = create_user_session(db_path, user_id)
    user = User(
        id=user_id,
        username=username,
        role='admin',
        session_token=user_row['session_token'] if user_row else '',
        device_token=device_token,
    )
    login_user(user, remember=True)
    return jsonify({'status': 'success', 'message': 'Account created successfully'})


@auth_bp.route('/api/login', methods=['POST'])
def login():
    data = get_json_object()
    if data is None:
        return jsonify({'error': 'JSON object required'}), 400
    raw_username = data.get('username', '')
    password = data.get('password', '')
    if not isinstance(raw_username, str) or not isinstance(password, str):
        return jsonify({'error': 'Username and password must be strings'}), 400
    username = raw_username.strip()
    if not username or not password:
        return jsonify({'error': 'Username and password required'}), 400

    allowed, retry_after = check_login_rate_limit(username)
    if not allowed:
        return jsonify({
            'error': 'Too many login attempts. Please try again later.',
            'retry_after': retry_after,
        }), 429

    db_path = get_database_path()
    user_row = get_user_by_username(db_path, username)
    if len(password) > MAX_PASSWORD_LENGTH:
        record_failed_login(username)
        return jsonify({'error': 'Invalid username or password'}), 401
    password_hash = user_row['password_hash'] if user_row else _DUMMY_PASSWORD_HASH
    password_ok = check_password_hash(password_hash, password)
    if not user_row or not password_ok:
        record_failed_login(username)
        return jsonify({'error': 'Invalid username or password'}), 401

    clear_login_rate_limit(username)
    device_token = create_user_session(db_path, user_row['id'])
    user = User(
        id=user_row['id'],
        username=user_row['username'],
        role=user_row['role'],
        session_token=user_row['session_token'],
        device_token=device_token,
    )
    login_user(user, remember=True)
    return jsonify({'status': 'success', 'username': user.username})


@auth_bp.route('/api/logout', methods=['POST'])
@login_required
def logout():
    device_token = getattr(current_user, 'device_token', '')
    if device_token:
        revoke_user_session(get_database_path(), current_user.id, device_token)
    logout_user()
    return jsonify({'status': 'success'})


@auth_bp.route('/api/logout-all', methods=['POST'])
@login_required
def logout_all_devices():
    """Revoke all active sessions for the current user across all devices."""
    user_id = current_user.id
    revoke_all_user_sessions(get_database_path(), user_id)
    _close_user_socket_room(user_id)
    logout_user()
    return jsonify({'status': 'success', 'message': 'Signed out from all devices'})


@auth_bp.route('/api/me')
@login_required
def me():
    return jsonify({
        'username': current_user.username,
        'id': current_user.id,
        'can_add_users': is_admin()
    })


@auth_bp.route('/api/users', methods=['POST'])
@login_required
def create_new_user():
    """Create a new user (admin only)."""
    if not is_admin():
        return jsonify({'error': 'Only administrators can create new users'}), 403

    data = get_json_object()
    if data is None:
        return jsonify({'error': 'JSON object required'}), 400
    raw_username = data.get('username', '')
    password = data.get('password', '')
    if not isinstance(raw_username, str) or not isinstance(password, str):
        return jsonify({'error': 'Username and password must be strings'}), 400
    username = raw_username.strip()

    if not username or not password:
        return jsonify({'error': 'Username and password required'}), 400
    if len(password) < 6:
        return jsonify({'error': 'Password must be at least 6 characters'}), 400
    if len(password) > MAX_PASSWORD_LENGTH:
        return jsonify({'error': f'Password must be at most {MAX_PASSWORD_LENGTH} characters'}), 400
    if len(username) < 3:
        return jsonify({'error': 'Username must be at least 3 characters'}), 400

    db_path = get_database_path()
    user_id = create_user(db_path, username, password, role='user')
    if not user_id:
        return jsonify({'error': 'Username already taken'}), 400

    return jsonify({
        'status': 'success', 
        'message': f'User {username} created successfully',
        'user_id': user_id
    }), 201


@auth_bp.route('/api/admin/users')
@login_required
def list_users():
    """List all users with stats (admin only)."""
    if not is_admin():
        return jsonify({'error': 'Admin access required'}), 403

    db_path = get_database_path()
    users = get_all_users(db_path)
    return jsonify(users)


@auth_bp.route('/api/admin/users/<int:user_id>', methods=['DELETE'])
@login_required
def delete_user(user_id):
    """Delete user and all their data (admin only)."""
    if not is_admin():
        return jsonify({'error': 'Admin access required'}), 403

    if user_id == current_user.id:
        return jsonify({'error': 'You cannot delete your own account'}), 400

    db_path = get_database_path()
    user_files = get_user_files(db_path, user_id)
    delete_status = delete_user_cascade(db_path, user_id)
    if delete_status == 'not_found':
        return jsonify({'error': 'User not found'}), 404
    if delete_status != 'deleted':
        return jsonify({'error': 'Failed to delete user'}), 500

    _close_user_socket_room(user_id)

    library_dir = current_app.config.get('LIBRARY_DIR', '')
    album_art_dir = current_app.config.get('ALBUM_ART_DIR', '')
    conn = get_db_connection(db_path)
    try:
        filenames = [info.get('filename') for info in user_files if info.get('filename')]
        art_files = [
            art
            for info in user_files
            for art in (info.get('album_art'), info.get('cover_art'))
            if art
        ]
        cleanup_unreferenced_media(
            conn,
            filenames=filenames,
            art_files=art_files,
            library_dir=library_dir,
            album_art_dir=album_art_dir,
            async_delete=False,
        )
    finally:
        conn.close()

    return jsonify({'status': 'success', 'message': 'User and all data deleted'})


@auth_bp.route('/api/user/change-password', methods=['POST'])
@login_required
def change_password():
    """Change current user's password."""
    allowed, retry_after = check_password_change_rate_limit(current_user.id)
    if not allowed:
        return jsonify({
            'error': 'Too many password change attempts. Please try again later.',
            'retry_after': retry_after,
        }), 429

    data = get_json_object()
    if data is None:
        return jsonify({'error': 'JSON object required'}), 400

    current_password = data.get('current_password', '')
    new_password = data.get('new_password', '')

    if not isinstance(current_password, str) or not isinstance(new_password, str) or not current_password or not new_password:
        return jsonify({'error': 'Current password and new password are required'}), 400

    if len(new_password) < 6:
        return jsonify({'error': 'Password must be at least 6 characters'}), 400
    if len(new_password) > MAX_PASSWORD_LENGTH or len(current_password) > MAX_PASSWORD_LENGTH:
        return jsonify({'error': f'Password must be at most {MAX_PASSWORD_LENGTH} characters'}), 400

    db_path = get_database_path()
    conn = get_db_connection(db_path)
    try:
        user = conn.execute('SELECT password_hash FROM users WHERE id = ?', (current_user.id,)).fetchone()
        if not user or not check_password_hash(user['password_hash'], current_password):
            record_failed_password_change(current_user.id)
            return jsonify({'error': 'Current password is incorrect'}), 400
    finally:
        conn.close()

    clear_password_change_rate_limit(current_user.id)
    success = update_user_password(db_path, current_user.id, new_password)
    if not success:
        return jsonify({'error': 'Failed to update password'}), 500

    _close_user_socket_room(current_user.id)
    updated_row = get_user_by_id(db_path, current_user.id)
    if updated_row:
        device_token = create_user_session(db_path, current_user.id)
        login_user(
            User(
                id=updated_row['id'],
                username=updated_row['username'],
                role=updated_row['role'],
                session_token=updated_row['session_token'],
                device_token=device_token,
            ),
            remember=True,
        )

    return jsonify({'status': 'success', 'message': 'Password changed successfully'})


@auth_bp.route('/api/admin/users/<int:user_id>/reset-password', methods=['POST'])
@login_required
def reset_user_password(user_id):
    """Reset user password (admin only)."""
    if not is_admin():
        return jsonify({'error': 'Admin access required'}), 403

    data = get_json_object()
    if data is None:
        return jsonify({'error': 'JSON object required'}), 400
    new_password = data.get('password', '')

    if not isinstance(new_password, str) or not new_password:
        return jsonify({'error': 'New password required'}), 400

    if len(new_password) < 6:
        return jsonify({'error': 'Password must be at least 6 characters'}), 400
    if len(new_password) > MAX_PASSWORD_LENGTH:
        return jsonify({'error': f'Password must be at most {MAX_PASSWORD_LENGTH} characters'}), 400

    db_path = get_database_path()
    success = update_user_password(db_path, user_id, new_password)
    if not success:
        return jsonify({'error': 'User not found'}), 404

    _close_user_socket_room(user_id)
    return jsonify({'status': 'success', 'message': 'Password reset successfully'})


@auth_bp.route('/api/admin/users/<int:user_id>/role', methods=['PUT'])
@login_required
def change_user_role(user_id):
    """Change user role (admin only)."""
    if not is_admin():
        return jsonify({'error': 'Admin access required'}), 403

    if user_id == current_user.id:
        return jsonify({'error': 'You cannot change your own role'}), 400

    data = get_json_object()
    if data is None:
        return jsonify({'error': 'JSON object required'}), 400
    new_role = data.get('role', '')

    if new_role not in ('user', 'admin'):
        return jsonify({'error': 'Invalid role. Must be user or admin'}), 400

    db_path = get_database_path()
    if not update_user_role(db_path, user_id, new_role):
        return jsonify({'error': 'User not found'}), 404
    return jsonify({'status': 'success', 'message': f'Role updated to {new_role}'})
