const QuizAi = (() => {
  const providers = Object.freeze({
    gemini: { label: 'Google Gemini', autoModel: true },
    openai: { label: 'OpenAI', base: 'https://api.openai.com/v1', tokenField: 'max_completion_tokens', autoModel: true },
    anthropic: { label: 'Anthropic Claude', base: 'https://api.anthropic.com/v1' },
    openrouter: { label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', autoModel: true, login: true },
    groq: { label: 'Groq', base: 'https://api.groq.com/openai/v1', tokenField: 'max_completion_tokens' },
    deepseek: { label: 'DeepSeek', base: 'https://api.deepseek.com' },
    custom: { label: 'API khác (tương thích OpenAI)' }
  });

  function normalizeSettings(saved = {}, builtInKey = '') {
    const provider = saved.provider ?? 'gemini';
    const known = Object.hasOwn(providers, provider);
    const autoModel = !known || providers[provider].autoModel;
    const userKey = known ? String(saved.apiKey || '').trim() : '';
    const geminiKey = known && provider === 'gemini' ? builtInKey.trim() : '';
    const model = known ? String(saved.model || '').trim() : '';
    return {
      provider: known ? provider : 'gemini',
      baseUrl: provider === 'custom' ? String(saved.baseUrl || '').trim() : '',
      userKey,
      apiKey: userKey || geminiKey,
      model: autoModel && (!model || /^auto$/i.test(model)) ? 'auto' : model,
      vision: typeof saved.vision === 'boolean' ? saved.vision : null,
      login: Boolean(userKey && saved.login === true),
      autoOcr: saved.autoOcr !== false,
      autoExplain: saved.autoExplain !== false
    };
  }

  // Every connected account, the preferred provider first, then the others in provider order.
  function normalizeAccounts(saved = {}, builtInKey = '') {
    const preferred = normalizeSettings(saved, builtInKey);
    const list = preferred.apiKey ? [preferred] : [];
    const accounts = saved.accounts && typeof saved.accounts === 'object' ? saved.accounts : {};
    for (const id of Object.keys(providers)) {
      if (id === preferred.provider || !Object.hasOwn(accounts, id)) continue;
      const account = normalizeSettings({ ...accounts[id], provider: id, autoOcr: saved.autoOcr, autoExplain: saved.autoExplain }, builtInKey);
      if (account.userKey) list.push(account);
    }
    return list;
  }

  function storedAccount(settings) {
    return {
      apiKey: settings.userKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      vision: settings.vision,
      login: settings.login || undefined
    };
  }

  // Builds the saved object: the preferred account at the top level plus every account by provider.
  function serializeAccounts(preferred, accounts, flags = {}) {
    const byProvider = {};
    for (const account of accounts) {
      if (account.userKey) byProvider[account.provider] = storedAccount(account);
    }
    return {
      provider: preferred.provider,
      ...storedAccount(preferred),
      accounts: byProvider,
      autoOcr: flags.autoOcr !== false,
      autoExplain: flags.autoExplain !== false
    };
  }

  // ----- OpenRouter sign-in (OAuth PKCE): the account issues a key billed to its own credits -----
  const base64Url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  async function createPkce(cryptoImpl = globalThis.crypto) {
    const verifier = base64Url(cryptoImpl.getRandomValues(new Uint8Array(32)));
    const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return { verifier, challenge: base64Url(new Uint8Array(digest)) };
  }

  function openRouterAuthUrl(callbackUrl, challenge) {
    return 'https://openrouter.ai/auth?' + new URLSearchParams({
      callback_url: callbackUrl, code_challenge: challenge, code_challenge_method: 'S256'
    });
  }

  async function exchangeOpenRouterCode(code, verifier, fetcher = fetch) {
    let response;
    try {
      response = await fetcher('https://openrouter.ai/api/v1/auth/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(20_000)
      });
    } catch {
      throw new Error('Không kết nối được OpenRouter để hoàn tất đăng nhập. Kiểm tra mạng rồi đăng nhập lại.');
    }
    const data = await response.json().catch(() => null);
    if (!response.ok || typeof data?.key !== 'string' || !data.key) {
      throw new Error('OpenRouter không xác nhận đăng nhập' + (data?.error?.message ? ': ' + String(data.error.message).slice(0, 120) : '.') + ' Hãy đăng nhập lại.');
    }
    return data.key;
  }

  function customBaseUrl(value) {
    let url;
    try { url = new URL(value); } catch { /* Invalid URLs use the same message below. */ }
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('Nhập URL gốc HTTPS của API, ví dụ https://api.example.com/v1.');
    }
    return (url.origin + url.pathname).replace(/\/+$/, '').replace(/\/(?:chat\/completions|models)$/, '');
  }

  function errorFor(status, message, provider, imageRequest) {
    let kind = 'other';
    if (status === 401 || status === 403) kind = 'fatal';
    else if (status === 402) kind = 'credits';
    else if (status === 429) kind = 'rate';
    else if (status >= 500) kind = 'overload';
    else if (status === 413 || /too (?:large|many)|payload size|image limit/i.test(message)) kind = 'request';
    else if (imageRequest && (status === 400 || status === 422) && (
      (/image|vision|multimodal/i.test(message)
        && /support|invalid content type|text.only|only (?:accepts|allows).*text|expected text|unknown variant/i.test(message))
      || /content.*(?:expected (?:a )?string|must be a string)/i.test(message)
    )) kind = 'vision';
    else if (status === 404) kind = 'model';
    return Object.assign(new Error(`${provider} (HTTP ${status})${message ? ' · ' + message : ''}`), { kind });
  }

  function classifyOpenAiError(error, status, details, retryAfter) {
    const code = String(details?.code || '');
    if (status === 429 && [code, details?.type].some(value =>
      /^(?:insufficient_quota|credit_balance_exhausted|(?:organization_|project_)?(?:spend|usage)_limit_exceeded)$/.test(value))) {
      error.kind = 'fatal';
    } else if ((status === 429 || status === 503) && code === 'slow_down') {
      error.kind = 'slow_down';
    } else if ([400, 403, 404].includes(status) && error.kind !== 'vision' && (
      /^(?:model_(?:not_found|not_available|not_supported|access_denied)|unsupported_model)$/.test(code)
      || details?.param === 'model'
      || (status === 403 && /does not have access to (?:the )?model/i.test(error.message))
    )) {
      error.kind = 'model';
    }
    if (retryAfter) {
      const seconds = Number(retryAfter);
      error.retryAt = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(retryAfter);
    }
    return error;
  }

  async function apiJson(settings, path, fetcher, body, imageRequest = false) {
    const provider = providers[settings.provider];
    const base = settings.provider === 'custom' ? customBaseUrl(settings.baseUrl) : provider.base;
    const headers = settings.provider === 'anthropic' ? {
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    } : { Authorization: 'Bearer ' + settings.apiKey };
    if (body) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetcher(base + path, {
        method: body ? 'POST' : 'GET',
        headers,
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(body ? 120_000 : 20_000)
      });
    } catch (error) {
      const message = error?.name === 'TimeoutError'
        ? provider.label + ' phản hồi quá lâu.'
        : 'Không kết nối được ' + provider.label + '. Kiểm tra mạng và quyền truy cập từ trình duyệt (CORS).';
      throw Object.assign(new Error(message), { kind: 'network' });
    }
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.error) {
      const raw = String(data?.error?.message || '');
      const message = (settings.apiKey ? raw.replaceAll(settings.apiKey, '[ẩn API key]') : raw).slice(0, 180);
      const status = response.ok ? Number(data.error.code) || 400 : response.status;
      const error = errorFor(status, message, provider.label, imageRequest);
      throw settings.provider === 'openai'
        ? classifyOpenAiError(error, status, data?.error, response.headers.get('Retry-After'))
        : error;
    }
    if (!data) throw new Error(provider.label + ' không trả dữ liệu JSON hợp lệ.');
    return data;
  }

  async function listModels(settings, fetcher = fetch) {
    const models = new Map();
    let path = '/models';
    for (let page = 0; page < 5; page++) {
      const data = await apiJson(settings, path, fetcher);
      if (!Array.isArray(data.data)) throw new Error('API không trả danh sách model. Bạn có thể nhập tên model thủ công.');
      for (const model of data.data) {
        if (typeof model?.id !== 'string') continue;
        const output = model.output_modalities || model.architecture?.output_modalities;
        if (Array.isArray(output) ? !output.includes('text')
          : /(?:embed|whisper|moderation|dall-e|tts|transcri|sora|realtime|gpt-image|audio|orpheus|prompt-guard|deep-research)/i.test(model.id)) continue;
        const input = model.input_modalities || model.architecture?.input_modalities;
        const vision = model.capabilities?.image_input?.supported;
        const price = model.pricing;
        const free = /:free$/.test(model.id) || (price ? Number(price.prompt) === 0 && Number(price.completion) === 0 : undefined);
        models.set(model.id, {
          id: model.id,
          vision: Array.isArray(input) ? input.includes('image') : (vision ?? null),
          ...(free === undefined ? {} : { free })
        });
      }
      if (settings.provider !== 'anthropic' || !data.has_more || !data.last_id) break;
      path = '/models?after_id=' + encodeURIComponent(data.last_id);
    }
    return [...models.values()].sort((a, b) => Number(b.vision === true) - Number(a.vision === true) || a.id.localeCompare(b.id));
  }

  function quizReply(model, text, truncated) {
    return {
      __model: model,
      candidates: [{ content: { parts: [{ text }] }, finishReason: truncated ? 'MAX_TOKENS' : undefined }]
    };
  }

  async function generateOpenAiResponse(settings, messages, system, maxTokens, fetcher, imageRequest) {
    const input = messages.map(({ role, content }) => ({
      role,
      content: typeof content === 'string' ? content : content.map(part => part.type === 'text'
        ? { type: 'input_text', text: part.text }
        : { type: 'input_image', image_url: part.image_url.url, detail: 'auto' })
    }));
    const data = await apiJson(settings, '/responses', fetcher, {
      model: settings.model,
      instructions: system.trim() || undefined,
      input,
      max_output_tokens: maxTokens,
      store: false
    }, imageRequest);
    if (!Array.isArray(data.output)) throw new Error('OpenAI không trả phản hồi hợp lệ cho model đã chọn.');
    const text = data.output.filter(item => item.type === 'message').flatMap(item => item.content || [])
      .filter(part => part.type === 'output_text').map(part => part.text).join('');
    return quizReply(settings.model, text, data.incomplete_details?.reason === 'max_output_tokens');
  }

  async function generate(settings, payload, fetcher = fetch) {
    const anthropic = settings.provider === 'anthropic';
    const config = payload.generationConfig || {};
    let system = (payload.systemInstruction?.parts || []).map(part => part.text).join('\n');
    if (config.responseMimeType === 'application/json') {
      const schema = JSON.stringify(config.responseSchema, (key, value) =>
        key === 'type' && typeof value === 'string' ? value.toLowerCase() : value);
      system += '\nChỉ trả về một đối tượng JSON hợp lệ. Không thêm Markdown hay lời giải thích bên ngoài JSON.'
        + (schema ? '\nCấu trúc JSON: ' + schema : '');
    }
    const imageRequest = payload.contents.some(message => message.parts.some(part => part.inlineData));
    const messages = payload.contents.map(message => {
      const role = message.role === 'model' ? 'assistant' : 'user';
      const parts = message.parts.map(part => {
        if (!part.inlineData) return { type: 'text', text: part.text };
        const { mimeType, data } = part.inlineData;
        return anthropic
          ? { type: 'image', source: { type: 'base64', media_type: mimeType, data } }
          : { type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } };
      });
      const content = anthropic || parts.some(part => part.type !== 'text') ? parts : parts.map(part => part.text).join('\n');
      return { role, content };
    });
    const maxTokens = config.maxOutputTokens || 8192;
    const openai = settings.provider === 'openai';
    if (openai && /(?:^gpt-6(?:[.-]|$)|^(?:gpt-5(?:\.\d+)?|o\d+)-pro(?:-|$)|codex)/i.test(settings.model)) {
      return generateOpenAiResponse(settings, messages, system, maxTokens, fetcher, imageRequest);
    }
    const tokenField = providers[settings.provider].tokenField || 'max_tokens';
    const chatMessages = !anthropic && system.trim() ? [{ role: 'system', content: system.trim() }, ...messages] : messages;
    const body = { model: settings.model, messages: chatMessages, [tokenField]: maxTokens };
    if (anthropic && system.trim()) body.system = system.trim();
    let data;
    try {
      data = await apiJson(settings, anthropic ? '/messages' : '/chat/completions', fetcher, body, imageRequest);
    } catch (err) {
      if (openai && /responses/i.test(err.message) && /not supported|only supports?|must use/i.test(err.message)) {
        return generateOpenAiResponse(settings, messages, system, maxTokens, fetcher, imageRequest);
      }
      throw err;
    }
    const choice = data.choices?.[0];
    const content = anthropic ? data.content : choice?.message?.content;
    if (anthropic ? !Array.isArray(content) : !choice?.message) {
      throw new Error('API không trả phản hồi hợp lệ cho model đã chọn.');
    }
    const text = typeof content === 'string' ? content : (Array.isArray(content) ? content.filter(p => p.type === 'text').map(p => p.text).join('') : '');
    const truncated = anthropic ? data.stop_reason === 'max_tokens' : choice?.finish_reason === 'length';
    return quizReply(settings.model, text, truncated);
  }

  function rankedOpenAiModels(models, needsImages) {
    const byFamily = new Map();
    for (const model of models) {
      const family = model.id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
      // Chỉ tự chọn các dòng GPT và o-series dùng cho hỏi đáp thông thường.
      // Các bản pro/astra và model chuyên biệt vẫn có thể được chọn thủ công.
      if (!/^(?:gpt-(?:\d+(?:\.\d+)?o?)(?:-(?:mini|nano|luna|sol|terra|turbo))?|o[134](?:-mini)?)$/.test(family)) continue;
      const textOnly = model.vision === false || /^(?:gpt-3\.5|gpt-4$|o[13]-mini$)/.test(family);
      if (needsImages && textOnly) continue;
      const current = byFamily.get(family);
      if (!current || model.id === family || (current !== family && model.id > current)) byFamily.set(family, model.id);
    }
    const lite = name => /-(?:mini|luna|nano)$/.test(name);
    return [...byFamily.entries()].sort(([a], [b]) =>
      Number(lite(b)) - Number(lite(a)) || b.localeCompare(a, 'en', { numeric: true })
    ).map(([, id]) => id);
  }

  // OpenRouter: cheap, capable paid models first (billed to the signed-in account), then free models.
  function rankedOpenRouterModels(models, needsImages, noCredits = false) {
    const vendors = ['google', 'openai', 'anthropic', 'deepseek', 'qwen', 'meta-llama', 'mistralai', 'x-ai', 'moonshotai', 'z-ai'];
    const cheap = /^(?:google\/gemini-[\d.]+-flash(?:-preview)?|openai\/gpt-[\d.]+o?-mini|anthropic\/claude-[\w.-]*haiku[\w.-]*|deepseek\/deepseek-(?:chat|v[\d.]+)[\w.-]*)$/;
    const skip = /(?:embed|audio|image|tts|search|online|guard|-thinking|:extended|:beta|vision-preview)/;
    const usable = models.filter(model => !skip.test(model.id) && !(needsImages && model.vision !== true)
      && vendors.includes(model.id.split('/')[0]));
    const order = (a, b) => vendors.indexOf(a.id.split('/')[0]) - vendors.indexOf(b.id.split('/')[0])
      || b.id.localeCompare(a.id, 'en', { numeric: true });
    const paid = noCredits ? [] : usable.filter(model => model.free === false && cheap.test(model.id)).sort(order);
    const free = usable.filter(model => model.free === true).sort(order);
    return [...paid.slice(0, 4), ...free].map(model => model.id);
  }

  // Tries the chosen model, then other models of the same account when one is unavailable.
  function createModelFallback(settings, { fetcher = fetch, assertCurrent = () => {} } = {}) {
    const openRouter = settings.provider === 'openrouter';
    const label = providers[settings.provider].label;
    const blockedUntil = new Map();
    const textOnly = new Set();
    let catalog;
    let pauseUntil = 0;
    let noCredits = false;
    const pausedError = message => Object.assign(new Error(message), { kind: 'all', retryAt: pauseUntil });
    function slowDown(err) {
      pauseUntil = Math.max(pauseUntil, Date.now() + 60_000, err.retryAt || 0);
      return pausedError(err.message);
    }
    const guardedFetch = (url, options) => {
      assertCurrent();
      return fetcher(url, options);
    };

    return async payload => {
      const needsImages = payload.contents.some(message => message.parts.some(part => part.inlineData));
      const tried = new Set();
      let lastError;
      const available = model => !tried.has(model) && !(needsImages && textOnly.has(model))
        && (blockedUntil.get(model) || 0) <= Date.now();

      async function tryModel(model) {
        assertCurrent();
        if (pauseUntil > Date.now()) throw pausedError(label + ' đang yêu cầu giảm tần suất gửi.');
        tried.add(model);
        try {
          const reply = await generate({ ...settings, model }, payload, guardedFetch);
          assertCurrent();
          return reply;
        } catch (err) {
          assertCurrent();
          if (err.kind === 'slow_down') throw slowDown(err);
          if (err.kind === 'vision' && needsImages) textOnly.add(model);
          else if (err.kind === 'model') blockedUntil.set(model, Infinity);
          else if (err.kind === 'credits' && openRouter) {
            // Account has no credits left for paid models: keep going with free ones
            noCredits = true;
            blockedUntil.set(model, Date.now() + 10 * 60_000);
          }
          else if (err.kind === 'rate' || err.kind === 'overload') {
            blockedUntil.set(model, Math.max(Date.now() + 60_000, err.retryAt || 0));
          } else throw err;
          lastError = err;
          return null;
        }
      }

      assertCurrent();
      if (pauseUntil > Date.now()) throw pausedError(label + ' đang yêu cầu giảm tần suất gửi.');
      const preferred = settings.model && !/^auto$/i.test(settings.model) ? settings.model : '';
      if (preferred && needsImages && settings.vision === false) textOnly.add(preferred);
      if (preferred && available(preferred)) {
        const reply = await tryModel(preferred);
        if (reply) return reply;
      }

      catalog ??= listModels(settings, guardedFetch).catch(err => {
        catalog = null;
        throw err.kind === 'slow_down' ? slowDown(err) : err;
      });
      const list = await catalog;
      const paid = new Set(list.filter(model => model.free === false).map(model => model.id));
      const models = openRouter ? rankedOpenRouterModels(list, needsImages, noCredits) : rankedOpenAiModels(list, needsImages);
      assertCurrent();
      for (const model of models) {
        if (tried.size >= (openRouter ? 6 : 4)) break;
        if (!available(model) || (noCredits && paid.has(model))) continue;
        const reply = await tryModel(model);
        if (reply) return reply;
      }

      const reason = lastError ? ' ' + lastError.message : '';
      const recoverAt = [preferred, ...models].map(model => blockedUntil.get(model)).filter(Number.isFinite);
      if (models.some(available)) recoverAt.push(Date.now() + 1000);
      const summary = needsImages ? 'Hiện chưa có model ' + label + ' phù hợp để đọc ảnh.' : 'Chưa tìm được model ' + label + ' dùng được.';
      throw Object.assign(new Error(summary + reason), {
        kind: needsImages ? 'vision' : 'all', retryAt: Math.min(...recoverAt)
      });
    };
  }

  return {
    providers, normalizeSettings, normalizeAccounts, serializeAccounts, customBaseUrl, listModels, generate,
    createModelFallback, createOpenAiFallback: createModelFallback, rankedOpenRouterModels,
    createPkce, openRouterAuthUrl, exchangeOpenRouterCode
  };
})();

if (typeof module !== 'undefined') module.exports = QuizAi;
