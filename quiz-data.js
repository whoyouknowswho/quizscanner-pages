const QuizData = (() => {
  const magic = new TextEncoder().encode('QUIZSCANNER-BACKUP\n');
  const mimeType = 'application/octet-stream';
  const invalidBackup = () => new Error('File sao lưu QuizScanner bị hỏng hoặc có định dạng không được hỗ trợ.');
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value)
    && !Object.hasOwn(Object.prototype, value) && value !== 'prototype';

  function validQuestions(questions) {
    return Array.isArray(questions) && questions.every(q => isObject(q)
      && (q.images == null || (Array.isArray(q.images) && q.images.every(image => typeof image === 'string')))
      && (q.options == null || isObject(q.options)));
  }

  function validManifest(data) {
    if (!isObject(data) || data.version !== 1 || !isObject(data.sets)
      || typeof data.instantFeedback !== 'boolean' || !Array.isArray(data.uploadedFiles)
      || (data.activeSetId !== null && (!safeId(data.activeSetId) || !Object.hasOwn(data.sets, data.activeSetId)))) {
      return false;
    }
    const validSets = Object.entries(data.sets).every(([id, set]) => safeId(id)
      && isObject(set) && set.id === id && typeof set.name === 'string'
      && (set.restoredFrom == null || safeId(set.restoredFrom))
      && validQuestions(set.questions)
      && (set.allQuestionsBackup == null || validQuestions(set.allQuestionsBackup))
      && Number.isSafeInteger(set.currentIndex) && set.currentIndex >= 0
      && isObject(set.userAnswers) && Object.values(set.userAnswers).every(answer =>
        isObject(answer) && typeof answer.selected === 'string' && /^[A-J]$/.test(answer.selected)
        && typeof answer.isCorrect === 'boolean'));
    const fileIds = new Set();
    const validFiles = data.uploadedFiles.every(file => {
      if (!isObject(file) || !safeId(file.id) || fileIds.has(file.id)
        || typeof file.name !== 'string' || (file.type != null && typeof file.type !== 'string')
        || !Number.isSafeInteger(file.byteLength) || file.byteLength < 0
        || !Number.isSafeInteger(file.size) || file.size < 0
        || (file.questionCount != null && (!Number.isSafeInteger(file.questionCount) || file.questionCount < 0))
        || (file.restoredFrom != null && !safeId(file.restoredFrom))
        || (file.linkedSetId != null && !safeId(file.linkedSetId))) return false;
      fileIds.add(file.id);
      return true;
    });
    return validSets && validFiles;
  }

  function createBackup(snapshot) {
    const files = snapshot.uploadedFiles.map(({ arrayBuffer, ...file }) => {
      if (!(arrayBuffer instanceof ArrayBuffer)) throw invalidBackup();
      return { ...file, byteLength: arrayBuffer.byteLength };
    });
    const manifest = {
      version: 1,
      activeSetId: snapshot.activeSetId,
      instantFeedback: snapshot.instantFeedback,
      sets: snapshot.sets,
      uploadedFiles: files
    };
    if (!validManifest(manifest)) throw invalidBackup();
    const json = new TextEncoder().encode(JSON.stringify(manifest));
    const length = new Uint8Array(4);
    if (json.length > 0xffffffff) throw invalidBackup();
    new DataView(length.buffer).setUint32(0, json.length);
    return new Blob([magic, length, json, ...snapshot.uploadedFiles.map(file => file.arrayBuffer)], { type: mimeType });
  }

  async function inspectBackup(blob) {
    const start = magic.length + 4;
    const header = new Uint8Array(await blob.slice(0, start).arrayBuffer());
    if (header.length !== start || magic.some((byte, i) => header[i] !== byte)) throw invalidBackup();
    const fileOffset = start + new DataView(header.buffer).getUint32(magic.length);
    if (fileOffset > blob.size) throw invalidBackup();
    let manifest;
    try {
      const json = await blob.slice(start, fileOffset).arrayBuffer();
      manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
    } catch {
      throw invalidBackup();
    }
    if (!validManifest(manifest)) throw invalidBackup();
    const end = manifest.uploadedFiles.reduce((offset, file) => offset + file.byteLength, fileOffset);
    if (end !== blob.size) throw invalidBackup();
    return { manifest, fileOffset };
  }

  async function readBackup(blob) {
    const { manifest, fileOffset } = await inspectBackup(blob);
    const { version, uploadedFiles, ...data } = manifest;
    const files = [];
    let offset = fileOffset;
    for (const { byteLength, ...file } of uploadedFiles) {
      const arrayBuffer = await blob.slice(offset, offset + byteLength).arrayBuffer();
      offset += byteLength;
      files.push({ ...file, arrayBuffer });
    }
    return { ...data, uploadedFiles: files };
  }

  function sameRecord(a, b) {
    const { id: aId, restoredFrom: aSource, arrayBuffer: aBytes, ...aData } = a;
    const { id: bId, restoredFrom: bSource, arrayBuffer: bBytes, ...bData } = b;
    if (JSON.stringify(aData) !== JSON.stringify(bData)) return false;
    if (!aBytes && !bBytes) return true;
    if (aBytes?.byteLength !== bBytes?.byteLength) return false;
    const other = new Uint8Array(bBytes);
    return new Uint8Array(aBytes).every((byte, index) => byte === other[index]);
  }

  function mergeBackups(current, incoming, makeId = () => crypto.getRandomValues(new Uint32Array(4)).join('-')) {
    const sets = { ...current.sets };
    const uploadedFiles = current.uploadedFiles.slice();
    const fileIds = new Set(uploadedFiles.map(file => file.id));
    const setIds = new Map();
    const copyId = (prefix, taken) => {
      let id;
      do { id = prefix + '-' + makeId(); } while (taken(id));
      return id;
    };

    for (const set of Object.values(incoming.sets)) {
      const source = set.restoredFrom || set.id;
      const match = Object.values(sets).find(existing =>
        (existing.restoredFrom || existing.id) === source && sameRecord(existing, set));
      const id = match?.id || (Object.hasOwn(sets, set.id) ? copyId('set', key => Object.hasOwn(sets, key)) : set.id);
      if (!match) sets[id] = id === set.id ? set : { ...set, id, restoredFrom: source };
      setIds.set(set.id, id);
    }
    for (const file of incoming.uploadedFiles) {
      const source = file.restoredFrom || file.id;
      const linked = { ...file, linkedSetId: setIds.get(file.linkedSetId) ?? file.linkedSetId };
      if (uploadedFiles.some(existing => (existing.restoredFrom || existing.id) === source && sameRecord(existing, linked))) continue;
      const id = fileIds.has(file.id) ? copyId('file', key => fileIds.has(key)) : file.id;
      uploadedFiles.push(id === file.id ? linked : { ...linked, id, restoredFrom: source });
      fileIds.add(id);
    }
    return {
      sets,
      uploadedFiles,
      activeSetId: current.activeSetId ?? setIds.get(incoming.activeSetId) ?? null,
      instantFeedback: current.activeSetId ? current.instantFeedback : incoming.instantFeedback
    };
  }

  return { mimeType, createBackup, readBackup, inspectBackup, mergeBackups };
})();

if (typeof module !== 'undefined') module.exports = QuizData;
