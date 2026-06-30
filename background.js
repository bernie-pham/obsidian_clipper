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
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        if (!tab?.id) { sendResponse({ error: 'No active tab' }); return; }
        chrome.tabs.sendMessage(tab.id, { action: 'extract', type: message.type || 'page' }, (resp) => {
          if (chrome.runtime.lastError) {
            sendResponse({ error: chrome.runtime.lastError.message });
          } else {
            sendResponse(resp);
          }
        });
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
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
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
async function handleLLMRequest({ task, content }) {
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
  throw new Error(`Unknown LLM task: ${task}`);
}

async function handleLLMTest({ provider, apiKey, model, endpoint }) {
  if (!apiKey) throw new Error('LLM API key is required.');
  const client = new LLMClient({ provider, apiKey, model, endpoint });
  const result = await client.complete('Reply with the single word: ok');
  return { ok: true, reply: result.trim().slice(0, 100) };
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
