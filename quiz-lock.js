// Password screen for pages without a server gate (GitHub Pages or the HTML file).
// quiz-lock-config.js holds the owner's password hash; without it each browser
// sets its own. It hides the page from casual use; it does not encrypt stored data.
const QuizLock = (() => {
  const storageKey = 'QuizScannerPro_SiteLock_v1';
  const sessionKey = 'QuizScannerPro_SiteUnlocked_v1';
  const iterations = 600000;
  const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');

  async function hashPassword(password, salt, rounds = iterations) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: rounds }, key, 256);
    return hex(bits);
  }

  async function createRecord(password, rounds = iterations) {
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    return { salt, iterations: rounds, hash: await hashPassword(password, salt, rounds) };
  }

  const validRecord = record => Boolean(record) && /^[a-f0-9]{64}$/.test(record.hash)
    && typeof record.salt === 'string' && Number.isSafeInteger(record.iterations) && record.iterations > 0;

  async function verify(record, password) {
    const hash = await hashPassword(password, record.salt, record.iterations);
    let diff = hash.length ^ record.hash.length;
    for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ (record.hash.charCodeAt(i) || 0);
    return diff === 0;
  }

  function readRecord() {
    if (validRecord(globalThis.QuizLockConfig)) return globalThis.QuizLockConfig;
    try {
      const record = JSON.parse(localStorage.getItem(storageKey) || 'null');
      return validRecord(record) ? record : null;
    } catch (_) { return null; }
  }

  function start() {
    if (document.querySelector('meta[name="quiz-account-server"]')) return;
    const record = readRecord();
    try { if (record && sessionStorage.getItem(sessionKey) === record.hash) return; } catch (_) { /* hỏi lại mật khẩu */ }
    const root = document.documentElement;
    root.classList.add('quiz-locked');
    const style = document.createElement('style');
    style.textContent = `
      html.quiz-locked body > :not(#quizLock) { visibility: hidden !important; }
      html.quiz-locked, html.quiz-locked body { overflow: hidden !important; }
      #quizLock { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 16px; overflow-y: auto;
        background: #f8fafc; color: #0f172a; font: 16px/1.5 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif; }
      #quizLock form { width: 100%; max-width: 360px; background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 28px 24px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); }
      #quizLock h1 { margin: 0 0 4px; font-size: 1.25rem; font-weight: 700; }
      #quizLock p { margin: 0 0 20px; color: #64748b; font-size: 0.925rem; }
      #quizLock label { display: block; font-weight: 600; font-size: 0.875rem; margin: 12px 0 6px; }
      #quizLock input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #e2e8f0; border-radius: 10px; background: #f8fafc; color: inherit; font: inherit; }
      #quizLock input:focus { outline: 2px solid #4f46e5; outline-offset: 1px; }
      #quizLock button { width: 100%; margin-top: 20px; padding: 10px; border: 0; border-radius: 10px; background: #4f46e5; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
      #quizLock button:hover { background: #4338ca; }
      #quizLock button:disabled { opacity: 0.6; cursor: wait; }
      #quizLock [role="alert"] { margin: 16px 0 0; color: #dc2626; font-size: 0.875rem; }
      #quizLock [role="alert"]:empty { display: none; }
      html.dark #quizLock, html.dark #quizLock input { background: #0b0f19; color: #f1f5f9; }
      html.dark #quizLock form { background: #111827; border-color: #1f2937; }
      html.dark #quizLock input { border-color: #1f2937; }
      html.dark #quizLock p { color: #94a3b8; }
      html.dark #quizLock [role="alert"] { color: #f87171; }`;
    document.head.appendChild(style);

    function show() {
      const creating = !record;
      const lock = document.createElement('div');
      lock.id = 'quizLock';
      lock.innerHTML = `
        <form novalidate>
          <h1>QuizScanner</h1>
          <p>${creating ? 'Đặt mật khẩu để người khác dùng máy này không mở được web.' : 'Nhập mật khẩu để mở web.'}</p>
          <input type="text" name="username" value="quizscanner" autocomplete="username" hidden>
          <label for="quizLockPassword">${creating ? 'Mật khẩu mới' : 'Mật khẩu web'}</label>
          <input id="quizLockPassword" type="password" autocomplete="${creating ? 'new-password' : 'current-password'}" required>
          ${creating ? `<label for="quizLockConfirm">Nhập lại mật khẩu</label>
          <input id="quizLockConfirm" type="password" autocomplete="new-password" required>` : ''}
          <div role="alert"></div>
          <button type="submit">${creating ? 'Đặt mật khẩu và mở web' : 'Mở khóa'}</button>
        </form>`;
      document.body.appendChild(lock);
      const form = lock.querySelector('form');
      const password = lock.querySelector('#quizLockPassword');
      const confirm = lock.querySelector('#quizLockConfirm');
      const error = lock.querySelector('[role="alert"]');
      const button = lock.querySelector('button');
      password.focus();

      form.addEventListener('submit', async event => {
        event.preventDefault();
        error.textContent = '';
        if (creating && password.value.length < 6) return void (error.textContent = 'Mật khẩu cần ít nhất 6 ký tự.');
        if (creating && password.value !== confirm.value) return void (error.textContent = 'Hai lần nhập mật khẩu chưa giống nhau.');
        button.disabled = true;
        try {
          let saved = record;
          if (creating) {
            saved = await createRecord(password.value);
            localStorage.setItem(storageKey, JSON.stringify(saved));
          } else if (!(await verify(record, password.value))) {
            await new Promise(resolve => setTimeout(resolve, 800));
            password.value = '';
            password.focus();
            error.textContent = 'Mật khẩu chưa đúng.';
            return;
          }
          try { sessionStorage.setItem(sessionKey, saved.hash); } catch (_) { /* hỏi lại khi tải lại trang */ }
          lock.remove();
          root.classList.remove('quiz-locked');
        } catch (_) {
          error.textContent = 'Trình duyệt không lưu được mật khẩu. Hãy thử trình duyệt khác.';
        } finally {
          button.disabled = false;
        }
      });
    }
    if (document.body) show();
    else document.addEventListener('DOMContentLoaded', show, { once: true });
  }

  return { storageKey, sessionKey, hashPassword, createRecord, verify, validRecord, start };
})();

if (typeof module !== 'undefined') module.exports = QuizLock;
else QuizLock.start();
