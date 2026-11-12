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
let quizLastSavedAt = 0;
let quizCloud = null;
let cloudLastCheck = 0;
const quizProgressJournalKey = 'QuizScannerPro_Progress_v1';
const quizGitHubKey = 'QuizScannerPro_GitHubSync_v1';
const cloudRevisionKey = 'cloud_revision';
const cloudPendingKey = 'cloud_pending';
const dataEl = id => document.getElementById(id);
const cloudName = () => quizCloud?.name || 'máy chủ';

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

function nextQuizSaveTime() {
  quizLastSavedAt = Math.max(Date.now(), quizLastSavedAt + 1);
  return quizLastSavedAt;
}

function readQuizProgressJournal() {
  if (quizAccount) return null;
  try {
    const progress = JSON.parse(localStorage.getItem(quizProgressJournalKey));
    return Number.isSafeInteger(progress?.savedAt) && progress.sets ? progress : null;
  } catch {
    return null;
  }
}

function writeQuizProgressJournal(progress) {
  if (quizAccount) return false;
  try {
    localStorage.setItem(quizProgressJournalKey, JSON.stringify(progress));
    return true;
  } catch {
    return false;
  }
}

function clearQuizProgressJournal(savedAt) {
  const journal = readQuizProgressJournal();
  if (journal && journal.savedAt <= savedAt) {
    try { localStorage.removeItem(quizProgressJournalKey); } catch { /* Browser storage can be disabled. */ }
  }
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
  const journal = readQuizProgressJournal();
  const latestProgress = journal && journal.savedAt > (light?.savedAt || 0) ? journal : light;
  quizLastSavedAt = Math.max(quizLastSavedAt, saved?.savedAt || 0, latestProgress?.savedAt || 0);
  if (latestProgress?.sets && latestProgress.savedAt >= (saved?.savedAt || 0)) {
    for (const [id, progress] of Object.entries(latestProgress.sets)) {
      if (Object.hasOwn(sets, id)) {
        sets[id].userAnswers = progress.userAnswers || {};
        sets[id].currentIndex = progress.currentIndex || 0;
        if (sets[id].randomExam && typeof progress.examSubmitted === 'boolean') {
          sets[id].examSubmitted = progress.examSubmitted;
        }
      }
    }
    if (Object.hasOwn(sets, latestProgress.activeSetId)) activeSetId = latestProgress.activeSetId;
    if (typeof latestProgress.instantFeedback === 'boolean') instantFeedback = latestProgress.instantFeedback;
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
  const savedAt = nextQuizSaveTime();
  return writeQuizData(['app_state', 'uploaded_files'], tx => {
    const { uploadedFiles, ...quiz } = snapshot;
    const app = tx.objectStore('app_state');
    app.put({ ...quiz, id: 'main_state', savedAt });
    app.delete('progress_state');
    if (revision !== undefined) app.put({ id: cloudRevisionKey, value: revision });
    if (!pending) app.delete(cloudPendingKey);
    const files = tx.objectStore('uploaded_files');
    files.clear();
    for (const file of uploadedFiles) files.put(file);
  }, { mark: pending, duringPause: true }).then(saved => {
    if (saved) clearQuizProgressJournal(savedAt);
    return saved;
  });
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

const quizIsEmpty = snapshot => !Object.keys(snapshot?.sets || {}).length && !(snapshot?.uploadedFiles || []).length;

function quizCounts(sets) {
  const list = Object.values(sets || {}).filter(set => !set.randomExam);
  const questions = list.reduce((sum, set) => sum + (set.questions?.length || 0), 0);
  return `${list.length} bộ đề, ${questions} câu`;
}

function cloudIsCurrent() {
  const counts = typeof state !== 'undefined' && state.sets ? ': ' + quizCounts(state.sets) : '';
  quizDataStatus('Đã đồng bộ với ' + cloudName() + counts + '.', 'Đã lưu trên ' + cloudName());
}

// Applies another device's copy, unless it is empty and this device has data:
// then this device's data is sent instead, so an empty copy never wipes anything.
async function applyRemoteQuiz(remote) {
  const { snapshot: local } = await readQuizData();
  if (quizIsEmpty(remote.snapshot) && !quizIsEmpty(local)) {
    await writeQuizData(['app_state'], tx => {
      const app = tx.objectStore('app_state');
      app.put({ id: cloudRevisionKey, value: remote.revision });
      app.put({ id: cloudPendingKey, value: crypto.randomUUID() });
    }, { mark: false, duringPause: true });
    cloudHasPending = true;
    return false;
  }
  await writeQuizSnapshot(remote.snapshot, { revision: remote.revision, pending: false });
  return true;
}

function showCloudConflict() {
  if (!cloudConflict) showToast(`Thiết bị khác vừa đổi dữ liệu. Vào mục Dữ liệu, bấm “Gộp với dữ liệu ${cloudName()}”.`, 'ph-warning');
  cloudConflict = true;
  quizDataStatus(`Dữ liệu trên ${cloudName()} đã thay đổi từ thiết bị khác. Bấm “Gộp với dữ liệu ${cloudName()}” để giữ cả hai bản.`, 'Cần gộp dữ liệu');
}

function quizAccountHeaders(headers = {}) {
  return { 'X-Quiz-Account': quizAccount.id, ...headers };
}

async function quizApiError(response) {
  const body = await response.json().catch(() => ({}));
  return Object.assign(new Error(body.error || 'Không kết nối được với máy chủ.'), { status: response.status });
}

// Each cloud has pull(knownRevision) -> null | { revision, snapshot } and
// push(snapshot, revision, pending) -> new revision, throwing status 412 on a conflict.
const serverCloud = {
  name: 'máy chủ',
  delay: 5000,
  async pull(knownRevision) {
    const headers = quizAccountHeaders();
    if (knownRevision !== undefined) headers['If-None-Match'] = '"' + knownRevision + '"';
    const response = await fetch('/api/backup', { headers, signal: AbortSignal.timeout(90_000) });
    if (response.status === 304) return null;
    if (!response.ok) throw await quizApiError(response);
    const revision = response.headers.get('etag')?.slice(1, -1);
    if (!revision) throw new Error('Máy chủ không trả về phiên bản dữ liệu.');
    const snapshot = response.status === 204 ? null : await QuizData.readBackup(await response.blob());
    return { revision, snapshot };
  },
  async push(snapshot, revision, pending) {
    let archive;
    try { archive = QuizData.createBackup(snapshot); }
    catch (error) { throw Object.assign(error, { status: 400 }); }
    const response = await fetch('/api/backup', {
      method: 'PUT',
      headers: quizAccountHeaders({ 'If-Match': '"' + revision + '"', 'X-Quiz-Revision': pending }),
      body: archive,
      signal: AbortSignal.timeout(90_000)
    });
    if (response.status === 412) throw Object.assign(new Error('Dữ liệu trên máy chủ đã thay đổi.'), { status: 412 });
    if (response.status !== 204 || response.headers.get('etag') !== '"' + pending + '"') throw await quizApiError(response);
    return pending;
  }
};

function readGitHubConfig() {
  try {
    const config = JSON.parse(localStorage.getItem(quizGitHubKey) || 'null');
    return config?.owner && config.repo && config.token ? config : null;
  } catch {
    return null;
  }
}

function gitHubCloud(config) {
  const client = QuizGitHub.createClient(config);
  return {
    name: 'GitHub',
    delay: 15_000,
    async pull(knownRevision) {
      const local = await readQuizData().then(data => QuizGitHub.localPieces(data.snapshot)).catch(() => new Map());
      return client.pull(knownRevision, local);
    },
    push: (snapshot, revision) => client.push(snapshot, revision)
  };
}

function fetchRemoteQuiz(knownRevision) {
  cloudLastCheck = Date.now();
  return quizCloud.pull(knownRevision);
}

function scheduleCloudUpload(delay = quizCloud?.delay ?? 5000) {
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
      quizDataStatus('Đang gửi dữ liệu lên ' + cloudName() + '…', 'Đang đồng bộ');
      let next;
      try {
        next = await quizCloud.push(snapshot, revision, pending);
      } catch (error) {
        if (error.status !== 412) throw error;
        const empty = !Object.keys(snapshot.sets).length && !snapshot.uploadedFiles.length;
        if (quizAccount.github && (revision === '0' || empty)) {
          // First connection or a device with nothing yet: merging keeps everything, so do it now.
          quizDataStatus('Đang gộp với dữ liệu GitHub…', 'Đang đồng bộ');
          const remote = await fetchRemoteQuiz();
          await restoreQuizData(remote.snapshot, remote.revision);
          return;
        }
        showCloudConflict();
        return;
      }
      cloudLastCheck = Date.now();
      let remaining = false;
      await writeQuizData(['app_state'], tx => {
        const app = tx.objectStore('app_state');
        app.put({ id: cloudRevisionKey, value: next });
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
        if (quizAccount.github) {
          quizDataStatus(error.message + ' Bấm “Ngắt kết nối” rồi kết nối lại bằng token mới. Thay đổi vẫn lưu trên thiết bị.', 'Cần token mới');
        } else {
          quizDataStatus('Phiên đăng nhập đã hết hạn. Đăng nhập lại để đồng bộ thay đổi đang lưu trên thiết bị.', 'Cần đăng nhập lại');
        }
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
      const config = readGitHubConfig();
      dataEl('quizGitHubForm').classList.toggle('hidden', Boolean(config));
      dataEl('quizAccountActions').classList.toggle('hidden', !config);
      if (config) {
        quizAccount = { id: 'github', username: config.owner + '/' + config.repo, github: true };
        quizCloud = gitHubCloud(config);
        dataEl('quizLogoutBtn').textContent = 'Ngắt kết nối';
        dataEl('quizMergeBtn').textContent = 'Gộp với dữ liệu GitHub';
      } else {
        quizDataStatus('Bộ đề và tiến trình chỉ lưu trong trình duyệt này. Kết nối GitHub để dùng chung trên điện thoại và máy tính.', 'Lưu trên thiết bị');
      }
    } else {
      quizCloud = serverCloud;
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
          if (remote?.snapshot && !(await applyRemoteQuiz(remote))) {
            quizDataStatus('Bản trên ' + cloudName() + ' đang trống, đang gửi dữ liệu của thiết bị này lên.', 'Đang chờ đồng bộ');
          } else if (remote && !remote.snapshot && (revision?.value || '0') !== '0') showCloudConflict();
          else cloudIsCurrent();
        } catch (error) {
          if (error.status === 401 && quizAccount.github) {
            cloudAuthExpired = true;
            quizDataStatus(error.message + ' Bấm “Ngắt kết nối” rồi kết nối lại bằng token mới.', 'Cần token mới');
          } else {
            quizDataStatus('Chưa tải được dữ liệu ' + cloudName() + '. Đang mở bản lưu trên thiết bị.', 'Chưa đồng bộ');
          }
        }
      }
    }
    await loadProgress();
    if (quizAccount && !cloudHasPending && !cloudConflict && !cloudAuthExpired && dataEl('saveStatusBadge').textContent.startsWith('Đã lưu trên')) {
      cloudIsCurrent();
    }
    cloudLastCheck = Date.now();
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

dataEl('quizGitHubForm').addEventListener('submit', async event => {
  event.preventDefault();
  const errorLine = dataEl('quizGitHubError');
  const button = dataEl('quizGitHubConnectBtn');
  errorLine.textContent = '';
  if (dataEl('startScanBtn').disabled) {
    errorLine.textContent = 'Hãy đợi quét file xong rồi kết nối.';
    return;
  }
  button.disabled = true;
  button.textContent = 'Đang kiểm tra…';
  try {
    const { owner, repo } = QuizGitHub.parseRepo(dataEl('quizGitHubRepo').value);
    const token = dataEl('quizGitHubToken').value.trim();
    if (!token) throw new Error('Hãy dán token GitHub.');
    const { branch } = await QuizGitHub.createClient({ owner, repo, token }).connect();
    await flushPendingSave();
    await saveProgress();
    const { snapshot } = await readQuizData();
    const hasData = Object.keys(snapshot.sets).length > 0 || snapshot.uploadedFiles.length > 0;
    setQuizPaused(true);
    // Data already on this device is sent up; if GitHub has data too, the user is asked to merge.
    await writeQuizData(['app_state'], tx => {
      const app = tx.objectStore('app_state');
      app.delete(cloudRevisionKey);
      if (hasData) app.put({ id: cloudPendingKey, value: crypto.randomUUID() });
      else app.delete(cloudPendingKey);
    }, { mark: false, duringPause: true });
    localStorage.setItem(quizGitHubKey, JSON.stringify({ owner, repo, branch, token }));
    reloadQuizData();
  } catch (error) {
    setQuizPaused(false);
    errorLine.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Kết nối GitHub';
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
    if (quizAccount.github) {
      if (cloudHasPending && !confirm('Còn thay đổi chưa lên GitHub. Dữ liệu vẫn ở lại trên thiết bị này. Vẫn ngắt kết nối?')) return;
      setQuizPaused(true);
      await writeQuizData(['app_state'], tx => {
        const app = tx.objectStore('app_state');
        app.delete(cloudRevisionKey);
        app.delete(cloudPendingKey);
      }, { mark: false, duringPause: true });
      localStorage.removeItem(quizGitHubKey);
      reloadQuizData();
      return;
    }
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
    const shown = quizAccount?.github && !cloudAuthExpired && !cloudConflict ? currentQuizSnapshot() : null;
    if (shown && !quizIsEmpty(shown)) {
      // Send exactly what this device shows; if another device sent something newer, it is merged.
      await writeQuizSnapshot(shown, { pending: true });
      cloudUploadBlocked = false;
      await syncQuizToServer();
      return;
    }
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

// Phones rarely close tabs: send changes when the page is hidden, and look for
// another device's changes when it comes back.
document.addEventListener('visibilitychange', async () => {
  if (!quizAccount || !quizCloud || quizDataPaused || quizReloading) return;
  if (document.visibilityState === 'hidden') {
    if (saveTimer) await flushPendingSave();
    if (cloudHasPending) syncQuizToServer();
    return;
  }
  if (cloudHasPending || cloudConflict || cloudAuthExpired || cloudFlight || Date.now() - cloudLastCheck < 30_000) return;
  try {
    const { revision, pending } = await readQuizData();
    if (pending) return;
    const remote = await fetchRemoteQuiz(revision);
    if (!remote?.snapshot || cloudHasPending || quizDataPaused) return;
    setQuizPaused(true);
    if (await applyRemoteQuiz(remote)) {
      reloadQuizData();
    } else {
      setQuizPaused(false);
      scheduleCloudUpload(0);
    }
  } catch {
    setQuizPaused(false);
  }
});
window.addEventListener('beforeunload', event => {
  const cloudUnsaved = quizAccount && (cloudHasPending || saveTimer);
  if (!quizReloading && (quizFullSavesPending || quizFullSaveFailed || cloudUnsaved)) {
    event.preventDefault();
    event.returnValue = true;
  }
});
window.addEventListener('pageshow', event => {
  if (event.persisted && quizAccount) reloadQuizData();
});
