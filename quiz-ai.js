const QuizAi = (() => {
  const providers = Object.freeze({
    gemini: { label: 'Google Gemini' },
    openai: { label: 'OpenAI', base: 'https://api.openai.com/v1', tokenField: 'max_completion_tokens' },
    anthropic: { label: 'Anthropic Claude', base: 'https://api.anthropic.com/v1' },
    openrouter: { label: 'OpenRouter', base: 'https://openrouter.ai/api/v1' },
    groq: { label: 'Groq', base: 'https://api.groq.com/openai/v1', tokenField: 'max_completion_tokens' },
    deepseek: { label: 'DeepSeek', base: 'https://api.deepseek.com' },
    custom: { label: 'API khác (tương thích OpenAI)' }
  });

  function normalizeSettings(saved = {}, builtInKey = '') {
    const provider = saved.provider ?? 'gemini';
    const known = Object.hasOwn(providers, provider);
    const userKey = known ? String(saved.apiKey || '').trim() : '';
    const geminiKey = known && provider === 'gemini' ? builtInKey.trim() : '';
    return {
      provider: known ? provider : 'gemini',
      baseUrl: provider === 'custom' ? String(saved.baseUrl || '').trim() : '',
      userKey,
      apiKey: userKey || geminiKey,
      model: (known && String(saved.model || '').trim()) || (provider === 'gemini' || !known ? 'auto' : ''),
      vision: typeof saved.vision === 'boolean' ? saved.vision : null,
      autoOcr: saved.autoOcr !== false,
      autoExplain: saved.autoExplain !== false
    };
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
      throw errorFor(response.ok ? Number(data.error.code) || 400 : response.status, message, provider.label, imageRequest);
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
        models.set(model.id, { id: model.id, vision: Array.isArray(input) ? input.includes('image') : (vision ?? null) });
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
    if (openai && /(?:^(?:gpt-5(?:\.\d+)?|o\d+)-pro(?:-|$)|codex)/i.test(settings.model)) {
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

  return { providers, normalizeSettings, customBaseUrl, listModels, generate };
})();

if (typeof module !== 'undefined') module.exports = QuizAi;
