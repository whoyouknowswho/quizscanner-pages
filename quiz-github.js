// Syncs the quiz snapshot to a private GitHub repository through the Git Data API.
// Images and uploaded files are stored once each, bundled into packs/<sha256> and
// located through the state's piece index, so a sync only uploads what changed. A revision is the commit sha the data was read from;
// moving the branch is refused unless it still points there (optimistic locking).
const QuizGitHub = (() => {
  const root = 'quizscanner/';
  const statePath = root + 'state.json';
  const blobDir = root + 'blobs/';
  const packDir = root + 'packs/';
  const packLimit = 12 * 1024 * 1024;
  const marker = 'quizscanner-blob:';
  const inlineLimit = 2048;
  const api = 'https://api.github.com';

  const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  const toBytes = value => typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  const sha256 = async value => hex(await crypto.subtle.digest('SHA-256', toBytes(value)));
  const failure = (status, message) => Object.assign(new Error(message), { status });

  function base64(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  }

  function parseRepo(input) {
    const match = String(input || '').trim()
      .match(/^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/);
    if (!match) throw failure(400, 'Repo cần có dạng tên-tài-khoản/tên-repo, ví dụ an/quizscanner-data.');
    return { owner: match[1], repo: match[2] };
  }

  // Replaces large image strings and uploaded file bytes with references.
  async function splitSnapshot(snapshot) {
    const pieces = new Map();
    const store = async value => {
      const hash = await sha256(value);
      pieces.set(hash, value);
      return hash;
    };
    const cache = new Map();
    const image = async src => {
      if (typeof src !== 'string' || src.length < inlineLimit) return src;
      if (!cache.has(src)) cache.set(src, marker + await store(src));
      return cache.get(src);
    };
    const questions = list => Array.isArray(list)
      ? Promise.all(list.map(async q => Array.isArray(q?.images) ? { ...q, images: await Promise.all(q.images.map(image)) } : q))
      : list;
    const sets = {};
    for (const [id, set] of Object.entries(snapshot.sets)) {
      sets[id] = { ...set, questions: await questions(set.questions) };
      if (set.allQuestionsBackup != null) sets[id].allQuestionsBackup = await questions(set.allQuestionsBackup);
    }
    const uploadedFiles = [];
    for (const { arrayBuffer, ...file } of snapshot.uploadedFiles) {
      uploadedFiles.push({ ...file, blob: await store(arrayBuffer) });
    }
    const manifest = { version: 1, activeSetId: snapshot.activeSetId, instantFeedback: snapshot.instantFeedback, sets, uploadedFiles };
    return { manifest, pieces };
  }

  async function joinSnapshot(manifest, piece) {
    if (manifest?.version !== 1 || !manifest.sets || !Array.isArray(manifest.uploadedFiles)) {
      throw failure(400, 'Dữ liệu trên GitHub không đúng định dạng QuizScanner.');
    }
    const text = async hash => new TextDecoder().decode(await piece(hash));
    const image = src => typeof src === 'string' && src.startsWith(marker) ? text(src.slice(marker.length)) : src;
    const questions = list => Array.isArray(list)
      ? Promise.all(list.map(async q => Array.isArray(q?.images) ? { ...q, images: await Promise.all(q.images.map(image)) } : q))
      : list;
    const sets = {};
    for (const [id, set] of Object.entries(manifest.sets)) {
      sets[id] = { ...set, questions: await questions(set.questions) };
      if (set.allQuestionsBackup != null) sets[id].allQuestionsBackup = await questions(set.allQuestionsBackup);
    }
    const uploadedFiles = [];
    for (const { blob, ...file } of manifest.uploadedFiles) {
      const bytes = await piece(blob);
      uploadedFiles.push({ ...file, arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    }
    return { sets, activeSetId: manifest.activeSetId ?? null, instantFeedback: manifest.instantFeedback !== false, uploadedFiles };
  }

  // Hash -> bytes for everything already on this device, so pulls skip those downloads.
  async function localPieces(snapshot) {
    if (!snapshot) return new Map();
    const { pieces } = await splitSnapshot(snapshot);
    return new Map([...pieces].map(([hash, value]) => [hash, toBytes(value)]));
  }

  function createClient({ owner, repo, token, branch = 'main', api: origin = api, fetch: request = globalThis.fetch.bind(globalThis) }) {
    const base = `${origin}/repos/${owner}/${repo}`;

    async function call(method, path, body, accept = 'application/vnd.github+json') {
      let response;
      try {
        response = await request(base + path, {
          method,
          cache: 'no-store',
          headers: {
            Accept: accept,
            Authorization: 'Bearer ' + token,
            'X-GitHub-Api-Version': '2022-11-28',
            ...(body ? { 'Content-Type': 'application/json' } : {})
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(90_000)
        });
      } catch {
        throw failure(0, 'Không kết nối được với GitHub.');
      }
      if (response.ok) return accept.includes('raw') ? new Uint8Array(await response.arrayBuffer()) : response.json();
      const detail = await response.json().catch(() => ({}));
      if (response.status === 401) throw failure(401, 'Token GitHub sai, đã hết hạn hoặc đã bị thu hồi.');
      const limited = response.headers.get('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'
        || /rate limit|abuse/i.test(detail.message || '');
      if (response.status === 429 || (response.status === 403 && limited)) {
        throw failure(429, 'GitHub đang giới hạn tốc độ gửi. Web sẽ tự thử lại sau ít phút.');
      }
      if (response.status === 403 || response.status === 404) {
        throw failure(401, 'Token không có quyền đọc và ghi repo ' + owner + '/' + repo + '.');
      }
      throw failure(response.status, detail.message || 'GitHub trả về lỗi ' + response.status + '.');
    }

    const head = async () => (await call('GET', '/git/ref/heads/' + branch)).object.sha;
    async function tree(commit) {
      const { tree: { sha } } = await call('GET', '/git/commits/' + commit);
      const { tree: entries, truncated } = await call('GET', '/git/trees/' + sha + '?recursive=1');
      if (truncated) throw failure(413, 'Repo dữ liệu có quá nhiều file.');
      return new Map(entries.filter(entry => entry.type === 'blob').map(entry => [entry.path, entry.sha]));
    }
    const blob = sha => call('GET', '/git/blobs/' + sha, undefined, 'application/vnd.github.raw+json');

    // Checks access and creates the first commit in an empty repository.
    async function connect() {
      const info = await call('GET', '');
      if (info.permissions && !info.permissions.push) throw failure(401, 'Tài khoản này không có quyền ghi repo ' + owner + '/' + repo + '.');
      branch = info.default_branch || branch;
      try {
        await head();
      } catch (error) {
        if (error.status !== 409 && error.status !== 401) throw error;
        await call('PUT', '/contents/README.md', {
          message: 'Tạo kho dữ liệu QuizScanner',
          content: base64(new TextEncoder().encode('# Dữ liệu QuizScanner\n\nRepo này chứa dữ liệu đồng bộ của QuizScanner. Đừng sửa tay thư mục quizscanner/.\n'))
        });
      }
      return { owner, repo, branch };
    }

    const readManifest = async files => files.has(statePath)
      ? JSON.parse(new TextDecoder().decode(await blob(files.get(statePath))))
      : null;
    const holdsData = manifest => Boolean(manifest)
      && (Object.keys(manifest.sets || {}).length > 0 || (manifest.uploadedFiles || []).length > 0);

    // null when unchanged; otherwise the newest revision and its snapshot (null if none yet).
    async function pull(knownRevision, local = new Map()) {
      const revision = await head();
      if (revision === knownRevision) return null;
      const files = await tree(revision);
      const manifest = await readManifest(files);
      if (!manifest) return { revision, snapshot: null };
      const packs = new Map();
      const pack = name => {
        if (!packs.has(name)) {
          const sha = files.get(packDir + name);
          if (!sha) throw failure(400, 'Dữ liệu trên GitHub thiếu một gói ảnh.');
          packs.set(name, blob(sha));
        }
        return packs.get(name);
      };
      const snapshot = await joinSnapshot(manifest, async hash => {
        if (local.has(hash)) return local.get(hash);
        const spot = manifest.pieces?.[hash];
        if (spot) return (await pack(spot[0])).subarray(spot[1], spot[1] + spot[2]);
        const sha = files.get(blobDir + hash);
        if (!sha) throw failure(400, 'Dữ liệu trên GitHub thiếu một ảnh hoặc file gốc.');
        return blob(sha);
      });
      return { revision, snapshot };
    }

    // Returns the new revision, or throws status 412 when GitHub moved past `previous`.
    // A device that never synced ('0') may still replace a remote copy with no quiz data.
    // New images and files are bundled into a few packs: GitHub limits how many objects
    // can be created per minute and per hour, so one request per image would be refused.
    async function push(snapshot, previous) {
      const current = await head();
      const files = await tree(current);
      const remote = await readManifest(files);
      if (previous === '0' ? holdsData(remote) : current !== previous) throw failure(412, 'Dữ liệu trên GitHub đã thay đổi.');
      const { manifest, pieces } = await splitSnapshot(snapshot);
      const known = remote?.pieces || {};
      const index = {};
      let group = [];
      let size = 0;
      const flush = async () => {
        if (!group.length) return;
        const bytes = new Uint8Array(size);
        const spots = [];
        let offset = 0;
        for (const [hash, part] of group) {
          bytes.set(part, offset);
          spots.push([hash, offset, part.length]);
          offset += part.length;
        }
        const name = await sha256(bytes);
        if (!files.has(packDir + name)) {
          const { sha } = await call('POST', '/git/blobs', { content: base64(bytes), encoding: 'base64' });
          files.set(packDir + name, sha);
        }
        for (const [hash, at, length] of spots) index[hash] = [name, at, length];
        group = [];
        size = 0;
      };
      for (const [hash, value] of pieces) {
        if (known[hash] && files.has(packDir + known[hash][0])) {
          index[hash] = known[hash];
          continue;
        }
        const part = toBytes(value);
        if (size && size + part.length > packLimit) await flush();
        group.push([hash, part]);
        size += part.length;
      }
      await flush();
      manifest.pieces = index;
      const entries = [];
      for (const [path, sha] of files) {
        if (!path.startsWith(root)) entries.push({ path, mode: '100644', type: 'blob', sha });
      }
      for (const name of new Set(Object.values(index).map(spot => spot[0]))) {
        entries.push({ path: packDir + name, mode: '100644', type: 'blob', sha: files.get(packDir + name) });
      }
      const state = JSON.stringify(manifest);
      if (state.length < 512 * 1024) {
        entries.push({ path: statePath, mode: '100644', type: 'blob', content: state });
      } else {
        const { sha } = await call('POST', '/git/blobs', { content: base64(new TextEncoder().encode(state)), encoding: 'base64' });
        entries.push({ path: statePath, mode: '100644', type: 'blob', sha });
      }
      const { sha: treeSha } = await call('POST', '/git/trees', { tree: entries });
      const { sha: commit } = await call('POST', '/git/commits', { message: 'Đồng bộ QuizScanner', tree: treeSha, parents: [current] });
      try {
        await call('PATCH', '/git/refs/heads/' + branch, { sha: commit, force: false });
      } catch (error) {
        if (error.status === 422 || error.status === 409) throw failure(412, 'Dữ liệu trên GitHub đã thay đổi.');
        throw error;
      }
      return commit;
    }

    return { connect, pull, push };
  }

  return { parseRepo, splitSnapshot, joinSnapshot, localPieces, createClient, statePath, blobDir, packDir };
})();

if (typeof module !== 'undefined') module.exports = QuizGitHub;
