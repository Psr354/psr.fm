document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('setup-form');
    if (!form) return;
    const errorMsg = document.getElementById('error-message');
    const errorText = document.getElementById('error-text');
    const btnText = document.getElementById('btn-text');
    const btnSpinner = document.getElementById('btn-spinner');
    const btnArrow = document.getElementById('btn-arrow');
    const submitBtn = form.querySelector('.auth-submit-btn');
    const toggleBtn = document.getElementById('toggle-password');
    const passwordInput = document.getElementById('password');

    toggleBtn?.addEventListener('click', () => {
        const type = passwordInput.type === 'password' ? 'text' : 'password';
        passwordInput.type = type;
        toggleBtn.innerHTML = type === 'password' ? '<i class="fas fa-eye"></i>' : '<i class="fas fa-eye-slash"></i>';
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorMsg.style.display = 'none';

        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;
        const confirmPassword = document.getElementById('confirm-password').value;

        if (password !== confirmPassword) {
            errorText.textContent = 'Passwords do not match';
            errorMsg.style.display = 'flex';
            return;
        }

        btnText.innerText = 'Creating account...';
        btnSpinner.style.display = 'inline-block';
        btnArrow.style.display = 'none';
        submitBtn.disabled = true;

        try {
            const csrfMeta = document.querySelector('meta[name="csrf-token"]');
            const csrfMatch = document.cookie.match(/csrf_token=([^;]+)/);
            const csrfToken = (csrfMatch ? decodeURIComponent(csrfMatch[1]) : '') || (csrfMeta && csrfMeta.content) || '';
            const res = await fetch('/api/setup', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrfToken
                },
                body: JSON.stringify({ username, password })
            });

            const data = await res.json();

            if (res.ok && data.status === 'success') {
                btnText.innerText = 'Account created!';
                btnSpinner.style.display = 'none';
                setTimeout(() => {
                    window.location.href = '/';
                }, 500);
            } else {
                errorText.textContent = data.error || 'Setup failed';
                errorMsg.style.display = 'flex';
                submitBtn.disabled = false;
                btnSpinner.style.display = 'none';
                btnText.innerText = 'Create Account';
                btnArrow.style.display = 'inline-block';
            }
        } catch (err) {
            errorText.textContent = 'Connection error. Please try again.';
            errorMsg.style.display = 'flex';
            submitBtn.disabled = false;
            btnSpinner.style.display = 'none';
            btnText.innerText = 'Create Account';
            btnArrow.style.display = 'inline-block';
        }
    });
});
