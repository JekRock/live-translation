const form = document.getElementById('login-form');
const errorEl = document.getElementById('error');
const submitBtn = document.getElementById('submit');

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.hidden = true;
  submitBtn.disabled = true;

  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;

  try {
    const res = await fetch('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (res.ok) {
      window.location = '/';
      return;
    }
    showError('Incorrect username or password.');
  } catch {
    showError('Could not reach the server. Try again.');
  } finally {
    submitBtn.disabled = false;
  }
});
