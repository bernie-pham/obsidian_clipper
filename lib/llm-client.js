// lib/llm-client.js
// Multi-provider LLM client. Runs in background.js only (API keys never leave the service worker).

const PROVIDERS = {
  openai: {
    defaultEndpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o-mini',
    buildRequest: openAIRequest,
  },
  gemini: {
    // Uses v1beta generateContent endpoint; model in URL
    defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    defaultModel: 'gemini-1.5-flash',
    buildRequest: geminiRequest,
  },
  deepseek: {
    defaultEndpoint: 'https://api.deepseek.com/v1/chat/completions',
    defaultModel: 'deepseek-chat',
    buildRequest: openAIRequest, // DeepSeek is OpenAI-compatible
  },
  openai_compatible: {
    defaultEndpoint: '',
    defaultModel: '',
    buildRequest: openAIRequest,
  },
};

export class LLMClient {
  /**
   * @param {{ provider: string, apiKey: string, model: string, endpoint?: string }} config
   */
  constructor(config) {
    this.config = config;
    this.provider = PROVIDERS[config.provider] || PROVIDERS.openai_compatible;
  }

  /**
   * Generate a list of tags for the given markdown content.
   * Returns { tags: string[] }
   */
  async generateTags(content) {
    const truncated = content.slice(0, 4000); // keep prompts cheap
    const prompt = `You are a note-tagging assistant. Given the following note content, return a JSON object with a single key "tags" containing an array of 3–7 lowercase kebab-case tags that best describe the content. Only respond with valid JSON, no explanation.\n\nContent:\n${truncated}`;
    const raw = await this._complete(prompt);
    try {
      const parsed = JSON.parse(extractJSON(raw));
      return { tags: Array.isArray(parsed.tags) ? parsed.tags : [] };
    } catch {
      // Fallback: try to extract tags from free-form text
      const matches = raw.match(/"([a-z0-9-]+)"/g) || [];
      return { tags: matches.map((m) => m.replace(/"/g, '')).slice(0, 7) };
    }
  }

  /**
   * Summarize the given content.
   * Returns { summary: string }
   */
  async summarize(content) {
    const truncated = content.slice(0, 6000);
    const prompt = `Summarize the following in 2–3 concise sentences:\n\n${truncated}`;
    const text = await this._complete(prompt);
    return { summary: text.trim() };
  }

  async complete(prompt) {
    return this._complete(prompt);
  }

  async _complete(prompt) {
    const cfg = this.config;
    const provider = this.provider;

    if (cfg.provider === 'gemini') {
      return geminiComplete(cfg, prompt);
    }

    const endpoint = cfg.endpoint || provider.defaultEndpoint;
    const model = cfg.model || provider.defaultModel;
    const body = provider.buildRequest(model, prompt);

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`LLM API ${res.status}: ${err}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }
}

// ── Provider adapters ─────────────────────────────────────────────────────

function openAIRequest(model, prompt) {
  return {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    max_tokens: 256,
  };
}

function geminiRequest(model, prompt) {
  return {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 256 },
  };
}

async function geminiComplete(cfg, prompt) {
  const model = cfg.model || PROVIDERS.gemini.defaultModel;
  const base = cfg.endpoint || PROVIDERS.gemini.defaultEndpoint;
  const url = `${base}/${model}:generateContent?key=${cfg.apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(geminiRequest(model, prompt)),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Gemini API ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// Extract first JSON object/array from a string
function extractJSON(str) {
  const start = str.search(/[{[]/);
  if (start === -1) return str;
  const end = Math.max(str.lastIndexOf('}'), str.lastIndexOf(']'));
  return end > start ? str.slice(start, end + 1) : str;
}
