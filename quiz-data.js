const QuizData = (() => {
  function createQuizStore(factory, name) {
    let connection;

    function invalidate(opening) {
      if (connection === opening) connection = null;
    }

    function open() {
      if (connection) return connection;
      const opening = new Promise((resolve, reject) => {
        const request = factory.open(name);
        request.onupgradeneeded = () => {
          const db = request.result;
          for (const store of ['app_state', 'uploaded_files']) {
            if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' });
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onclose = () => invalidate(opening);
          db.onversionchange = () => {
            invalidate(opening);
            db.close();
          };
          resolve(db);
        };
        request.onerror = () => reject(request.error);
      });
      connection = opening;
      opening.catch(() => invalidate(opening));
      return opening;
    }

    async function transaction(stores, mode) {
      const opening = open();
      const db = await opening;
      try {
        return db.transaction(stores, mode);
      } catch (error) {
        if (error.name !== 'InvalidStateError') throw error;
        // IndexedDB may already be closing before Chrome delivers its close event.
        invalidate(opening);
        db.close();
        return (await open()).transaction(stores, mode);
      }
    }

    return { transaction };
  }

  const magic = new TextEncoder().encode('QUIZSCANNER-BACKUP\n');
  const mimeType = 'application/octet-stream';
  const invalidBackup = () => new Error('File sao lưu QuizScanner bị hỏng hoặc có định dạng không được hỗ trợ.');
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const isExamPending = set => set?.randomExam === true && set.examSubmitted !== true;
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
      && (set.examSubmitted === undefined || typeof set.examSubmitted === 'boolean')
      && validQuestions(set.questions)
      && (set.allQuestionsBackup == null || validQuestions(set.allQuestionsBackup))
      && Number.isSafeInteger(set.currentIndex) && set.currentIndex >= 0
      && isObject(set.userAnswers) && Object.values(set.userAnswers).every(answer =>
        isObject(answer) && typeof answer.selected === 'string' && /^[A-J]$/.test(answer.selected)
        && (typeof answer.isCorrect === 'boolean' || (isExamPending(set) && answer.isCorrect === undefined))));
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

  const topicRules = [
    ['inheritance', 'Kế thừa', /\b(ke thua|inheritance|base class|derived class|lop co so|lop dan xuat|lop cha|lop con)\b/, /\b(?:class|struct)\s+\w+(?:\s+final)?\s*:(?!:)/],
    ['polymorphism', 'Đa hình', /\b(da hinh|polymorphism|virtual|ham ao|ham thuan ao|ghi de|override|abstract class|lop truu tuong|dynamic binding|lien ket dong)\b/, /\b(?:override|dynamic_cast|typeid)\b|\bvirtual\s+(?!public\b|protected\b|private\b)[^;{}]*?\(/],
    ['templates', 'Template', /\b(templates?|typename|lap trinh tong quat|ham mau|lop mau)\b/, /\btemplate\s*<|\btypename\b/],
    ['exceptions', 'Ngoại lệ (Exception)', /\b(ngoai le|exceptions?|exception handling)\b/, /\btry\s*\{|\bcatch\s*\(|\bthrow\b|\b(?:noexcept|exception|runtime_error|logic_error)\b/],
    ['constructors', 'Constructor & Destructor', /\b(constructors?|destructors?|ham khoi tao|ham huy|sao chep doi tuong)\b/, /~\s*\w+\s*\(|\b(\w+)\s*::\s*\1\s*\(/],
    ['operators', 'Nạp chồng toán tử', /\b(nap chong toan tu|qua tai toan tu|operator overloading)\b/, /\boperator\s*(?:[+\-*/%<>=!&|^~,[\]()]|\b(?:bool|int|new|delete)\b)/],
    ['classes', 'Lớp & đối tượng', /\b(dong goi|encapsulation|access modifiers?|friend|thanh vien tinh|thanh vien rieng|doi tuong|lop va doi tuong|class and object|class members?)\b/, /\b(?:friend|this)\b/],
    ['memory', 'Con trỏ & bộ nhớ', /\b(con tro|bo nho|cap phat dong|tham chieu|pointers?|memory management|dangling reference|smart pointers?)\b/, /\b(?:new|delete|nullptr|malloc|calloc|free|unique_ptr|shared_ptr|weak_ptr)\b/],
    ['stl', 'STL & thư viện chuẩn', /\b(stl|thu vien chuan|standard library|iterators?|containers?)\b/, /#\s*include\s*<(?:vector|array|list|deque|map|unordered_map|set|unordered_set|stack|queue|algorithm|iterator|numeric)>|\bstd\s*::\s*(?:vector|array|list|deque|map|unordered_map|set|unordered_set|stack|queue|sort|find|accumulate)\b/]
  ];
  const topicLabels = Object.fromEntries([
    ['all', 'Tất cả câu hỏi'],
    ...topicRules.map(([id, label]) => [id, label]),
    ['basics', 'Cú pháp & kiến thức cơ bản'],
    ['unclassified', 'Chưa phân loại']
  ]);
  const topicCache = new WeakMap();
  const foldVietnamese = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/đ/g, 'd');

  function questionTopics(question) {
    const { prompt, code, blocks } = question;
    const cached = topicCache.get(question);
    if (cached && cached.prompt === prompt && cached.code === code && cached.blocks === blocks) return cached.topics;

    const parts = Array.isArray(blocks) ? blocks : [];
    const text = [prompt, ...parts.filter(part => part?.type === 'text').map(part => part.content)].filter(Boolean).join('\n');
    const wording = foldVietnamese(text);
    const codeText = [code, ...parts.filter(part => part?.type === 'code').map(part => part.content)].filter(Boolean).join('\n');
    const source = (codeText || text).replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
    const className = source.match(/\b(?:class|struct)\s+(\w+)(?:\s+final)?\s*[:{]/)?.[1];
    const hasConstructor = className && new RegExp('\\b' + className + '\\s*\\(').test(source);
    const topics = topicRules.filter(([id, , words, syntax]) =>
      words.test(wording) || syntax.test(source) || (id === 'constructors' && hasConstructor)
    ).map(([id]) => id);
    if (!topics.length) {
      const genericPrompt = /^(?:(?:ket qua thuc hien doan chuong trinh sau la gi|chon dap an dung)[.?!\s]*)*$/;
      if (className) topics.push('classes');
      else topics.push(source.trim() && (codeText || !genericPrompt.test(wording.trim())) ? 'basics' : 'unclassified');
    }
    topicCache.set(question, { prompt, code, blocks, topics });
    return topics;
  }

  function buildQuestionBank(sets) {
    const bank = new Map(Object.keys(topicLabels).map(id => [id, []]));
    const seen = new Set();
    for (const set of sets) {
      if (set.randomExam) continue;
      const questions = [...(set.questions || []), ...(set.allQuestionsBackup || [])];
      for (const question of questions) {
        const key = bankQuestionKey(question);
        if (seen.has(key)) continue;
        seen.add(key);
        bank.get('all').push(question);
        for (const topic of questionTopics(question)) bank.get(topic).push(question);
      }
    }
    return bank;
  }

  function bankQuestionKey(question) {
    if (question.imageHash) return 'scan:' + question.imageHash;
    if (question.images?.length) return 'scan:' + JSON.stringify([question.images, question.multiQuestionOrdinal]);
    const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    const prompt = normalize(question.prompt);
    const code = String(question.code ?? '').replace(/\r\n/g, '\n').trim();
    const blocks = !prompt && !code && Array.isArray(question.blocks)
      ? question.blocks.map(block => [block?.type, block?.content]) : null;
    const options = Object.values(question.options || {}).map(normalize).sort();
    const answer = normalize(question.options?.[question.correctLetter] ?? question.shortAnswer);
    return JSON.stringify([prompt, code, blocks, options, answer]);
  }

  const squash = value => String(value ?? '').replace(/\s+/g, ' ').trim();

  // Content key of a question for exact-copy detection (whitespace ignored), or null when it cannot be compared.
  // isRead = false: the text has not been read from the image yet, so only an identical image counts.
  function exactDuplicateKey(question, isRead = true, defaultPrompt = '') {
    const image = question.imageHash || (question.images?.length ? JSON.stringify([question.images, question.multiQuestionOrdinal]) : '');
    if (!isRead) return image ? 'scan:' + image : null;
    const blocks = Array.isArray(question.blocks) && question.blocks.length
      ? question.blocks
      : [{ type: 'text', content: question.prompt }, { type: 'code', content: question.code }];
    const placeholder = squash(defaultPrompt);
    const parts = blocks.map(block => [block?.type === 'code' ? 'code' : 'text', squash(block?.content)])
      .filter(([type, text]) => text && !(type === 'text' && text === placeholder));
    if (!parts.length) return image ? 'scan:' + image : null;
    const options = Object.values(question.options || {}).map(squash).filter(Boolean).sort();
    const answer = squash(question.options?.[question.correctLetter] ?? question.shortAnswer);
    if (options.length < 2 && !answer) return null;
    // Without code, the same short wording may belong to different pictures: compare those by image too.
    const hasCode = parts.some(([type]) => type === 'code');
    return JSON.stringify([parts, options, answer, hasCode ? '' : image]);
  }

  // Questions that are exact copies of an earlier one. Returns Map(copy → question kept), keeping the first.
  function exactDuplicates(questions, { isRead = () => true, defaultPrompt = '' } = {}) {
    const firstByKey = new Map();
    const copies = new Map();
    for (const question of questions) {
      const key = exactDuplicateKey(question, isRead(question), defaultPrompt);
      if (!key) continue;
      const first = firstByKey.get(key);
      if (!first) firstByKey.set(key, question);
      else if (first !== question && first.id !== question.id) copies.set(question, first);
    }
    return copies;
  }

  // Fisher–Yates, shared by regular shuffling and drawing questions without replacement.
  function shuffleInPlace(items, random = Math.random) {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  const optionLetters = 'ABCDEFGHIJ';
  const positionalOption = /\b(?:(?:all|none|both|any) (?:of )?(?:the )?(?:above|below)|(?:tat ca|khong co|ca hai)(?: .{0,35})? (?:tren|duoi)|(?:dap an|phuong an|lua chon) [a-j]\b|[a-j]\s*(?:va|hoac|and|or|&)\s*[a-j])\b/;
  const randomExamSize = 50;
  function createRandomExam(questions, setId, random = Math.random) {
    return shuffleInPlace(questions.slice(), random).slice(0, randomExamSize).map((source, index) => {
      const { chat, ...content } = source;
      const question = structuredClone(content);
      question.id = setId + '-q' + (index + 1);
      // Keep source answer letters intact for OCR and grade the displayed choices by their source key.
      question.examOptionOrder = shuffleInPlace([...optionLetters], random);
      // OCR can update the transcription of an exam question without splitting the draw.
      question.needsGrouping = false;
      question.multiQuestionSplitDone = true;
      return question;
    });
  }

  function questionChoices(question) {
    const options = question.options || {};
    const keys = Object.keys(options);
    if (!Array.isArray(question.examOptionOrder)
      || keys.some(key => positionalOption.test(foldVietnamese(String(options[key]))))) {
      return keys.map(key => ({ key, label: key, text: options[key] }));
    }
    const ordered = [...new Set([...question.examOptionOrder, ...keys])].filter(key => Object.hasOwn(options, key));
    return ordered.map((key, index) => ({ key, label: optionLetters[index], text: options[key] }));
  }

  function gradeExam(questions, answers) {
    for (const question of questions) {
      const answer = answers[question.id];
      if (answer) answer.isCorrect = answer.selected === question.correctLetter;
    }
  }

  return {
    mimeType, createBackup, readBackup, inspectBackup, mergeBackups, createQuizStore,
    topicLabels, questionTopics, buildQuestionBank, randomExamSize, createRandomExam, shuffleInPlace,
    questionChoices, isExamPending, gradeExam, exactDuplicates
  };
})();

if (typeof module !== 'undefined') module.exports = QuizData;
