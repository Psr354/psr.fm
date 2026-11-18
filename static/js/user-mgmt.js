// ==========================================
// USER MANAGEMENT MODULE (Admin Only)
// ==========================================
(function() {
document.addEventListener('DOMContentLoaded', () => {
    const el = window.el || {};
    const state = window.state || {};
    const showToast = window.showToast || ((m) => console.log(m));
    const showView = window.showView || (() => {});
    const escapeHtml = window.escapeHtml || ((s) => s);
let resetPasswordUserId = null;
let resetPasswordUsername = '';
let roleChangeUserId = null;
let roleChangeUsername = '';
let allUsersCache = [];
let userFilter = 'all';
let userSearchQuery = '';

// Avatar color generator
function getAvatarColor(username) {
    const colors = [
        'linear-gradient(135deg, #f97316, #ea580c)',
        'linear-gradient(135deg, #ec4899, #db2777)',
        'linear-gradient(135deg, #8b5cf6, #7c3aed)',
        'linear-gradient(135deg, #06b6d4, #0891b2)',
        'linear-gradient(135deg, #10b981, #059669)',
        'linear-gradient(135deg, #f59e0b, #d97706)',
        'linear-gradient(135deg, #ef4444, #dc2626)',
        'linear-gradient(135deg, #3b82f6, #2563eb)',
    ];
    const hash = username.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return colors[hash % colors.length];
}

// Format date
function formatDate(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now - date;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
    if (days < 365) return `${Math.floor(days / 30)} months ago`;
    return `${Math.floor(days / 365)} years ago`;
}

async function loadUsers() {
    if (!el.usersTableBody) return;
    
    el.usersTableBody.innerHTML = `
        <tr>
            <td colspan="6">
                <div class="users-loading">
                    <i class="fas fa-spinner fa-spin"></i>
                    <span>Loading users...</span>
                </div>
            </td>
        </tr>
    `;

    try {
        const res = await fetch('/api/admin/users');
        if (!res.ok) throw new Error('Failed to load users');
        const users = await res.json();
        const currentUser = await (await fetch('/api/me')).json();

        allUsersCache = users;
        updateStats(users);
        renderUsers(users, currentUser);

    } catch (err) {
        el.usersTableBody.innerHTML = `
            <tr>
                <td colspan="6">
                    <div class="users-empty">
                        <i class="fas fa-exclamation-circle"></i>
                        <h4>Failed to load users</h4>
                        <p>Please check your connection and try again.</p>
                    </div>
                </td>
            </tr>
        `;
    }
}

function updateStats(users) {
    const admins = users.filter(u => u.role === 'admin').length;
    const regular = users.filter(u => u.role === 'user').length;
    const totalSongs = users.reduce((sum, u) => sum + (u.song_count || 0), 0);

    document.getElementById('stat-total-users').textContent = users.length;
    document.getElementById('stat-admins').textContent = admins;
    document.getElementById('stat-regular-users').textContent = regular;
    document.getElementById('stat-total-songs').textContent = totalSongs;
}

function renderUsers(users, currentUser) {
    // Filter
    let filtered = users;
    
    if (userFilter !== 'all') {
        filtered = filtered.filter(u => u.role === userFilter);
    }
    
    if (userSearchQuery) {
        const q = userSearchQuery.toLowerCase();
        filtered = filtered.filter(u => u.username.toLowerCase().includes(q));
    }

    if (filtered.length === 0) {
        el.usersTableBody.innerHTML = `
            <tr>
                <td colspan="6">
                    <div class="users-empty">
                        <i class="fas fa-search"></i>
                        <h4>No users found</h4>
                        <p>Try adjusting your search or filter criteria.</p>
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    el.usersTableBody.innerHTML = filtered.map(user => {
        const isSelf = user.id === currentUser.id;
        const isAdmin = user.role === 'admin';
        const avatarBg = isAdmin 
            ? 'linear-gradient(135deg, #fbbf24, #f59e0b)' 
            : getAvatarColor(user.username);

        return `
            <tr data-user-id="${user.id}">
                <td>
                    <div class="user-cell">
                        <div class="user-avatar-lg ${isAdmin ? 'admin' : ''}" style="background: ${avatarBg};">
                            ${escapeHtml(user.username.charAt(0).toUpperCase())}
                        </div>
                        <div class="user-info-cell">
                            <div class="user-name-cell">
                                ${escapeHtml(user.username)}
                                ${isSelf ? '<span class="self-user-badge">You</span>' : ''}
                            </div>
                            <div class="user-id-cell">ID: ${user.id}</div>
                        </div>
                    </div>
                </td>
                <td>
                    <span class="role-badge ${user.role}">
                        <i class="fas ${isAdmin ? 'fa-shield-alt' : 'fa-user'}"></i>
                        ${escapeHtml(user.role)}
                    </span>
                </td>
                <td>
                    <span class="stat-pill">
                        <i class="fas fa-list"></i>
                        ${user.playlist_count}
                    </span>
                </td>
                <td>
                    <span class="stat-pill">
                        <i class="fas fa-music"></i>
                        ${user.song_count}
                    </span>
                </td>
                <td>
                    <span class="date-cell">${formatDate(user.created_at)}</span>
                </td>
                <td>
                    <div class="action-buttons">
                        <button class="action-btn reset-pw" 
                                data-id="${user.id}" 
                                data-username="${escapeHtml(user.username)}"
                                data-tooltip="Reset Password"
                                ${isSelf ? 'disabled' : ''}>
                            <i class="fas fa-key"></i>
                        </button>
                        <button class="action-btn change-role" 
                                data-id="${user.id}" 
                                data-username="${escapeHtml(user.username)}"
                                data-role="${user.role}"
                                data-tooltip="Change Role"
                                ${isSelf ? 'disabled' : ''}>
                            <i class="fas fa-user-tag"></i>
                        </button>
                        <button class="action-btn delete-user" 
                                data-id="${user.id}" 
                                data-username="${escapeHtml(user.username)}"
                                data-tooltip="Delete User"
                                ${isSelf ? 'disabled' : ''}>
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    // Attach event listeners
    el.usersTableBody.querySelectorAll('.btn-delete-user, .action-btn.delete-user').forEach(btn => {
        btn.addEventListener('click', () => {
            showDeleteConfirm(parseInt(btn.dataset.id), btn.dataset.username);
        });
    });

    el.usersTableBody.querySelectorAll('.btn-reset-pw, .action-btn.reset-pw').forEach(btn => {
        btn.addEventListener('click', () => openResetPasswordModal(parseInt(btn.dataset.id), btn.dataset.username));
    });

    el.usersTableBody.querySelectorAll('.action-btn.change-role').forEach(btn => {
        btn.addEventListener('click', () => openRoleChangeModal(
            parseInt(btn.dataset.id), 
            btn.dataset.username, 
            btn.dataset.role
        ));
    });
}

// Custom Confirm Modal
let confirmCallback = null;
let confirmRequiresInput = false;
let confirmKeyword = '';

function showConfirmModal({ title, message, confirmText = 'Confirm', danger = true, requiresInput = '', callback }) {
    const modal = document.getElementById('confirm-modal');
    const icon = document.getElementById('confirm-modal-icon');
    const titleEl = document.getElementById('confirm-modal-title');
    const messageEl = document.getElementById('confirm-modal-message');
    const inputWrapper = document.getElementById('confirm-modal-input-wrapper');
    const keywordEl = document.getElementById('confirm-modal-keyword');
    const inputEl = document.getElementById('confirm-modal-input');
    const confirmBtn = document.getElementById('confirm-modal-confirm');

    titleEl.textContent = title;
    messageEl.innerHTML = message;
    confirmBtn.textContent = confirmText;
    confirmBtn.className = danger ? 'btn-danger' : 'btn-primary';
    icon.className = danger ? 'confirm-modal-icon' : 'confirm-modal-icon warning';

    if (requiresInput) {
        confirmRequiresInput = true;
        confirmKeyword = requiresInput;
        keywordEl.textContent = requiresInput;
        inputWrapper.style.display = 'block';
        inputEl.value = '';
        confirmBtn.disabled = true;
    } else {
        confirmRequiresInput = false;
        inputWrapper.style.display = 'none';
        confirmBtn.disabled = false;
    }

    confirmCallback = callback;
    modal.style.display = 'flex';

    if (requiresInput) {
        setTimeout(() => inputEl.focus(), 100);
    }
}

// Delete user with custom confirm
function showDeleteConfirm(userId, username) {
    showConfirmModal({
        title: 'Delete User Permanently?',
        message: `
            You are about to delete user <strong style="color: var(--danger-color);">${escapeHtml(username)}</strong>.<br><br>
            This will permanently delete:
            <div style="text-align: left; margin-top: 8px; padding-left: 20px;">
                &bull; All their playlists<br>
                &bull; All their songs & MP3 files<br>
                &bull; All listening history
            </div>
            <br><strong>This action cannot be undone.</strong>
        `,
        confirmText: 'Delete User',
        danger: true,
        requiresInput: username,
        callback: async () => {
            try {
                const res = await fetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
                const data = await res.json();

                if (res.ok) {
                    showToast(`User "${username}" deleted successfully`, 'success');
                    loadUsers();
                } else {
                    showToast(data.error || 'Failed to delete user', 'error');
                }
            } catch (err) {
                showToast('Network error', 'error');
            }
        }
    });
}

function openResetPasswordModal(userId, username) {
    resetPasswordUserId = userId;
    resetPasswordUsername = username;

    document.getElementById('reset-username-display').innerText = username;
    document.getElementById('reset-password-input').value = '';
    document.getElementById('reset-password-confirm').value = '';
    document.getElementById('reset-password-error').style.display = 'none';
    document.getElementById('reset-password-modal').style.display = 'flex';

    setTimeout(() => document.getElementById('reset-password-input').focus(), 100);
}

async function confirmResetPassword() {
    const password = document.getElementById('reset-password-input').value;
    const confirmPw = document.getElementById('reset-password-confirm').value;
    const errorEl = document.getElementById('reset-password-error');

    errorEl.style.display = 'none';

    if (!password) {
        errorEl.textContent = 'Password is required';
        errorEl.style.display = 'block';
        return;
    }
    if (password.length < 6) {
        errorEl.textContent = 'Password must be at least 6 characters';
        errorEl.style.display = 'block';
        return;
    }
    if (password !== confirmPw) {
        errorEl.textContent = 'Passwords do not match';
        errorEl.style.display = 'block';
        return;
    }

    const btn = document.getElementById('confirm-reset-password');
    btn.disabled = true;
    btn.innerText = 'Resetting...';

    try {
        const res = await fetch(`/api/admin/users/${resetPasswordUserId}/reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        const data = await res.json();

        if (res.ok) {
            showToast(`Password reset for "${resetPasswordUsername}"`, 'success');
            document.getElementById('reset-password-modal').style.display = 'none';
        } else {
            errorEl.textContent = data.error || 'Failed to reset password';
            errorEl.style.display = 'block';
        }
    } catch (err) {
        errorEl.textContent = 'Network error';
        errorEl.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.innerText = 'Reset Password';
    }
}

// Role Change Modal
function openRoleChangeModal(userId, username, currentRole) {
    roleChangeUserId = userId;
    roleChangeUsername = username;

    document.getElementById('role-username-display').innerText = username;
    
    // Set current role as selected
    const radios = document.querySelectorAll('input[name="role-choice"]');
    radios.forEach(radio => {
        radio.checked = radio.value === currentRole;
    });

    document.getElementById('role-modal').style.display = 'flex';
}

async function confirmRoleChange() {
    const selected = document.querySelector('input[name="role-choice"]:checked');
    if (!selected) {
        showToast('Please select a role', 'error');
        return;
    }

    const newRole = selected.value;
    const btn = document.getElementById('confirm-role-change');
    btn.disabled = true;
    btn.innerText = 'Saving...';

    try {
        const res = await fetch(`/api/admin/users/${roleChangeUserId}/role`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: newRole })
        });
        const data = await res.json();

        if (res.ok) {
            showToast(`Role updated to ${newRole} for "${roleChangeUsername}"`, 'success');
            document.getElementById('role-modal').style.display = 'none';
            loadUsers();
        } else {
            showToast(data.error || 'Failed to update role', 'error');
        }
    } catch (err) {
        showToast('Network error', 'error');
    } finally {
        btn.disabled = false;
        btn.innerText = 'Save Changes';
    }
}

// Event listeners untuk User Management
if (el.usersBtn) {
    el.usersBtn.addEventListener('click', () => {
        // Toggle: jika sudah di users-view, kembali ke dashboard
        const usersViewActive = el.usersView?.classList.contains('active');
        if (usersViewActive) {
            showView('dashboard');
        } else {
            showView('users');
            loadUsers();
        }
    });
}
document.getElementById('close-users-view')?.addEventListener('click', () => {
    showView('dashboard');
    document.getElementById('home-btn')?.focus();
});
if (el.addUserBtnMain) {
    el.addUserBtnMain.addEventListener('click', () => {
        const modal = document.getElementById('add-user-modal');
        if (modal) modal.style.display = 'flex';
    });
}

// Confirm modal events
document.getElementById('cancel-reset-password')?.addEventListener('click', () => {
    document.getElementById('reset-password-modal').style.display = 'none';
});

document.getElementById('confirm-reset-password')?.addEventListener('click', confirmResetPassword);

document.getElementById('confirm-modal-cancel')?.addEventListener('click', () => {
    document.getElementById('confirm-modal').style.display = 'none';
    confirmCallback = null;
});

document.getElementById('confirm-modal-confirm')?.addEventListener('click', () => {
    if (confirmRequiresInput) {
        const input = document.getElementById('confirm-modal-input').value;
        if (input !== confirmKeyword) {
            showToast('Input does not match', 'error');
            return;
        }
    }
    document.getElementById('confirm-modal').style.display = 'none';
    if (confirmCallback) {
        confirmCallback();
        confirmCallback = null;
    }
});

document.getElementById('confirm-modal-input')?.addEventListener('input', (e) => {
    const confirmBtn = document.getElementById('confirm-modal-confirm');
    confirmBtn.disabled = e.target.value !== confirmKeyword;
});

// Role modal events
document.getElementById('cancel-role-change')?.addEventListener('click', () => {
    document.getElementById('role-modal').style.display = 'none';
});

document.getElementById('confirm-role-change')?.addEventListener('click', confirmRoleChange);

// Search & Filter
document.getElementById('user-search-input')?.addEventListener('input', debounce((e) => {
    userSearchQuery = e.target.value.trim();
    if (allUsersCache.length > 0) {
        fetch('/api/me').then(r => r.json()).then(currentUser => {
            renderUsers(allUsersCache, currentUser);
        });
    }
}, 300));

document.querySelectorAll('.user-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.user-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        userFilter = btn.dataset.filter;
        if (allUsersCache.length > 0) {
            fetch('/api/me').then(r => r.json()).then(currentUser => {
                renderUsers(allUsersCache, currentUser);
            });
        }
    });
});



    // ==========================================
    // ADD NEW USER (Admin Only)
    // ==========================================
    const addUserBtn = document.getElementById('add-user-btn');
    const addUserModal = document.getElementById('add-user-modal');
    const addUserError = document.getElementById('add-user-error');
    const newUsernameInput = document.getElementById('new-username');
    const newPasswordInput = document.getElementById('new-password');
    const confirmAddUser = document.getElementById('confirm-add-user');

    if (addUserBtn) {
        addUserBtn.addEventListener('click', () => {
            addUserModal.style.display = 'flex';
            if (newUsernameInput) newUsernameInput.value = '';
            if (newPasswordInput) newPasswordInput.value = '';
            if (addUserError) addUserError.style.display = 'none';
        });
    }

    document.getElementById('cancel-add-user')?.addEventListener('click', () => {
        if (addUserModal) addUserModal.style.display = 'none';
    });

    if (confirmAddUser) {
        confirmAddUser.addEventListener('click', async () => {
            const username = newUsernameInput?.value.trim();
            const password = newPasswordInput?.value;

            if (!username || !password) {
                if (addUserError) {
                    addUserError.innerText = 'Username and password are required';
                    addUserError.style.display = 'block';
                }
                return;
            }

            confirmAddUser.disabled = true;
            confirmAddUser.innerText = 'Creating...';

            try {
                const res = await fetch('/api/users', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({username, password})
                });
                const data = await res.json();

                if (res.ok && data.status === 'success') {
                    showToast(`Account "${username}" created successfully!`);
                    if (addUserModal) addUserModal.style.display = 'none';
                    loadUsers(); // Refresh user list jika di halaman users
                } else {
                    if (addUserError) {
                        addUserError.innerText = data.error || 'Failed to create user';
                        addUserError.style.display = 'block';
                    }
                }
            } catch (err) {
                if (addUserError) {
                    addUserError.innerText = 'Connection error';
                    addUserError.style.display = 'block';
                }
            } finally {
                confirmAddUser.disabled = false;
                confirmAddUser.innerText = 'Create Account';
            }
        });
    }


    window.loadUsers = loadUsers;
});
})();
