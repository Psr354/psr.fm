document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('login-form');
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
        const isVisible = type === 'text';
        toggleBtn.setAttribute('aria-pressed', String(isVisible));
        toggleBtn.setAttribute('aria-label', isVisible ? 'Hide password' : 'Show password');
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorMsg.style.display = 'none';
        btnText.innerText = 'Signing in...';
        btnSpinner.style.display = 'inline-block';
        btnArrow.style.display = 'none';
        submitBtn.disabled = true;

        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;

        try {
            const csrfMeta = document.querySelector('meta[name="csrf-token"]');
            const csrfMatch = document.cookie.match(/csrf_token=([^;]+)/);
            const csrfToken = (csrfMatch ? decodeURIComponent(csrfMatch[1]) : '') || (csrfMeta && csrfMeta.content) || '';
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrfToken
                },
                body: JSON.stringify({ username, password })
            });

            const data = await res.json();

            if (res.ok && data.status === 'success') {
                btnText.innerText = 'Welcome!';
                btnSpinner.style.display = 'none';
                setTimeout(() => {
                    window.location.href = '/';
                }, 500);
            } else {
                errorText.textContent = data.error || 'Login failed';
                errorMsg.style.display = 'flex';
                submitBtn.disabled = false;
                btnSpinner.style.display = 'none';
                btnText.innerText = 'Sign In';
                btnArrow.style.display = 'inline-block';
            }
        } catch (err) {
            errorText.textContent = 'Connection error. Please try again.';
            errorMsg.style.display = 'flex';
            submitBtn.disabled = false;
            btnSpinner.style.display = 'none';
            btnText.innerText = 'Sign In';
            btnArrow.style.display = 'inline-block';
        }
    });
});
