Here's a full implementation plan broken into architecture, features, and phased milestones.

## 1. Core Architecture

**Extension type**: Manifest V3 Chrome extension with a side panel (using the `sidePanel` API rather than a popup, since you want persistent sidebar behavior).

**Key components:**

- `manifest.json` — permissions: `sidePanel`, `storage`, `activeTab`, `scripting`, `contextMenus`, plus host permissions for `http://127.0.0.1:*` (local Obsidian REST API) and your chosen LLM endpoints.
- `background.js` (service worker) — handles context menus, message routing between content script and sidebar, and any fetch calls that need to bypass CORS restrictions.
- `content.js` — injected into pages to extract page content/selection text and metadata (title, URL, favicon).
- `sidebar/` — the side panel UI (HTML/CSS/JS or a small React/Vite build), containing the ProseMirror editor, settings panel, and note list.
- `lib/obsidian-client.js` — wrapper for talking to the vault.
- `lib/llm-client.js` — wrapper for talking to LLM providers.

**Vault connection approach**: Obsidian doesn't expose a native HTTP API, so you have two realistic options:

1. **Local REST API plugin** (community plugin "Local REST API" or "Obsidian Local REST API") — the extension calls `https://127.0.0.1:27124` with an API key the user pastes into your settings. This gives you read/write/search of vault files and is the most reliable path.
2. **File System Access API** — Chrome lets a user grant a directory handle to read/write files directly, no Obsidian plugin needed, but it only works while the tab/extension page is open and the user grants permission once per session profile.

Recommendation: build on the **Local REST API plugin** as primary, since it also lets you trigger Obsidian to "open" a note (via `obsidian://` URI scheme) cleanly. Use File System Access as a fallback/offline mode if you want zero-dependency setup later.

## 2. Feature Breakdown

**Settings — Vault connection**

- Settings page (sidebar tab or `chrome://extensions` options page) with fields: Vault path/name, Local REST API base URL, API key, default folder for new notes, default note template.
- "Test connection" button that pings the REST API and confirms vault name back.
- Store credentials in `chrome.storage.local` (not synced, since API keys are local-machine-specific).

**Sidebar UI**

- Persistent side panel via `chrome.sidePanel.setOptions` / `setPanelBehavior({openPanelOnActionClick: true})`.
- Tabs or views: New Note, Recent Notes, Search Vault, Settings.
- A toolbar action to "Capture this page" and "Capture selection," both reachable from the sidebar and from a right-click context menu (`chrome.contextMenus.create` with `contexts: ['page', 'selection']`).

**Capturing content**

- `content.js` listens for a message from background/sidebar, then either grabs `window.getSelection().toString()` (with surrounding HTML for rich capture) or runs Readability.js (Mozilla's library) against the full page to get clean article text/markdown.
- Convert captured HTML to Markdown using Turndown.js before inserting into the editor, since Obsidian notes are markdown.
- Auto-populate frontmatter: source URL, capture date, page title.

**Opening/editing notes**

- "Open in Obsidian" button uses the `obsidian://open?vault=<name>&file=<path>` URI scheme, which Chrome will hand off to the desktop app via protocol handler.
- In-extension editing happens against the same file via the REST API's PUT/PATCH endpoints, so edits in the sidebar are saved straight to the vault file (single source of truth, no separate copies).

**ProseMirror editor**

- Use `prosemirror-view`, `prosemirror-state`, `prosemirror-schema-basic`, plus `prosemirror-markdown` for serializing/parsing so you can round-trip between ProseMirror's doc model and Obsidian's plain markdown files.
- Add a markdown-aware schema extension if you need Obsidian-specific syntax: wikilinks `[[note]]`, tags `#tag`, callouts, embeds — these need custom ProseMirror nodes/marks with their own parse/serialize rules, since the stock schema won't understand them.
- Autosave: debounce edits (e.g., 1–2s after typing stops) and PUT the serialized markdown back to the vault file.

**LLM integration settings**

- Settings fields per provider: provider dropdown (Gemini, DeepSeek, OpenAI-compatible, etc.), API key, model name, optional custom endpoint URL for self-hosted/OpenAI-compatible APIs.
- Abstract this behind a single `llm-client.js` interface (`generateTags(content)`, `summarize(content)`, etc.) with provider-specific adapters underneath, so adding a new provider later is just one new adapter file.
- Calls go through `background.js` (not the sidebar directly) so API keys aren't exposed to page-context scripts, and so you can centralize rate-limiting/error handling.

**Auto tag generation**

- On note save (or via a manual "Suggest tags" button), send note content (or a truncated/summarized version if long) to the configured LLM with a constrained prompt asking for N tags in a strict JSON array format.
- Parse the response, show suggested tags as removable chips in the UI before committing, then merge them into the note's YAML frontmatter `tags:` field.
- Cache recent suggestions per note to avoid redundant calls when the user re-opens an unchanged note.

## 3. Data Flow Summary

Page content → content script extracts/converts to markdown → sidebar shows draft in ProseMirror → user edits → on save, sidebar serializes ProseMirror doc to markdown → background script writes to vault via Local REST API → (optional) background script calls LLM for tags → tags merged into frontmatter → final PUT to vault.

## 4. Suggested Build Order

1. Scaffold MV3 extension with side panel showing a static placeholder.
2. Build settings UI and Local REST API connection test (this unblocks everything else).
3. Implement "capture full page" and "capture selection" via content script + Readability + Turndown, landing as plain text in the sidebar (no ProseMirror yet) and saving to vault — get the end-to-end pipe working first.
4. Swap the plain textarea for ProseMirror with markdown serialization; verify round-trip fidelity against real Obsidian files.
5. Add "Open in Obsidian" protocol handler and recent-notes/search list for editing existing notes.
6. Add LLM settings + provider adapters; wire up manual "Suggest tags" button.
7. Polish: autosave, error states (vault disconnected, API key invalid), loading states, and a simple onboarding flow for first-time setup (install REST API plugin → paste key → done).

## 5. Key Risks to Flag Early

- The Local REST API plugin requires the user to install and enable a community plugin and keep Obsidian running while capturing — this is a real adoption friction point worth explaining in onboarding.
- Custom Obsidian markdown syntax (wikilinks, callouts, embeds) in ProseMirror requires nontrivial custom schema work; budget real time here, it's usually the hardest part of this kind of project.
- LLM tag generation costs/latency add up if called automatically on every save; a manual trigger or debounce is safer than calling on every keystroke-driven autosave.

Want me to turn any single piece of this into something more concrete next, like the manifest.json/permissions list or the ProseMirror schema design for wikilinks and tags?
