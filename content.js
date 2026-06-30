// content.js — Injected into all pages
// Extracts full page content or the current selection, converts to markdown.
// Relies on Readability.js and Turndown.js being available via importScripts
// or injected by the background script. Here we bundle them as inlined copies
// by loading from web_accessible_resources at runtime, but for simplicity we
// implement lightweight extraction that covers 95% of cases without bundler.

(function () {
  // Guard against double-injection
  if (window.__obsidianClipperInjected) return;
  window.__obsidianClipperInjected = true;

  /**
   * Very small HTML→Markdown converter (no external deps required in content script).
   * For full fidelity, background.js can inject Turndown before calling extract.
   */
  function htmlToMarkdown(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    // Remove scripts and styles
    div.querySelectorAll('script, style, noscript').forEach((el) => el.remove());
    return nodeToMarkdown(div).trim();
  }

  function nodeToMarkdown(node, depth = 0) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent.replace(/\n{3,}/g, '\n\n');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();
    const children = () => Array.from(node.childNodes).map((c) => nodeToMarkdown(c, depth + 1)).join('');

    switch (tag) {
      case 'h1': return `\n# ${children()}\n`;
      case 'h2': return `\n## ${children()}\n`;
      case 'h3': return `\n### ${children()}\n`;
      case 'h4': return `\n#### ${children()}\n`;
      case 'h5': return `\n##### ${children()}\n`;
      case 'h6': return `\n###### ${children()}\n`;
      case 'p': return `\n${children()}\n`;
      case 'br': return '\n';
      case 'hr': return '\n---\n';
      case 'strong':
      case 'b': return `**${children()}**`;
      case 'em':
      case 'i': return `*${children()}*`;
      case 'code': return `\`${children()}\``;
      case 'pre': return `\n\`\`\`\n${node.textContent}\n\`\`\`\n`;
      case 'blockquote': return `\n> ${children().trim().split('\n').join('\n> ')}\n`;
      case 'a': {
        const href = node.getAttribute('href') || '';
        const text = children();
        return href ? `[${text}](${href})` : text;
      }
      case 'img': {
        const src = node.getAttribute('src') || '';
        const alt = node.getAttribute('alt') || 'image';
        return src ? `![${alt}](${src})` : '';
      }
      case 'ul':
        return '\n' + Array.from(node.children).map((li) => `- ${nodeToMarkdown(li, depth + 1).trim()}`).join('\n') + '\n';
      case 'ol':
        return '\n' + Array.from(node.children).map((li, i) => `${i + 1}. ${nodeToMarkdown(li, depth + 1).trim()}`).join('\n') + '\n';
      case 'li': return children();
      case 'table': {
        const rows = Array.from(node.querySelectorAll('tr'));
        if (!rows.length) return '';
        const toRow = (r) => '| ' + Array.from(r.querySelectorAll('th,td')).map((c) => c.textContent.trim()).join(' | ') + ' |';
        const header = toRow(rows[0]);
        const sep = '| ' + Array.from(rows[0].querySelectorAll('th,td')).map(() => '---').join(' | ') + ' |';
        const body = rows.slice(1).map(toRow).join('\n');
        return `\n${header}\n${sep}\n${body}\n`;
      }
      case 'script':
      case 'style':
      case 'noscript':
      case 'nav':
      case 'footer':
      case 'aside':
        return '';
      default:
        return children();
    }
  }

  /**
   * Extract the main article content using a Readability-like approach:
   * find the element with the highest text-density.
   */
  function extractMainContent() {
    // Try common article selectors first
    const selectors = ['article', 'main', '[role="main"]', '.post-content', '.article-body', '.entry-content', '#content'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 200) return el.innerHTML;
    }
    return document.body.innerHTML;
  }

  function getMetadata() {
    return {
      title: document.title,
      url: location.href,
      capturedAt: new Date().toISOString(),
      description: document.querySelector('meta[name="description"]')?.content || '',
    };
  }

  // ── Message listener ────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action !== 'extract') return;

    const meta = getMetadata();
    let markdown = '';

    if (message.type === 'selection') {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const fragment = sel.getRangeAt(0).cloneContents();
        const div = document.createElement('div');
        div.appendChild(fragment);
        markdown = htmlToMarkdown(div.innerHTML);
      }
    } else {
      markdown = htmlToMarkdown(extractMainContent());
    }

    sendResponse({ markdown, meta, type: message.type });
    return true;
  });
})();
