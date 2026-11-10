// Account data has a separate IndexedDB from the guest workspace. The pending
// revision is written in the same transaction as every local change.
let quizAccount = null;
let quizDataPaused = false;
let cloudHasPending = false;
let cloudConflict = false;
let cloudAuthExpired = false;
let cloudUploadBlocked = false;
let cloudTimer;
let cloudFlight;
let quizReloading = false;
const cloudRevisionKey = 'cloud_revision';
const cloudPendingKey = 'cloud_pending';
const dataEl = id => document.getElementById(id);

function idbResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function writeQuizData(stores, write, { mark = true, duringPause = false } = {}) {
  if (quizDataPaused && !duringPause) return false;
  const dirty = mark && Boolean(quizAccount);
  const tx = await openQuizTransaction(dirty ? [...new Set([...stores, 'app_state'])] : stores, 'readwrite');
  if (quizDataPaused && !duringPause) {
    tx.abort();
    return false;
  }
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error('Giao dịch lưu dữ liệu đã bị hủy.'));
  });
  try {
    write(tx);
    if (dirty) tx.objectStore('app_state').put({ id: cloudPendingKey, value: crypto.randomUUID() });
  } catch (error) {
    tx.abort();
    await done.catch(() => {});
    throw error;
  }
  await done;
  if (dirty) {
    cloudHasPending = true;
    if (!cloudConflict && !cloudAuthExpired && !cloudUploadBlocked) {
      quizDataStatus('Đã lưu trên thiết bị, đang chờ đồng bộ.', 'Đang chờ đồng bộ');
    }
    scheduleCloudUpload();
  }
  return true;
}

function readCloudMetadata(store) {
  return Promise.all([idbResult(store.get(cloudRevisionKey)), idbResult(store.get(cloudPendingKey))]);
}

async function readQuizData() {
  const tx = await openQuizTransaction(['app_state', 'uploaded_files'], 'readonly');
  const app = tx.objectStore('app_state');
  const [main, light, files, [revision, pending]] = await Promise.all([
    idbResult(app.get('main_state')),
    idbResult(app.get('progress_state')),
    idbResult(tx.objectStore('uploaded_files').getAll()),
    readCloudMetadata(app)
  ]);
  let saved = main;
  if (!main && !quizAccount) {
    try { saved = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY)); }
    catch { /* The old cache is optional. */ }
  }
  const sets = saved?.sets || {};
  let activeSetId = saved?.activeSetId;
  let instantFeedback = saved?.instantFeedback !== false;
  if (light?.sets && light.savedAt >= (saved?.savedAt || 0)) {
    for (const [id, progress] of Object.entries(light.sets)) {
      if (Object.hasOwn(sets, id)) {
        sets[id].userAnswers = progress.userAnswers || {};
        sets[id].currentIndex = progress.currentIndex || 0;
      }
    }
    if (Object.hasOwn(sets, light.activeSetId)) activeSetId = light.activeSetId;
    if (typeof light.instantFeedback === 'boolean') instantFeedback = light.instantFeedback;
  }
  if (!Object.hasOwn(sets, activeSetId)) activeSetId = Object.keys(sets)[0] ?? null;
  return {
    hasMain: Boolean(main),
    revision: revision?.value || '0',
    pending: pending?.value,
    snapshot: { sets, activeSetId, instantFeedback, uploadedFiles: files.reverse() }
  };
}

function currentQuizSnapshot() {
  syncActiveSetToStore();
  return {
    sets: state.sets,
    activeSetId: state.activeSetId,
    instantFeedback: state.instantFeedback,
    uploadedFiles: state.uploadedFiles
  };
}

function writeQuizSnapshot(snapshot, { revision, pending }) {
  return writeQuizData(['app_state', 'uploaded_files'], tx => {
    const { uploadedFiles, ...quiz } = snapshot;
    const app = tx.objectStore('app_state');
    app.put({ ...quiz, id: 'main_state', savedAt: Date.now() });
    app.delete('progress_state');
    if (revision !== undefined) app.put({ id: cloudRevisionKey, value: revision });
    if (!pending) app.delete(cloudPendingKey);
    const files = tx.objectStore('uploaded_files');
    files.clear();
    for (const file of uploadedFiles) files.put(file);
  }, { mark: pending, duringPause: true });
}

function quizDataStatus(message, badgeText) {
  dataEl('dataStatus').textContent = quizAccount ? quizAccount.username + ' · ' + message : message;
  if (badgeText) dataEl('saveStatusBadge').textContent = badgeText;
  dataEl('quizMergeBtn').classList.toggle('hidden', !cloudConflict);
}

function reportQuizSaveError(error) {
  console.warn('Lỗi lưu dữ liệu QuizScanner:', error);
  quizDataStatus('Thiết bị không lưu được thay đổi. Hãy xuất bản sao lưu trước khi đóng trang.', 'Lỗi lưu dữ liệu');
  showToast('Không lưu được thay đổi. Hãy xuất bản sao lưu.', 'ph-warning');
}

function cloudIsCurrent() {
  quizDataStatus('Đã đồng bộ dữ liệu với máy chủ.', 'Đã lưu trên máy chủ');
}

function showCloudConflict() {
  cloudConflict = true;
  quizDataStatus('Dữ liệu trên máy chủ đã thay đổi. Bấm “Gộp với dữ liệu máy chủ” để giữ cả hai bản.', 'Cần gộp dữ liệu');
}

function quizAccountHeaders(headers = {}) {
  return { 'X-Quiz-Account': quizAccount.id, ...headers };
}

async function quizApiError(response) {
  const body = await response.json().catch(() => ({}));
  return Object.assign(new Error(body.error || 'Không kết nối được với máy chủ.'), { status: response.status });
}

async function fetchRemoteQuiz(knownRevision) {
  const headers = quizAccountHeaders();
  if (knownRevision !== undefined) headers['If-None-Match'] = '"' + knownRevision + '"';
  const response = await fetch('/api/backup', { headers, signal: AbortSignal.timeout(90_000) });
  if (response.status === 304) return null;
  if (!response.ok) throw await quizApiError(response);
  const revision = response.headers.get('etag')?.slice(1, -1);
  if (!revision) throw new Error('Máy chủ không trả về phiên bản dữ liệu.');
  const snapshot = response.status === 204 ? null : await QuizData.readBackup(await response.blob());
  return { revision, snapshot };
}

function scheduleCloudUpload(delay = 5000) {
  if (!quizAccount || !cloudHasPending || cloudConflict || cloudAuthExpired || cloudUploadBlocked || cloudTimer) return;
  cloudTimer = setTimeout(() => {
    cloudTimer = null;
    syncQuizToServer();
  }, delay);
}

async function syncQuizToServer() {
  if (cloudFlight) return cloudFlight;
  if (!quizAccount || quizDataPaused || cloudConflict || cloudAuthExpired || cloudUploadBlocked) return;
  clearTimeout(cloudTimer);
  cloudTimer = null;
  let retryDelay = 5000;
  cloudFlight = (async () => {
    try {
      const { revision, pending, snapshot } = await readQuizData();
      if (!pending) return;
      quizDataStatus('Đang gửi dữ liệu lên máy chủ…', 'Đang đồng bộ');
      let archive;
      try { archive = QuizData.createBackup(snapshot); }
      catch (error) { throw Object.assign(error, { status: 400 }); }
      const response = await fetch('/api/backup', {
        method: 'PUT',
        headers: quizAccountHeaders({ 'If-Match': '"' + revision + '"', 'X-Quiz-Revision': pending }),
        body: archive,
        signal: AbortSignal.timeout(90_000)
      });
      if (response.status === 412) {
        showCloudConflict();
        return;
      }
      if (response.status !== 204 || response.headers.get('etag') !== '"' + pending + '"') throw await quizApiError(response);
      let remaining = false;
      await writeQuizData(['app_state'], tx => {
        const app = tx.objectStore('app_state');
        app.put({ id: cloudRevisionKey, value: pending });
        const marker = app.get(cloudPendingKey);
        marker.onsuccess = () => {
          remaining = marker.result?.value !== pending && Boolean(marker.result?.value);
          if (!remaining) app.delete(cloudPendingKey);
        };
      }, { mark: false, duringPause: true });
      cloudHasPending = remaining;
      if (!remaining) cloudIsCurrent();
    } catch (error) {
      retryDelay = 15_000;
      if (error.status === 401) {
        cloudAuthExpired = true;
        quizDataStatus('Phiên đăng nhập đã hết hạn. Đăng nhập lại để đồng bộ thay đổi đang lưu trên thiết bị.', 'Cần đăng nhập lại');
      } else if (error.status === 413 || error.status === 400) {
        cloudUploadBlocked = true;
        quizDataStatus(error.message + ' Bạn có thể xuất bản sao lưu.', 'Chưa đồng bộ');
      } else {
        quizDataStatus('Chưa gửi được dữ liệu. Bản lưu trên thiết bị sẽ được gửi lại khi có kết nối.', 'Chưa đồng bộ');
      }
    }
  })().finally(() => {
    cloudFlight = null;
    scheduleCloudUpload(retryDelay);
  });
  return cloudFlight;
}

function acquireQuizTab(accountId) {
  if (!navigator.locks) {
    return Promise.reject(new Error('Hãy mở web bằng HTTPS hoặc localhost trên trình duyệt hỗ trợ đồng bộ.'));
  }
  return new Promise((resolve, reject) => {
    navigator.locks.request('QuizScanner/' + accountId, { ifAvailable: true }, lock => {
      if (!lock) { resolve(false); return; }
      resolve(true);
      // Hold the lock until the tab navigates away or closes.
      return new Promise(release => window.addEventListener('pagehide', release, { once: true }));
    }).catch(reject);
  });
}

async function initializeQuizData() {
  try {
    const managed = Boolean(document.querySelector('meta[name="quiz-account-server"]'));
    if (!managed) {
      quizDataStatus('Đang lưu trên thiết bị này. Tải bản sao lưu để chuyển dữ liệu sang máy khác.', 'Lưu trên thiết bị');
    } else {
      const response = await fetch('/api/account', { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw await quizApiError(response);
      ({ account: quizAccount } = await response.json());
      dataEl('quizAuthForm').classList.toggle('hidden', Boolean(quizAccount));
      dataEl('quizAccountActions').classList.toggle('hidden', !quizAccount);
      if (!quizAccount) quizDataStatus('Đăng nhập để dùng chung dữ liệu trên nhiều thiết bị.', 'Lưu trên thiết bị');
    }
    if (quizAccount) {
      if (!(await acquireQuizTab(quizAccount.id))) {
        throw new Error('Tài khoản này đang mở ở tab khác. Đóng tab đó rồi tải lại trang này.');
      }
      const tx = await openQuizTransaction('app_state', 'readonly');
      const [revision, pending] = await readCloudMetadata(tx.objectStore('app_state'));
      if (pending) {
        cloudHasPending = true;
        quizDataStatus('Đang chờ gửi thay đổi đã lưu trên thiết bị.', 'Đang chờ đồng bộ');
      } else {
        try {
          const remote = await fetchRemoteQuiz(revision?.value || '0');
          if (remote?.snapshot) await writeQuizSnapshot(remote.snapshot, { revision: remote.revision, pending: false });
          if (remote && !remote.snapshot && revision?.value !== '0') showCloudConflict();
          else cloudIsCurrent();
        } catch {
          quizDataStatus('Chưa tải được dữ liệu máy chủ. Đang mở bản lưu trên thiết bị.', 'Chưa đồng bộ');
        }
      }
    }
    await loadProgress();
    scheduleCloudUpload(0);
    return true;
  } catch (error) {
    dataEl('dataStartupNotice').textContent = 'Chưa mở được dữ liệu. ' + (error.message || 'Hãy tải lại trang.');
    return false;
  }
}

function showQuizDataReady() {
  dataEl('dataStartupNotice').hidden = true;
  dataEl('quizHeader').inert = false;
  dataEl('quizMain').inert = false;
}

function openQuizDataPanel() {
  switchView('gallery');
  dataEl('dataHeading').focus({ preventScroll: true });
  dataEl('du-lieu').scrollIntoView({ block: 'start' });
}

function reloadQuizData() {
  quizReloading = true;
  location.hash = '#du-lieu';
  location.reload();
}

function setQuizPaused(paused) {
  quizDataPaused = paused;
  dataEl('quizHeader').inert = paused;
  dataEl('quizMain').inert = paused;
}

async function restoreQuizData(incoming, revision) {
  if (dataEl('startScanBtn').disabled) throw new Error('Hãy đợi quét file xong rồi nạp bản sao lưu.');
  setQuizPaused(true);
  try {
    const { snapshot: { uploadedFiles } } = await readQuizData();
    const current = { ...currentQuizSnapshot(), uploadedFiles };
    const merged = incoming ? QuizData.mergeBackups(current, incoming) : current;
    await writeQuizSnapshot(merged, { revision, pending: true });
    reloadQuizData();
  } catch (error) {
    setQuizPaused(false);
    scheduleCloudUpload();
    throw error;
  }
}

dataEl('dataSettingsBtn').addEventListener('click', openQuizDataPanel);
dataEl('quizAuthForm').addEventListener('submit', async event => {
  event.preventDefault();
  const errorLine = dataEl('quizAuthError');
  errorLine.textContent = '';
  if (dataEl('startScanBtn').disabled) {
    errorLine.textContent = 'Hãy đợi quét file xong rồi đăng nhập.';
    return;
  }
  const action = event.submitter?.value === 'register' ? 'register' : 'login';
  const username = dataEl('quizUsername').value;
  const password = dataEl('quizPassword').value;
  await flushPendingSave();
  setQuizPaused(true);
  try {
    const response = await fetch('/api/account/' + action, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw await quizApiError(response);
    reloadQuizData();
  } catch (error) {
    setQuizPaused(false);
    errorLine.textContent = error.message;
  }
});

dataEl('quizLogoutBtn').addEventListener('click', async () => {
  if (dataEl('startScanBtn').disabled) {
    showToast('Hãy đợi quét file xong rồi đăng xuất.', 'ph-warning');
    return;
  }
  const button = dataEl('quizLogoutBtn');
  button.disabled = true;
  try {
    await flushPendingSave();
    await syncQuizToServer();
    if (cloudHasPending && !confirm('Còn thay đổi chưa lên máy chủ. Bạn có thể đăng nhập lại trên thiết bị này để gửi tiếp. Vẫn đăng xuất?')) return;
    setQuizPaused(true);
    const response = await fetch('/api/account/logout', {
      method: 'POST', headers: quizAccountHeaders(), signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok && response.status !== 401) throw await quizApiError(response);
    reloadQuizData();
  } catch (error) {
    setQuizPaused(false);
    showToast(error.message, 'ph-warning');
  } finally {
    button.disabled = false;
  }
});

dataEl('quizSyncNowBtn').addEventListener('click', async () => {
  const button = dataEl('quizSyncNowBtn');
  button.disabled = true;
  try {
    await flushPendingSave();
    if (cloudAuthExpired || (!cloudHasPending && !cloudConflict)) reloadQuizData();
    else if (!cloudConflict) {
      cloudUploadBlocked = false;
      await syncQuizToServer();
    }
  } finally {
    button.disabled = false;
  }
});

dataEl('quizMergeBtn').addEventListener('click', async () => {
  const button = dataEl('quizMergeBtn');
  button.disabled = true;
  try {
    const remote = await fetchRemoteQuiz();
    await restoreQuizData(remote.snapshot, remote.revision);
  } catch (error) {
    showToast(error.message, 'ph-warning');
  } finally {
    button.disabled = false;
  }
});

dataEl('exportBackupBtn').addEventListener('click', () => {
  try {
    const url = URL.createObjectURL(QuizData.createBackup(currentQuizSnapshot()));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'quizscanner-' + new Date().toISOString().replace(/[:.]/g, '-') + '.quizbackup';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    dataEl('backupNotice').textContent = 'Đã tạo bản sao lưu. Hãy giữ file vừa tải ở nơi an toàn.';
  } catch (error) {
    dataEl('backupNotice').textContent = error.message;
  }
});

const backupInput = dataEl('importBackupInput');
dataEl('importBackupBtn').addEventListener('click', () => backupInput.click());
backupInput.addEventListener('change', async () => {
  const file = backupInput.files[0];
  backupInput.value = '';
  if (!file) return;
  const button = dataEl('importBackupBtn');
  const notice = dataEl('backupNotice');
  button.disabled = true;
  try {
    notice.textContent = 'Đang kiểm tra file sao lưu…';
    const incoming = await QuizData.readBackup(file);
    const count = Object.keys(incoming.sets).length;
    if (confirm(`Gộp ${count} bộ đề và ${incoming.uploadedFiles.length} file gốc từ bản sao lưu vào dữ liệu hiện tại?`)) {
      await restoreQuizData(incoming);
    }
    notice.textContent = '';
  } catch (error) {
    notice.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

window.addEventListener('online', () => scheduleCloudUpload(0));
window.addEventListener('beforeunload', event => {
  if (quizAccount && !quizReloading && (cloudHasPending || saveTimer)) {
    event.preventDefault();
    event.returnValue = true;
  }
});
window.addEventListener('pageshow', event => {
  if (event.persisted && quizAccount) reloadQuizData();
});
