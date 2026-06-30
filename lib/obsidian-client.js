// lib/obsidian-client.js
// Wrapper for the Obsidian Local REST API plugin (https://github.com/coddingtonbear/obsidian-local-rest-api)
// Default base URL: https://127.0.0.1:27124  (uses self-signed cert → must use http in some setups)

export class ObsidianClient {
  /**
   * @param {string} baseUrl  e.g. "https://127.0.0.1:27124"
   * @param {string} apiKey   Bearer token from the plugin settings
   */
  constructor(baseUrl, apiKey) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  get defaultHeaders() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Raw request helper — used by background.js proxy.
   */
  async request(method, path, body, extraHeaders = {}) {
    const url = `${this.baseUrl}${path}`;
    const opts = {
      method: method.toUpperCase(),
      headers: { ...this.defaultHeaders, ...extraHeaders },
    };
    if (body !== undefined && body !== null) {
      opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Obsidian API ${res.status}: ${text}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.text();
  }

  // ── Vault info ────────────────────────────────────────────────────────────

  /** Returns vault name and basic info. */
  async getVaultInfo() {
    return this.request('GET', '/');
  }

  // ── File operations ───────────────────────────────────────────────────────

  /** List all files in the vault. */
  async listFiles() {
    return this.request('GET', '/vault/');
  }

  /**
   * Read a file's content.
   * @param {string} filePath  path relative to vault root, e.g. "Notes/my-note.md"
   */
  async readFile(filePath) {
    return this.request('GET', `/vault/${encodeURIPath(filePath)}`, null, {
      'Content-Type': 'text/markdown',
    });
  }

  /**
   * Create or overwrite a file.
   * @param {string} filePath
   * @param {string} content  Markdown string
   */
  async writeFile(filePath, content) {
    return this.request('PUT', `/vault/${encodeURIPath(filePath)}`, content, {
      'Content-Type': 'text/markdown',
    });
  }

  /**
   * Append content to an existing file (or create it).
   * @param {string} filePath
   * @param {string} content
   */
  async appendFile(filePath, content) {
    return this.request('POST', `/vault/${encodeURIPath(filePath)}`, content, {
      'Content-Type': 'text/markdown',
    });
  }

  /**
   * Delete a file.
   * @param {string} filePath
   */
  async deleteFile(filePath) {
    return this.request('DELETE', `/vault/${encodeURIPath(filePath)}`);
  }

  // ── Search ────────────────────────────────────────────────────────────────

  /**
   * Full-text search of the vault.
   * @param {string} query
   * @returns {Promise<Array<{filename:string, score:number, matches:string[]}>>}
   */
  async search(query) {
    return this.request('POST', '/search/simple/', { query });
  }

  // ── Recent files ──────────────────────────────────────────────────────────

  /**
   * List recently-modified files.
   * @returns {Promise<string[]>}
   */
  async recentFiles() {
    const result = await this.listFiles();
    const files = result?.files || [];
    // Sort by modified descending (API returns stat info)
    return files
      .filter((f) => f.endsWith('.md'))
      .slice(0, 20); // API doesn't sort; caller can sort by other means
  }
}

// Encode a vault path for URL (keep slashes, encode spaces etc.)
function encodeURIPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}
