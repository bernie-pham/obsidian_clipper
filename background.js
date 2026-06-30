// background.js — MV3 Service Worker
// Handles: context menus, message routing, vault fetch proxy, LLM fetch proxy

import { LLMClient } from './lib/llm-client.js';

// ── Side panel behaviour ────────────────────────────────────────────────────
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ── Context menus ───────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'capture-page',
    title: 'Capture page to Obsidian',
    contexts: ['page'],
  });
  chrome.contextMenus.create({
    id: 'capture-selection',
    title: 'Capture selection to Obsidian',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  const type = info.menuItemId === 'capture-selection' ? 'selection' : 'page';
  chrome.sidePanel.open({ tabId: tab.id }).then(() => {
    setTimeout(() => {
      chrome.tabs.sendMessage(tab.id, { action: 'extract', type }, (response) => {
        if (chrome.runtime.lastError || !response) return;
        broadcastToSidebar({ action: 'captureResult', payload: response });
      });
    }, 400);
  }).catch(() => {
    chrome.tabs.sendMessage(tab.id, { action: 'extract', type }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      broadcastToSidebar({ action: 'captureResult', payload: response });
    });
  });
});

// ── Message router ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {

    case 'captureCurrentTab': {
      captureTab(message.type || 'page').then(sendResponse).catch((err) => {
        sendResponse({ error: err.message });
      });
      return true;
    }

    case 'vault:request': {
      handleVaultRequest(message.payload).then(sendResponse).catch((err) => {
        sendResponse({ error: err.message });
      });
      return true;
    }

    case 'vault:folders': {
      listAllFolders().then(sendResponse).catch((err) => {
        sendResponse({ error: err.message });
      });
      return true;
    }

    case 'vault:read': {
      const { path } = message;
      if (!path) { sendResponse({ error: 'path required' }); return true; }
      readVaultFile(path).then(sendResponse).catch((err) => {
        sendResponse({ error: err.message });
      });
      return true;
    }

    case 'vault:test': {
      const { baseUrl, apiKey } = message;
      if (!baseUrl || !apiKey) {
        sendResponse({ error: 'URL and API key are required.' });
        return true;
      }
      vaultFetch('GET', `${baseUrl.replace(/\/$/, '')}/`, null, {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      }).then((data) => {
        sendResponse({ ok: true, data });
      }).catch((err) => {
        sendResponse({ error: err.message });
      });
      return true;
    }

    case 'llm:request': {
      handleLLMRequest(message).then(sendResponse).catch((err) => {
        sendResponse({ error: err.message });
      });
      return true;
    }

    // Full-tab screenshot (no area selection).
    case 'screenshot:capture': {
      handleScreenshotCapture(message.folder, null).then(sendResponse).catch((err) => {
        sendResponse({ error: err.message });
      });
      return true;
    }

    // Area-selection screenshot:
    //   1. Ensures content script is running in the active tab.
    //   2. Captures the full tab screenshot immediately (before overlay appears
    //      so the overlay itself is not in the image).
    //   3. Sends 'screenshot:pick-area' to the content script which shows the
    //      drag-selection overlay and resolves with the chosen rect.
    //   4. Crops the full screenshot to the rect via OffscreenCanvas and saves.
    case 'screenshot:area': {
      handleAreaScreenshot(message.folder).then(sendResponse).catch((err) => {
        sendResponse({ error: err.message });
      });
      return true;
    }

    // Returns a lightweight index of all vault .md files with title + tags
    // extracted from frontmatter — used by the Relevant Notes feature.
    case 'vault:list-notes': {
      listVaultNotes().then(sendResponse).catch((err) => {
        sendResponse({ error: err.message });
      });
      return true;
    }

    case 'llm:test': {
      handleLLMTest(message).then(sendResponse).catch((err) => {
        sendResponse({ error: err.message });
      });
      return true;
    }

    default:
      break;
  }
});

// ── Vault proxy ─────────────────────────────────────────────────────────────
async function handleVaultRequest({ method, path, body, headers }) {
  const settings = await getSettings();
  if (!settings.vaultBaseUrl || !settings.vaultApiKey) {
    throw new Error('Vault not configured. Please check Settings.');
  }
  const url = `${settings.vaultBaseUrl.replace(/\/$/, '')}${path}`;
  const reqHeaders = {
    Authorization: `Bearer ${settings.vaultApiKey}`,
    // Only set Content-Type when there is a body; the Obsidian search API
    // (POST /search/simple/?query=) returns 400 if this header is present with no body.
    ...(body !== null && body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...headers,
  };
  return vaultFetch(method, url, body, reqHeaders);
}

// ── Vault helpers ────────────────────────────────────────────────────────────

async function listAllFolders() {
  const settings = await getSettings();
  if (!settings.vaultBaseUrl || !settings.vaultApiKey) {
    throw new Error('Vault not configured.');
  }

  const seen = new Set();
  async function walk(dirPath, depth) {
    if (depth > 3) return;
    const url = `${settings.vaultBaseUrl.replace(/\/$/, '')}/vault/${dirPath}`;
    const headers = {
      Authorization: `Bearer ${settings.vaultApiKey}`,
      Accept: 'application/json',
    };
    let data;
    try {
      data = await vaultFetch('GET', url, null, headers);
    } catch {
      return;
    }
    const entries = data?.files || [];
    for (const entry of entries) {
      if (entry.endsWith('/')) {
        const fullPath = dirPath ? `${dirPath}${entry}` : entry;
        seen.add(fullPath.replace(/\/$/, ''));
        await walk(fullPath, depth + 1);
      }
    }
  }

  await walk('', 0);
  return { folders: Array.from(seen).sort((a, b) => a.localeCompare(b)) };
}

async function readVaultFile(filePath) {
  const settings = await getSettings();
  if (!settings.vaultBaseUrl || !settings.vaultApiKey) {
    throw new Error('Vault not configured.');
  }
  const url = `${settings.vaultBaseUrl.replace(/\/$/, '')}/vault/${filePath.split('/').map(encodeURIComponent).join('/')}`;
  const result = await vaultFetch('GET', url, null, {
    Authorization: `Bearer ${settings.vaultApiKey}`,
    Accept: 'text/markdown',
  });
  return { content: typeof result === 'string' ? result : JSON.stringify(result) };
}

// ── Vault fetch ──────────────────────────────────────────────────────────────
//
// Direct fetch() from the service worker. The manifest declares host_permissions
// for 127.0.0.1 (both http and https) so Chrome allows the request.
// Both plain HTTP (http://127.0.0.1) and HTTPS (https://127.0.0.1) are supported;
// for HTTPS with a self-signed cert the user must visit the URL once in a tab
// and accept the certificate, after which Chrome's network stack trusts it
// profile-wide — including from the service worker.
async function vaultFetch(method, url, body, headers) {
  const opts = { method, headers };
  if (body !== null && body !== undefined) {
    // Pass ArrayBuffer and strings as-is; JSON-encode everything else.
    opts.body = (body instanceof ArrayBuffer || typeof body === 'string')
      ? body
      : JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Obsidian API ${res.status}: ${text}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

// ── LLM proxy ───────────────────────────────────────────────────────────────
async function handleLLMRequest({ task, content, notes }) {
  const settings = await getSettings();
  const llmCfg = {
    provider: settings.llmProvider,
    apiKey: settings.llmApiKey,
    model: settings.llmModel,
    endpoint: settings.llmEndpoint,
  };
  if (!llmCfg.apiKey) throw new Error('LLM API key not configured.');
  const client = new LLMClient(llmCfg);
  if (task === 'tags') return client.generateTags(content);
  if (task === 'summarize') return client.summarize(content);
  if (task === 'relevant') return client.findRelevantNotes(content, notes || []);
  throw new Error(`Unknown LLM task: ${task}`);
}

// ── Vault note index ─────────────────────────────────────────────────────────
// Fetches all .md files from the vault and extracts title + tags from each
// file's frontmatter without reading the full body. Used for the Relevant
// Notes feature so we can build a compact index for the LLM prompt.
async function listVaultNotes() {
  const settings = await getSettings();
  if (!settings.vaultBaseUrl || !settings.vaultApiKey) {
    throw new Error('Vault not configured.');
  }
  const authHeader = { Authorization: `Bearer ${settings.vaultApiKey}` };

  // 1. Get the full file list
  const listing = await vaultFetch(
    'GET',
    `${settings.vaultBaseUrl.replace(/\/$/, '')}/vault/`,
    null,
    { ...authHeader, Accept: 'application/json' },
  );
  const allFiles = (listing?.files || []).filter((f) => f.endsWith('.md'));

  // 2. Read each file and extract frontmatter — cap at 200 notes to stay
  //    within LLM context limits and avoid excessive API calls.
  const sample = allFiles.slice(0, 200);
  const notes = await Promise.all(
    sample.map(async (filePath) => {
      try {
        const raw = await vaultFetch(
          'GET',
          `${settings.vaultBaseUrl.replace(/\/$/, '')}/vault/${filePath.split('/').map(encodeURIComponent).join('/')}`,
          null,
          { ...authHeader, Accept: 'text/markdown' },
        );
        const text = typeof raw === 'string' ? raw : '';
        const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        let title = filePath.split('/').pop().replace(/\.md$/, '');
        let tags = [];
        if (fmMatch) {
          const fm = fmMatch[1];
          const titleM = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
          if (titleM) title = titleM[1].replace(/^['"]|['"]$/g, '').trim();
          const inlineM = fm.match(/^tags:\s*\[([^\]]*)\]/m);
          const blockM  = fm.match(/^tags:\s*\r?\n((?:[ \t]+-[^\r\n]*\r?\n?)+)/m);
          if (inlineM) {
            tags = inlineM[1].split(',').map((t) => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
          } else if (blockM) {
            tags = blockM[1].split(/\r?\n/).map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
          }
        }
        return { path: filePath, title, tags };
      } catch {
        return { path: filePath, title: filePath.split('/').pop().replace(/\.md$/, ''), tags: [] };
      }
    }),
  );
  return { notes };
}

async function handleLLMTest({ provider, apiKey, model, endpoint }) {
  if (!apiKey) throw new Error('LLM API key is required.');
  const client = new LLMClient({ provider, apiKey, model, endpoint });
  const result = await client.complete('Reply with the single word: ok');
  return { ok: true, reply: result.trim().slice(0, 100) };
}

// ── Screenshot capture ────────────────────────────────────────────────────────

/**
 * Capture the full visible tab, optionally crop to `rect`, save to vault.
 * @param {string|null} folder  - override folder (uses settings.screenshotFolder if null)
 * @param {{x,y,width,height}|null} rect - pixel-space crop rectangle, or null for full tab
 */
async function handleScreenshotCapture(folder, rect) {
  const settings = await getSettings();
  if (!settings.vaultBaseUrl || !settings.vaultApiKey) {
    throw new Error('Vault not configured. Please check Settings.');
  }
  const screenshotFolder = (folder || settings.screenshotFolder || 'Screenshots').replace(/\/$/, '');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

  // Crop if a rect was provided, otherwise use the full image
  const buffer = rect
    ? await cropPng(dataUrl, rect)
    : await (await fetch(dataUrl)).arrayBuffer();

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const filename = `screenshot_${stamp}.png`;
  const vaultPath = `${screenshotFolder}/${filename}`;

  const uploadUrl = `${settings.vaultBaseUrl.replace(/\/$/, '')}/vault/${vaultPath.split('/').map(encodeURIComponent).join('/')}`;
  await vaultFetch('PUT', uploadUrl, buffer, {
    Authorization: `Bearer ${settings.vaultApiKey}`,
    'Content-Type': 'image/png',
  });
  return { path: vaultPath, filename };
}

/**
 * Area-selection screenshot flow:
 *   1. Ensure content script is running.
 *   2. Capture the full tab BEFORE showing the overlay (clean image).
 *   3. Show the drag-select overlay in the page via content.js.
 *   4. Crop the captured image to the selected rect.
 *   5. Save and return the vault path.
 */
async function handleAreaScreenshot(folder) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');

  const url = tab.url || '';
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error('Cannot capture area — navigate to a regular website first.');
  }

  // Ensure content script is available
  const probe = await sendTabMessage(tab.id, { action: 'screenshot:pick-area-probe' });
  if (probe === null) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  }

  // Step 1: capture BEFORE the overlay appears so the overlay is not in the image
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

  // Step 2: show overlay and wait for user to pick an area
  const pickResult = await new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, { action: 'screenshot:pick-area' }, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(resp);
      }
    });
  });

  if (!pickResult?.rect) {
    // User cancelled
    return { cancelled: true };
  }

  // Step 3: crop and save
  return handleScreenshotCapture(folder, pickResult.rect);
}

/**
 * Crop a PNG data URL to the given pixel rectangle using OffscreenCanvas.
 * Available in Chrome MV3 service workers (Chrome 87+).
 * Returns an ArrayBuffer of the cropped PNG.
 */
async function cropPng(dataUrl, { x, y, width, height }) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);

  // Clamp to bitmap bounds to avoid empty draws
  const sx = Math.max(0, Math.min(x, bitmap.width));
  const sy = Math.max(0, Math.min(y, bitmap.height));
  const sw = Math.min(width,  bitmap.width  - sx);
  const sh = Math.min(height, bitmap.height - sy);

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();

  const outBlob = await canvas.convertToBlob({ type: 'image/png' });
  return outBlob.arrayBuffer();
}

// ── Tab capture ───────────────────────────────────────────────────────────────
//
// Sends an 'extract' message to the content script in the active tab.
// If the content script isn't running yet (chrome://, new-tab, PDF, etc.)
// we attempt to inject it on-the-fly via chrome.scripting before retrying.
// If the page is simply not injectable we return a structured error so the
// caller can show a friendly message rather than a raw connection error.
async function captureTab(type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');

  // Reject non-injectable pages immediately using tab.url (readable with
  // the "tabs" permission). chrome://, about:, file://, and extension pages
  // cannot host content scripts.
  const url = tab.url || '';
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error(
      'Cannot read this page — navigate to a regular website (http/https) first.'
    );
  }

  // Fast path: content script already running (declared in manifest for all http/https).
  const firstTry = await sendTabMessage(tab.id, { action: 'extract', type });
  if (firstTry !== null) return firstTry;

  // Slow path: page was open before the extension loaded — inject now, then retry.
  // host_permissions: <all_urls> ensures this succeeds on any http/https page.
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content.js'],
  });

  const secondTry = await sendTabMessage(tab.id, { action: 'extract', type });
  if (secondTry !== null) return secondTry;
  throw new Error('Could not extract page content. Please reload the page and try again.');
}

/** Promise wrapper around chrome.tabs.sendMessage. Returns null on connection error. */
function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        // "Receiving end does not exist" — content script not running yet, caller will inject
        resolve(null);
      } else {
        resolve(resp);
      }
    });
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get('settings', (data) => resolve(data.settings || {}));
  });
}

function broadcastToSidebar(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}
