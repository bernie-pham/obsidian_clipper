// sidebar/sidebar-src.js — source file, bundled by esbuild into sidebar.js
// All ProseMirror imports come from node_modules (no remote CDN — MV3 CSP blocks that).

import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Schema, DOMParser as PMDOMParser, DOMSerializer } from 'prosemirror-model';
import { schema as basicSchema } from 'prosemirror-schema-basic';
import { addListNodes } from 'prosemirror-schema-list';
import { exampleSetup } from 'prosemirror-example-setup';

// ── Schema (basic + list nodes) ─────────────────────────────────────────────
const mySchema = new Schema({
  nodes: addListNodes(basicSchema.spec.nodes, 'paragraph block*', 'block'),
  marks: basicSchema.spec.marks,
});

// ── State ───────────────────────────────────────────────────────────────────
let editorView = null;
let currentFilePath = null;
let autosaveTimer = null;
let folderDebounceTimer = null;
let allFolders = [];          // cached vault folder list
let conflictVaultContent = null; // holds vault copy during a conflict
let tags = [];
let settings = {};

// ── Boot ────────────────────────────────────────────────────────────────────
(async function init() {
  settings = await loadSettings();
  mountEditor();
  bindUI();
  populateSettingsForm();

  document.getElementById('fm-folder').value = settings.defaultFolder || 'Clippings';

  // Listen for messages from background.js (context menu captures)
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.action === 'captureResult') {
        loadCapture(message.payload);
      }
    });
  }

  // Signal that init is complete — used by Playwright fixture to know the app is ready
  document.documentElement.setAttribute('data-app-ready', 'true');
})();

// ── ProseMirror setup ───────────────────────────────────────────────────────
function mountEditor() {
  const place = document.getElementById('editor');
  if (!place) return;

  const state = EditorState.create({
    schema: mySchema,
    // exampleSetup already includes history and baseKeymap — don't add them again
    // or ProseMirror will throw "Adding different instances of a keyed plugin"
    plugins: exampleSetup({ schema: mySchema, menuBar: false }),
  });

  editorView = new EditorView(place, {
    state,
    dispatchTransaction(tr) {
      const newState = editorView.state.apply(tr);
      editorView.updateState(newState);
      if (tr.docChanged) {
        scheduleAutosave();
        setStatus('Unsaved changes');
      }
    },
  });

  place.addEventListener('click', () => editorView.focus());
}

// ── Load content into editor ────────────────────────────────────────────────
function loadMarkdown(markdown) {
  if (!editorView) return;
  const html = markdownToHTML(markdown);
  const dom = new DOMParser().parseFromString(html, 'text/html');
  const doc = PMDOMParser.fromSchema(mySchema).parse(dom.body);
  const state = EditorState.create({
    doc,
    schema: mySchema,
    plugins: editorView.state.plugins,
  });
  editorView.updateState(state);
}

function getMarkdown() {
  if (!editorView) return '';
  const fragment = DOMSerializer.fromSchema(mySchema).serializeFragment(
    editorView.state.doc.content
  );
  const div = document.createElement('div');
  div.appendChild(fragment);
  return htmlToMarkdown(div.innerHTML);
}

// ── Capture result from content.js ─────────────────────────────────────────
function loadCapture(payload) {
  const { markdown, meta, type } = payload;
  switchTab('editor');
  currentFilePath = null;

  // Populate header UI fields from metadata — frontmatter is rebuilt from
  // these on save and must NOT appear in the editor body.
  if (meta?.title) {
    document.getElementById('note-title').value = sanitizeFilename(meta.title);
  }
  // Source captures start with no tags; clear any leftover from a previous note.
  tags = [];
  renderTags();

  // Load only the body — strip any accidental frontmatter block that may be
  // present in the captured markdown itself (some sites expose meta tags as
  // YAML-like text at the top).
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trimStart();
  loadMarkdown(body);
  document.getElementById('btn-open-obsidian').disabled = true;
  document.getElementById('btn-discard').style.display = 'inline-block';
  setStatus('Captured — review and save');
  showToast(`Page captured${type === 'selection' ? ' (selection)' : ''}`);
}

function buildFrontmatter(meta, type) {
  return [
    '---',
    `source: "${meta?.url || ''}"`,
    `title: "${(meta?.title || '').replace(/"/g, "'")}"`,
    `captured: "${meta?.capturedAt || new Date().toISOString()}"`,
    `type: ${type === 'selection' ? 'clip' : 'article'}`,
    `tags: []`,
    '---',
  ].join('\n');
}

// ── Save to vault ───────────────────────────────────────────────────────────
async function saveToVault(isAutosave = false) {
  const title = document.getElementById('note-title').value.trim();
  const folder = document.getElementById('fm-folder').value.trim()
    || settings.defaultFolder || 'Clippings';
  const filename = sanitizeFilename(title || 'Untitled') + '.md';
  const filePath = currentFilePath || `${folder.replace(/\/$/, '')}/${filename}`;
  const markdown = buildNoteWithFrontmatter();

  if (!isAutosave) setStatus('Saving…');

  try {
    await vaultRequest('PUT', `/vault/${encodePath(filePath)}`, markdown, {
      'Content-Type': 'text/markdown',
    });
    currentFilePath = filePath;
    document.getElementById('btn-open-obsidian').disabled = false;
    document.getElementById('btn-sync').disabled = false;
    setStatus(isAutosave ? `Autosaved ${formatTime()}` : `Saved ${formatTime()}`);
    if (!isAutosave) showToast('Saved to vault ✓');
  } catch (err) {
    setStatus('Save failed');
    if (!isAutosave) showToast('Error: ' + err.message, 'error');
  }
}

function buildNoteWithFrontmatter() {
  const title = document.getElementById('note-title').value.trim();
  const rawContent = getMarkdown();
  const stripped = rawContent.replace(/^---[\s\S]*?---\n?/, '').trim();
  const tagLine = tags.length
    ? `[${tags.map((t) => `"${t}"`).join(', ')}]`
    : '[]';
  const fm = [
    '---',
    `title: "${title.replace(/"/g, "'")}"`,
    `tags: ${tagLine}`,
    `updated: "${new Date().toISOString()}"`,
    '---',
  ].join('\n');
  return `${fm}\n\n${stripped}`;
}

function scheduleAutosave() {
  if (!currentFilePath) return;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => saveToVault(true), 1500);
}

// ── Folder combobox ──────────────────────────────────────────────────────────

/**
 * Fetch all folders from background (cached in module state).
 * Called once lazily; subsequent calls return the cached list.
 * Exposed on window for test resets.
 */
async function ensureFoldersLoaded() {
  if (allFolders.length > 0) return allFolders;
  try {
    const result = await sendToBackground('vault:folders', {});
    if (result?.error) throw new Error(result.error);
    allFolders = result?.folders || [];
  } catch {
    allFolders = [];
  }
  return allFolders;
}

/** Reset the cached folder list — called in tests to clear stale state. */
function resetFolderCache() { allFolders = []; }
window.__resetFolderCache = resetFolderCache;

/**
 * Directly inject folders into the cache and trigger a list refresh.
 * Exposed on window for Playwright tests that need deterministic folder lists
 * without going through the async sendMessage path.
 */
function injectFolders(folders) {
  allFolders = folders;
}
window.__injectFolders = injectFolders;

/**
 * Wire up the folder input so it shows a filtered dropdown as the user types.
 * Debounced at 250 ms so we don't re-render on every keystroke.
 */
function initFolderCombobox() {
  const input = document.getElementById('fm-folder');
  const listbox = document.getElementById('folder-listbox');
  let activeIdx = -1;

  function showList(items) {
    listbox.innerHTML = '';
    activeIdx = -1;
    if (!items.length) { listbox.hidden = true; input.setAttribute('aria-expanded', 'false'); return; }
    items.forEach((folder, i) => {
      const li = document.createElement('li');
      li.className = 'folder-option';
      li.setAttribute('role', 'option');
      li.setAttribute('id', `folder-opt-${i}`);
      li.textContent = folder;
      li.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep input focused
        selectFolder(folder);
      });
      listbox.appendChild(li);
    });
    listbox.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function hideList() {
    listbox.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    activeIdx = -1;
  }

  function selectFolder(folder) {
    input.value = folder;
    hideList();
  }

  function setActive(idx) {
    const options = listbox.querySelectorAll('.folder-option');
    options.forEach((o) => o.classList.remove('active'));
    if (idx >= 0 && idx < options.length) {
      options[idx].classList.add('active');
      options[idx].scrollIntoView({ block: 'nearest' });
      input.setAttribute('aria-activedescendant', `folder-opt-${idx}`);
    }
    activeIdx = idx;
  }

  // Debounced input handler
  input.addEventListener('input', () => {
    clearTimeout(folderDebounceTimer);
    folderDebounceTimer = setTimeout(async () => {
      const query = input.value.trim().toLowerCase();
      const folders = await ensureFoldersLoaded();
      const matches = query
        ? folders.filter((f) => f.toLowerCase().includes(query))
        : folders;
      showList(matches.slice(0, 20)); // cap at 20 visible options
    }, 250);
  });

  // Show full list on focus (lazy-load folders first time).
  // Do NOT pre-filter by the existing input value on focus — show all folders
  // so the user can see the full list and then narrow by typing.
  input.addEventListener('focus', async () => {
    const folders = await ensureFoldersLoaded();
    showList(folders.slice(0, 20));
  });

  // Keyboard navigation inside the dropdown
  input.addEventListener('keydown', (e) => {
    const options = listbox.querySelectorAll('.folder-option');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(Math.min(activeIdx + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(activeIdx - 1, 0));
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      selectFolder(options[activeIdx].textContent);
    } else if (e.key === 'Escape') {
      hideList();
    }
  });

  // Hide when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#folder-combobox')) hideList();
  });
}

// ── Sync from vault ──────────────────────────────────────────────────────────

/**
 * Pull the current file from the vault and compare it with the editor.
 * Three outcomes:
 *   1. Vault == editor (or editor is empty draft) → load vault version silently.
 *   2. Editor has changes that are NOT in the vault → show conflict banner,
 *      save both versions (editor copy under a ".conflict" name, vault stays).
 *   3. Error fetching → show toast.
 */
async function syncFromVault() {
  if (!currentFilePath) { showToast('Save the note first before syncing.', 'error'); return; }

  const btn = document.getElementById('btn-sync');
  btn.disabled = true;
  setStatus('Syncing…');

  // Hide any previous conflict banner
  hideConflictBanner();

  try {
    const result = await sendToBackground('vault:read', { path: currentFilePath });
    if (result?.error) throw new Error(result.error);
    const vaultContent = result.content || '';
    const editorContent = buildNoteWithFrontmatter();

    // Strip the auto-generated `updated:` timestamp before comparing — it changes
    // on every buildNoteWithFrontmatter() call and would always look like a conflict.
    const stripUpdated = (s) => s.replace(/^updated:.*$/m, '').trim();
    const vaultNorm = stripUpdated(vaultContent);
    const editorNorm = stripUpdated(editorContent);

    if (vaultNorm === editorNorm) {
      // Already in sync
      setStatus(`In sync ${formatTime()}`);
      showToast('Already up to date ✓');
      return;
    }

    // Check if editor has unsaved local changes relative to vault:
    // If the editor content differs from what the vault has, that is a conflict.
    // Save the conflicting editor copy as "<title>.conflict.md"
    const titleEl = document.getElementById('note-title');
    const conflictPath = currentFilePath.replace(/\.md$/, '') + `.conflict.${Date.now()}.md`;

    // 1. Write the current editor state as the conflict copy
    await vaultRequest('PUT', `/vault/${encodePath(conflictPath)}`, editorContent, {
      'Content-Type': 'text/markdown',
    });

    // 2. Store vault content for "use vault version" action
    conflictVaultContent = vaultContent;

    // 3. Show the conflict banner
    showConflictBanner(conflictPath);
    setStatus('Conflict — choose a version');

  } catch (err) {
    setStatus('Sync failed');
    showToast('Sync error: ' + err.message, 'error');
  } finally {
    btn.disabled = !currentFilePath;
  }
}

function showConflictBanner(conflictPath) {
  const banner = document.getElementById('conflict-banner');
  banner.querySelector('.conflict-body').textContent =
    `The vault version differs from your editor. Your editor copy was saved as "${conflictPath.split('/').pop()}". Choose which version to keep in the editor.`;
  banner.hidden = false;
}

function hideConflictBanner() {
  document.getElementById('conflict-banner').hidden = true;
  conflictVaultContent = null;
}

// ── Tag management ──────────────────────────────────────────────────────────
function renderTags() {
  const container = document.getElementById('tag-chips');
  if (!container) return;
  container.innerHTML = '';
  tags.forEach((tag, i) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.dataset.tag = tag;
    chip.innerHTML = `${escapeHTML(tag)}<button class="tag-chip-remove" data-index="${i}" title="Remove tag" aria-label="Remove ${escapeHTML(tag)}">×</button>`;
    container.appendChild(chip);
  });
  container.querySelectorAll('.tag-chip-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      tags.splice(Number(btn.dataset.index), 1);
      renderTags();
    });
  });
}

function addTag(tag) {
  const t = tag.trim().toLowerCase().replace(/\s+/g, '-');
  if (t && !tags.includes(t)) {
    tags.push(t);
    renderTags();
  }
}

async function suggestTags() {
  const btn = document.getElementById('btn-suggest-tags');
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const content = getMarkdown();
    const result = await sendToBackground('llm:request', { task: 'tags', content });
    if (result.error) throw new Error(result.error);
    (result.tags || []).forEach(addTag);
    showToast(`Added ${result.tags.length} suggested tags`);
  } catch (err) {
    showToast('Tag suggestion failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '✦ Suggest';
  }
}

// ── Recent notes ────────────────────────────────────────────────────────────
async function loadRecentNotes() {
  const list = document.getElementById('recent-list');
  list.innerHTML = '<p class="empty-state"><span class="spinner"></span> Loading…</p>';
  try {
    const result = await vaultRequest('GET', '/vault/');
    const files = (result?.files || []).filter((f) => f.endsWith('.md')).slice(0, 30);
    renderFileList(list, files);
  } catch (err) {
    list.innerHTML = `<p class="empty-state">Error: ${escapeHTML(err.message)}</p>`;
  }
}

function renderFileList(container, files) {
  if (!files.length) {
    container.innerHTML = '<p class="empty-state">No notes found.</p>';
    return;
  }
  container.innerHTML = '';
  files.forEach((filePath) => {
    const parts = filePath.split('/');
    const name = parts.pop().replace(/\.md$/, '');
    const path = parts.join('/');
    const item = document.createElement('div');
    item.className = 'file-item';
    item.dataset.filepath = filePath;
    item.innerHTML = `
      <span class="file-item-name">${escapeHTML(name)}</span>
      <span class="file-item-path">${escapeHTML(path)}</span>
      <div class="file-item-actions">
        <button class="icon-btn" data-path="${escapeHTML(filePath)}" title="Open in editor" data-action="edit">✎</button>
        <button class="icon-btn" data-path="${escapeHTML(filePath)}" title="Open in Obsidian" data-action="obsidian">↗</button>
      </div>
    `;
    item.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.dataset.action === 'edit') openNoteInEditor(btn.dataset.path);
        else openInObsidian(btn.dataset.path);
      });
    });
    item.addEventListener('click', () => openNoteInEditor(filePath));
    container.appendChild(item);
  });
}

async function openNoteInEditor(filePath) {
  switchTab('editor');
  setStatus('Loading…');
  try {
    const content = await vaultRequest('GET', `/vault/${encodePath(filePath)}`, null, {
      'Content-Type': 'text/markdown',
      Accept: 'text/markdown',
    });
    currentFilePath = filePath;
    const parts = filePath.split('/');
    const filenameStem = parts.pop().replace(/\.md$/, '');
    document.getElementById('fm-folder').value = parts.join('/') || '';

    // Parse frontmatter for title and tags
    tags = [];
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) {
      const fm = fmMatch[1];

      // title: overrides the filename stem when present
      const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
      document.getElementById('note-title').value =
        titleMatch ? titleMatch[1].replace(/^['"]|['"]$/g, '').trim() : filenameStem;

      // tags — two formats Obsidian uses:
      //   inline array:  tags: ["foo", "bar"]  or  tags: [foo, bar]
      //   block list:    tags:\n  - foo\n  - bar
      const inlineMatch = fm.match(/^tags:\s*\[([^\]]*)\]/m);
      const blockMatch  = fm.match(/^tags:\s*\r?\n((?:[ \t]+-[^\r\n]*\r?\n?)+)/m);
      if (inlineMatch) {
        tags = inlineMatch[1]
          .split(',')
          .map((t) => t.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
      } else if (blockMatch) {
        tags = blockMatch[1]
          .split(/\r?\n/)
          .map((line) => line.replace(/^\s*-\s*/, '').trim())
          .filter(Boolean);
      }
      renderTags();
    } else {
      document.getElementById('note-title').value = filenameStem;
    }

    // Strip frontmatter before loading into the editor — it is displayed in
    // the header UI (title, folder, tags) and rebuilt on save by
    // buildNoteWithFrontmatter(). Showing it raw in the editor is confusing.
    const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trimStart();
    loadMarkdown(body);
    document.getElementById('btn-open-obsidian').disabled = false;
    document.getElementById('btn-sync').disabled = false;
    document.getElementById('btn-discard').style.display = 'none';
    setStatus('Loaded');
  } catch (err) {
    setStatus('Load failed');
    showToast('Error: ' + err.message, 'error');
  }
}

// ── Relevant Notes ──────────────────────────────────────────────────────────

/**
 * 1. Capture the current tab's text content.
 * 2. Fetch the vault note index (title + tags of every .md file).
 * 3. Ask the LLM to rank which notes are most semantically related.
 * 4. Render the ranked results.
 *
 * Triggered automatically when the Relevant tab is opened, and manually via
 * the refresh button.
 */
async function findRelevantNotes() {
  const list = document.getElementById('relevant-list');
  list.innerHTML = '<p class="empty-state"><span class="spinner"></span> Analysing page…</p>';

  try {
    // Step 1 — extract the current page content
    const pageData = await sendToBackground('captureCurrentTab', { type: 'page' });
    if (pageData?.error) {
      showRelevantError(list, pageData.error);
      return;
    }
    const pageText = (pageData?.markdown || '').slice(0, 4000);
    if (!pageText.trim()) {
      showRelevantError(list, 'Could not extract page content. Make sure you are on a regular website (http/https).');
      return;
    }

    // Step 2 — fetch vault note index (title + tags only, no full bodies)
    list.innerHTML = '<p class="empty-state"><span class="spinner"></span> Loading vault index…</p>';
    const indexResult = await sendToBackground('vault:list-notes', {});
    if (indexResult?.error) throw new Error(indexResult.error);
    const notes = indexResult?.notes || [];
    if (!notes.length) {
      showRelevantError(list, 'No notes found in vault. Check your Settings connection.');
      return;
    }

    // Step 3 — ask LLM to rank
    list.innerHTML = '<p class="empty-state"><span class="spinner"></span> Finding relevant notes…</p>';
    const result = await sendToBackground('llm:request', { task: 'relevant', content: pageText, notes });
    if (result?.error) throw new Error(result.error);

    const matches = result?.matches || [];
    if (!matches.length) {
      list.innerHTML = '<p class="empty-state">No relevant notes found for this page.</p>';
      return;
    }

    // Step 4 — render
    renderRelevantList(list, matches);

  } catch (err) {
    showRelevantError(list, err.message);
  }
}

/**
 * Render an error message with a Retry button inside the relevant-list container.
 * The Retry button re-runs findRelevantNotes so the user doesn't have to leave
 * the tab (useful after navigating to a new page or reloading).
 */
function showRelevantError(container, message) {
  container.innerHTML = `
    <div class="relevant-error">
      <p class="empty-state">${escapeHTML(message)}</p>
      <button id="btn-relevant-retry" class="btn-secondary compact">Retry</button>
    </div>
  `;
  container.querySelector('#btn-relevant-retry')
    .addEventListener('click', findRelevantNotes);
}

function renderRelevantList(container, matches) {
  container.innerHTML = '';
  matches.forEach(({ path: filePath, title, reason, score }) => {
    const parts = filePath.split('/');
    parts.pop(); // discard filename — title already parsed
    const folder = parts.join('/');
    const pct = Math.round(score * 100);

    const item = document.createElement('div');
    item.className = 'file-item relevant-item';
    item.dataset.filepath = filePath;
    item.innerHTML = `
      <div class="relevant-item-main">
        <div class="relevant-item-header">
          <span class="file-item-name">${escapeHTML(title)}</span>
          <span class="relevance-badge" title="Relevance score">${pct}%</span>
        </div>
        <span class="relevant-reason">${escapeHTML(reason)}</span>
        ${folder ? `<span class="file-item-path">${escapeHTML(folder)}</span>` : ''}
      </div>
      <div class="file-item-actions">
        <button class="icon-btn" data-path="${escapeHTML(filePath)}" title="Open in editor" data-action="edit">✎</button>
        <button class="icon-btn" data-path="${escapeHTML(filePath)}" title="Open in Obsidian" data-action="obsidian">↗</button>
      </div>
    `;
    item.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.dataset.action === 'edit') openNoteInEditor(btn.dataset.path);
        else openInObsidian(btn.dataset.path);
      });
    });
    item.addEventListener('click', () => openNoteInEditor(filePath));
    container.appendChild(item);
  });
}

// ── Screenshot ───────────────────────────────────────────────────────────────

/**
 * Run a screenshot action ('area' or 'full') and insert the result into the editor.
 * @param {'area'|'full'} mode
 */
async function captureScreenshot(mode = 'area') {
  const btn = document.getElementById('btn-screenshot');
  const menuBtn = document.getElementById('btn-screenshot-menu');
  btn.disabled = true;
  menuBtn.disabled = true;
  setStatus(mode === 'area' ? 'Select area…' : 'Capturing…');
  try {
    const folder = settings.screenshotFolder || 'Screenshots';
    const action = mode === 'area' ? 'screenshot:area' : 'screenshot:capture';
    const result = await sendToBackground(action, { folder });
    if (result?.error) throw new Error(result.error);
    if (result?.cancelled) {
      setStatus('Screenshot cancelled');
      return;
    }
    // Insert Obsidian wikilink embed at cursor: ![[path/to/file.png]]
    insertTextAtCursor(`![[${result.path}]]`);
    setStatus('Screenshot saved');
    showToast(`Screenshot saved to ${result.path}`);
  } catch (err) {
    setStatus('Screenshot failed');
    showToast('Screenshot error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    menuBtn.disabled = false;
  }
}

/** Toggle the screenshot mode dropdown. Closes on outside click or item select. */
function initScreenshotMenu() {
  const menuBtn = document.getElementById('btn-screenshot-menu');
  const menu    = document.getElementById('screenshot-menu');

  function closeMenu() {
    menu.hidden = true;
    menuBtn.setAttribute('aria-expanded', 'false');
  }

  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !menu.hidden;
    if (isOpen) {
      closeMenu();
    } else {
      menu.hidden = false;
      menuBtn.setAttribute('aria-expanded', 'true');
    }
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-action]');
    if (!item) return;
    closeMenu();
    captureScreenshot(item.dataset.action);
  });

  document.addEventListener('click', (e) => {
    if (!document.getElementById('screenshot-btn-group').contains(e.target)) {
      closeMenu();
    }
  });
}

/**
 * Insert plain text at the ProseMirror cursor position.
 * Falls back to appending a new paragraph if the editor has no selection.
 */
function insertTextAtCursor(text) {
  if (!editorView) return;
  const { state, dispatch } = editorView;
  const { from } = state.selection;
  // Insert as a text node inside a paragraph
  const textNode = state.schema.text(text);
  dispatch(state.tr.insertText(text, from));
  editorView.focus();
}

// ── Search ──────────────────────────────────────────────────────────────────
async function runSearch() {
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;
  const resultsEl = document.getElementById('search-results');
  resultsEl.innerHTML = '<p class="empty-state"><span class="spinner"></span> Searching…</p>';
  try {
    // The API requires the query as a URL parameter: POST /search/simple/?query=<term>
    // It does not accept a JSON body — it returns 400 if only a body is sent.
    const results = await vaultRequest('POST', `/search/simple/?query=${encodeURIComponent(query)}`);
    if (!Array.isArray(results) || !results.length) {
      resultsEl.innerHTML = '<p class="empty-state">No results found.</p>';
      return;
    }
    const files = results.map((r) => r.filename || r.path || '').filter(Boolean);
    renderFileList(resultsEl, files);
  } catch (err) {
    resultsEl.innerHTML = `<p class="empty-state">Error: ${escapeHTML(err.message)}</p>`;
  }
}

// ── Settings ─────────────────────────────────────────────────────────────────
async function testVaultConnection() {
  const btn = document.getElementById('btn-test-connection');
  const status = document.getElementById('connection-status');
  btn.disabled = true;
  status.textContent = 'Testing…';
  status.className = 'connection-status';
  try {
    const baseUrl = document.getElementById('cfg-base-url').value.trim();
    const apiKey = document.getElementById('cfg-api-key').value.trim();
    if (!baseUrl || !apiKey) throw new Error('URL and API key are required.');
    const result = await sendToBackground('vault:test', { baseUrl, apiKey });
    if (result?.error) throw new Error(result.error);
    // API response: { service, manifest: { name }, authenticated, status }
    const name = result?.data?.manifest?.name
      || result?.data?.service
      || 'Connected';
    if (result?.data?.authenticated === false) throw new Error('Invalid API key.');
    status.textContent = `✓ ${name}`;
    status.className = 'connection-status ok';
  } catch (err) {
    status.textContent = `✗ ${err.message}`;
    status.className = 'connection-status err';
  } finally {
    btn.disabled = false;
  }
}

async function testLLMConnection() {
  const btn = document.getElementById('btn-test-llm');
  const status = document.getElementById('llm-status');
  btn.disabled = true;
  status.textContent = 'Testing…';
  status.className = 'connection-status';
  try {
    const provider = document.getElementById('cfg-llm-provider').value;
    const apiKey = document.getElementById('cfg-llm-api-key').value.trim();
    const model = document.getElementById('cfg-llm-model').value.trim();
    const endpoint = document.getElementById('cfg-llm-endpoint').value.trim();
    if (!apiKey) throw new Error('LLM API key is required.');
    const result = await sendToBackground('llm:test', { provider, apiKey, model, endpoint });
    if (result?.error) throw new Error(result.error);
    status.textContent = `✓ ${provider} — "${result.reply}"`;
    status.className = 'connection-status ok';
  } catch (err) {
    status.textContent = `✗ ${err.message}`;
    status.className = 'connection-status err';
  } finally {
    btn.disabled = false;
  }
}

async function saveSettings() {
  const newSettings = readSettingsForm();
  await chrome.storage.local.set({ settings: newSettings });
  settings = newSettings;
  const statusEl = document.getElementById('settings-status');
  statusEl.textContent = 'Saved ✓';
  setTimeout(() => { statusEl.textContent = ''; }, 2000);
  showToast('Settings saved');
}

function readSettingsForm() {
  return {
    vaultBaseUrl: document.getElementById('cfg-base-url').value.trim(),
    vaultApiKey: document.getElementById('cfg-api-key').value.trim(),
    defaultFolder: document.getElementById('cfg-default-folder').value.trim(),
    screenshotFolder: document.getElementById('cfg-screenshot-folder').value.trim(),
    llmProvider: document.getElementById('cfg-llm-provider').value,
    llmApiKey: document.getElementById('cfg-llm-api-key').value.trim(),
    llmModel: document.getElementById('cfg-llm-model').value.trim(),
    llmEndpoint: document.getElementById('cfg-llm-endpoint').value.trim(),
  };
}

function populateSettingsForm() {
  document.getElementById('cfg-base-url').value = settings.vaultBaseUrl || '';
  document.getElementById('cfg-api-key').value = settings.vaultApiKey || '';
  document.getElementById('cfg-default-folder').value = settings.defaultFolder || 'Clippings';
  document.getElementById('cfg-screenshot-folder').value = settings.screenshotFolder || 'Screenshots';
  document.getElementById('cfg-llm-provider').value = settings.llmProvider || 'openai';
  document.getElementById('cfg-llm-api-key').value = settings.llmApiKey || '';
  document.getElementById('cfg-llm-model').value = settings.llmModel || '';
  document.getElementById('cfg-llm-endpoint').value = settings.llmEndpoint || '';
  toggleCustomEndpoint(settings.llmProvider || 'openai');
}

function toggleCustomEndpoint(provider) {
  const el = document.getElementById('custom-endpoint-group');
  if (el) el.style.display = provider === 'openai_compatible' ? 'block' : 'none';
}

// ── Tab switching ────────────────────────────────────────────────────────────
export function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach((b) => {
    const active = b.dataset.tab === tabId;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.tab-view').forEach((v) => {
    v.classList.toggle('active', v.id === `tab-${tabId}`);
  });
  if (tabId === 'recent') loadRecentNotes();
  if (tabId === 'relevant') findRelevantNotes();
}

// ── "Open in Obsidian" protocol ──────────────────────────────────────────────
function openInObsidian(filePath) {
  const vaultName = settings.vaultName || '';
  const uri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(filePath)}`;
  if (typeof chrome !== 'undefined' && chrome.tabs) {
    chrome.tabs.create({ url: uri });
  } else {
    window.open(uri, '_blank');
  }
}

// ── Bind all UI events ──────────────────────────────────────────────────────
function bindUI() {
  // Folder combobox must be initialised before any other events
  initFolderCombobox();
  initScreenshotMenu();

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('btn-capture-page').addEventListener('click', async () => {
    const result = await sendToBackground('captureCurrentTab', { type: 'page' });
    if (result?.error) { showToast(result.error, 'error'); return; }
    loadCapture(result);
  });

  document.getElementById('btn-new-note').addEventListener('click', () => {
    currentFilePath = null;
    tags = [];
    renderTags();
    document.getElementById('note-title').value = '';
    document.getElementById('fm-folder').value = settings.defaultFolder || 'Clippings';
    loadMarkdown('');
    document.getElementById('btn-open-obsidian').disabled = true;
    document.getElementById('btn-sync').disabled = true;
    document.getElementById('btn-discard').style.display = 'none';
    hideConflictBanner();
    setStatus('New note');
    switchTab('editor');
    editorView?.focus();
  });

  document.getElementById('btn-save').addEventListener('click', () => saveToVault(false));

  document.getElementById('btn-sync').addEventListener('click', syncFromVault);

  // Conflict resolution
  document.getElementById('btn-conflict-keep-mine').addEventListener('click', () => {
    // User keeps their editor version — just dismiss the banner
    hideConflictBanner();
    setStatus('Kept your version');
    showToast('Kept your editor version');
  });
  document.getElementById('btn-conflict-keep-vault').addEventListener('click', async () => {
    if (!conflictVaultContent) return;
    loadMarkdown(conflictVaultContent);
    hideConflictBanner();
    setStatus('Loaded vault version');
    showToast('Loaded vault version into editor');
  });

  document.getElementById('btn-discard').addEventListener('click', () => {
    currentFilePath = null;
    tags = [];
    renderTags();
    document.getElementById('note-title').value = '';
    loadMarkdown('');
    document.getElementById('btn-discard').style.display = 'none';
    document.getElementById('btn-open-obsidian').disabled = true;
    document.getElementById('btn-sync').disabled = true;
    hideConflictBanner();
    setStatus('Discarded');
  });

  document.getElementById('btn-open-obsidian').addEventListener('click', () => {
    if (currentFilePath) openInObsidian(currentFilePath);
  });

  const tagInput = document.getElementById('fm-tag-input');
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(tagInput.value);
      tagInput.value = '';
    }
  });

  document.getElementById('btn-screenshot').addEventListener('click', () => captureScreenshot('area'));
  document.getElementById('btn-suggest-tags').addEventListener('click', suggestTags);
  document.getElementById('btn-find-relevant').addEventListener('click', findRelevantNotes);
  document.getElementById('btn-refresh-recent').addEventListener('click', loadRecentNotes);
  document.getElementById('btn-search').addEventListener('click', runSearch);
  document.getElementById('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch();
  });

  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-test-connection').addEventListener('click', testVaultConnection);
  document.getElementById('btn-test-llm').addEventListener('click', testLLMConnection);
  document.getElementById('cfg-llm-provider').addEventListener('change', (e) => {
    toggleCustomEndpoint(e.target.value);
  });
}

// ── Messaging helpers ────────────────────────────────────────────────────────
function sendToBackground(action, payload) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.runtime) {
      reject(new Error('Chrome extension runtime not available'));
      return;
    }
    chrome.runtime.sendMessage({ action, ...payload }, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

async function vaultRequest(method, path, body = null, headers = {}) {
  const result = await sendToBackground('vault:request', {
    payload: { method, path, body, headers },
  });
  if (result?.error) throw new Error(result.error);
  return result;
}

// ── Storage helpers ──────────────────────────────────────────────────────────
function loadSettings() {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage) {
      resolve({});
      return;
    }
    chrome.storage.local.get('settings', (data) => resolve(data.settings || {}));
  });
}

// ── Markdown ↔ HTML ──────────────────────────────────────────────────────────
function markdownToHTML(md) {
  return md
    .replace(/^---\n([\s\S]*?)\n---\n?/, (_, fm) =>
      `<pre><code class="frontmatter">${escapeHTML(fm)}</code></pre>\n`)
    .replace(/^#{6}\s(.+)$/gm, '<h6>$1</h6>')
    .replace(/^#{5}\s(.+)$/gm, '<h5>$1</h5>')
    .replace(/^#{4}\s(.+)$/gm, '<h4>$1</h4>')
    .replace(/^#{3}\s(.+)$/gm, '<h3>$1</h3>')
    .replace(/^#{2}\s(.+)$/gm, '<h2>$1</h2>')
    .replace(/^#{1}\s(.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^[-*]\s(.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
    .replace(/^>\s(.+)$/gm, '<blockquote><p>$1</p></blockquote>')
    .replace(/^---$/gm, '<hr>')
    .replace(/\n\n+/g, '</p><p>')
    .replace(/^(?!<[a-z])(.+)$/gm, (m) => m ? `<p>${m}</p>` : '');
}

function htmlToMarkdown(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('script, style').forEach((el) => el.remove());
  return nodeToMd(div).replace(/\n{3,}/g, '\n\n').trim();
}

function nodeToMd(node) {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType !== 1) return '';
  const tag = node.tagName.toLowerCase();
  const kids = () => Array.from(node.childNodes).map(nodeToMd).join('');
  switch (tag) {
    case 'h1': return `\n# ${kids()}\n`;
    case 'h2': return `\n## ${kids()}\n`;
    case 'h3': return `\n### ${kids()}\n`;
    case 'h4': return `\n#### ${kids()}\n`;
    case 'h5': return `\n##### ${kids()}\n`;
    case 'h6': return `\n###### ${kids()}\n`;
    case 'p': return `\n${kids()}\n`;
    case 'br': return '\n';
    case 'hr': return '\n---\n';
    case 'strong': case 'b': return `**${kids()}**`;
    case 'em': case 'i': return `*${kids()}*`;
    case 'code': return `\`${kids()}\``;
    case 'pre': return `\n\`\`\`\n${node.textContent.trim()}\n\`\`\`\n`;
    case 'blockquote': return `\n> ${kids().trim().split('\n').join('\n> ')}\n`;
    case 'a': { const href = node.getAttribute('href') || ''; return href ? `[${kids()}](${href})` : kids(); }
    case 'ul': return '\n' + Array.from(node.children).map((li) => `- ${nodeToMd(li).trim()}`).join('\n') + '\n';
    case 'ol': return '\n' + Array.from(node.children).map((li, i) => `${i + 1}. ${nodeToMd(li).trim()}`).join('\n') + '\n';
    case 'li': return kids();
    case 'script': case 'style': return '';
    default: return kids();
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────
function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 100);
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function setStatus(msg) {
  const el = document.getElementById('save-status');
  if (el) el.textContent = msg;
}

let toastTimer = null;
function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.style.background = type === 'error' ? '#dc2626' : '#1f2328';
  el.className = 'toast';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast hidden'; }, 3000);
}
