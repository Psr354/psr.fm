import os
from flask import Blueprint, request, jsonify, render_template, redirect, url_for, current_app
from flask_login import login_user, login_required, logout_user, current_user
from werkzeug.security import check_password_hash

from services.database import (
    get_db_connection, get_user_by_username, create_user, has_any_user,
    get_all_users, get_user_files, delete_user_cascade, update_user_password
)
from services.common import (
    User, get_json_object, get_database_path, is_admin,
    check_login_rate_limit, record_failed_login, clear_login_rate_limit
)

auth_bp = Blueprint('auth', __name__)


@auth_bp.route('/login')
def login_page():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
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
    username = data.get('username', '').strip()
    password = data.get('password', '')
    if not username or not password:
        return jsonify({'error': 'Username and password required'}), 400
    if len(password) < 6:
        return jsonify({'error': 'Password must be at least 6 characters'}), 400
    if len(username) < 3:
        return jsonify({'error': 'Username must be at least 3 characters'}), 400

    user_id = create_user(db_path, username, password, role='admin')
    if not user_id:
        return jsonify({'error': 'Username already taken'}), 400

    user = User(id=user_id, username=username, role='admin')
    login_user(user, remember=True)
    return jsonify({'status': 'success', 'message': 'Account created successfully'})


@auth_bp.route('/api/login', methods=['POST'])
def login():
    data = get_json_object()
    if data is None:
        return jsonify({'error': 'JSON object required'}), 400
    username = data.get('username', '').strip()
    password = data.get('password', '')
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
    if not user_row or not check_password_hash(user_row['password_hash'], password):
        record_failed_login(username)
        return jsonify({'error': 'Invalid username or password'}), 401

    clear_login_rate_limit(username)
    user = User(id=user_row['id'], username=user_row['username'], role=user_row['role'])
    login_user(user, remember=True)
    return jsonify({'status': 'success', 'username': user.username})


@auth_bp.route('/api/logout', methods=['POST'])
@login_required
def logout():
    logout_user()
    return jsonify({'status': 'success'})


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
    username = data.get('username', '').strip()
    password = data.get('password', '')

    if not username or not password:
        return jsonify({'error': 'Username and password required'}), 400
    if len(password) < 6:
        return jsonify({'error': 'Password must be at least 6 characters'}), 400
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
    success = delete_user_cascade(db_path, user_id)
    if not success:
        return jsonify({'error': 'Failed to delete user'}), 500

    library_dir = current_app.config.get('LIBRARY_DIR', '')
    album_art_dir = current_app.config.get('ALBUM_ART_DIR', '')
    conn = get_db_connection(db_path)
    for file_info in user_files:
        try:
            if file_info.get('filename') and library_dir:
                filename_count = conn.execute(
                    'SELECT COUNT(*) AS count FROM songs WHERE filename = ?',
                    (file_info['filename'],)
                ).fetchone()['count']
                if filename_count == 0:
                    mp3_path = os.path.join(library_dir, file_info['filename'])
                    if os.path.exists(mp3_path):
                        os.remove(mp3_path)

            if file_info.get('album_art') and album_art_dir:
                album_art_count = conn.execute(
                    'SELECT COUNT(*) AS count FROM songs WHERE album_art = ?',
                    (file_info['album_art'],)
                ).fetchone()['count']
                playlist_art_count = conn.execute(
                    'SELECT COUNT(*) AS count FROM playlists WHERE cover_art = ?',
                    (file_info['album_art'],)
                ).fetchone()['count']
                if album_art_count == 0 and playlist_art_count == 0:
                    art_path = os.path.join(album_art_dir, file_info['album_art'])
                    if os.path.exists(art_path):
                        os.remove(art_path)

            if file_info.get('cover_art') and album_art_dir:
                cover_art_count = conn.execute(
                    'SELECT COUNT(*) AS count FROM playlists WHERE cover_art = ?',
                    (file_info['cover_art'],)
                ).fetchone()['count']
                song_art_count = conn.execute(
                    'SELECT COUNT(*) AS count FROM songs WHERE album_art = ?',
                    (file_info['cover_art'],)
                ).fetchone()['count']
                if cover_art_count == 0 and song_art_count == 0:
                    cover_path = os.path.join(album_art_dir, file_info['cover_art'])
                    if os.path.exists(cover_path):
                        os.remove(cover_path)
        except Exception as e:
            target = file_info.get('filename') or file_info.get('album_art') or file_info.get('cover_art') or 'unknown file'
            print(f"[WARN] Failed to delete {target}: {e}")
    conn.close()

    return jsonify({'status': 'success', 'message': 'User and all data deleted'})


@auth_bp.route('/api/user/change-password', methods=['POST'])
@login_required
def change_password():
    """Change current user's password."""
    data = get_json_object()
    if data is None:
        return jsonify({'error': 'JSON object required'}), 400

    current_password = data.get('current_password', '')
    new_password = data.get('new_password', '')

    if not current_password or not new_password:
        return jsonify({'error': 'Current password and new password are required'}), 400

    if len(new_password) < 6:
        return jsonify({'error': 'Password must be at least 6 characters'}), 400

    db_path = get_database_path()
    conn = get_db_connection(db_path)
    try:
        user = conn.execute('SELECT password_hash FROM users WHERE id = ?', (current_user.id,)).fetchone()
        if not user or not check_password_hash(user['password_hash'], current_password):
            return jsonify({'error': 'Current password is incorrect'}), 400
    finally:
        conn.close()

    success = update_user_password(db_path, current_user.id, new_password)
    if not success:
        return jsonify({'error': 'Failed to update password'}), 500

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

    if not new_password:
        return jsonify({'error': 'New password required'}), 400

    if len(new_password) < 6:
        return jsonify({'error': 'Password must be at least 6 characters'}), 400

    db_path = get_database_path()
    success = update_user_password(db_path, user_id, new_password)
    if not success:
        return jsonify({'error': 'User not found'}), 404

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
    conn = get_db_connection(db_path)
    try:
        cursor = conn.cursor()
        cursor.execute('UPDATE users SET role = ? WHERE id = ?', (new_role, user_id))
        conn.commit()

        if cursor.rowcount == 0:
            return jsonify({'error': 'User not found'}), 404

        return jsonify({'status': 'success', 'message': f'Role updated to {new_role}'})
    finally:
        conn.close()
