// Injected into the page by `read` (built to dist/read-extractor.js, an IIFE). Picks the main content
// and converts it to markdown. Vendors Mozilla Readability (Apache-2.0) and Turndown (MIT).

import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

const NOISE = 'script,style,noscript,template,svg,iframe,nav,aside,[hidden],[aria-hidden="true"]';
const MAIN = 'main, [role="main"], article';

function cell(n: Element): string {
  return n.textContent.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

function turndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  });
  // Link text only, URLs dropped (agent-browser does the same and it keeps prose short).
  td.addRule('linkText', { filter: 'a', replacement: (content) => content });
  // Tight list items: "- item" / "1. item" instead of Turndown's padded "-   item".
  td.addRule('listItem', {
    filter: 'li',
    replacement: (content, node) => {
      const parent = node.parentNode as HTMLElement;
      const body = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n/gm, '\n  ');
      let prefix = '- ';
      if (parent.nodeName === 'OL') {
        const start = parent.getAttribute('start');
        const index = [...parent.children].indexOf(node);
        prefix = `${(start ? Number(start) : 1) + index}. `;
      }
      return prefix + body.trimEnd() + (node.nextSibling ? '\n' : '');
    },
  });
  td.addRule('table', {
    filter: 'table',
    replacement: (_content, node) => {
      const rows = [...(node as HTMLTableElement).rows].map((r) => [...r.cells].map(cell));
      const [head, ...body] = rows;
      if (!head) return '';
      const line = (cols: string[]) => `| ${cols.join(' | ')} |`;
      return `\n\n${[line(head), line(head.map(() => '---')), ...body.map(line)].join('\n')}\n\n`;
    },
  });
  return td;
}

function mainContent(doc: Document): Element | undefined {
  // The largest main/article: pages often have several small <article> cards inside one <main>.
  let best: Element | undefined;
  let bestLen = 0;
  for (const el of doc.querySelectorAll(MAIN)) {
    const len = el.textContent.trim().length;
    if (len > bestLen) {
      best = el;
      bestLen = len;
    }
  }
  return best;
}

export function extract(): { markdown: string; title: string; url: string } {
  const doc = document.cloneNode(true) as Document;
  let root: Element | undefined = mainContent(doc);
  if (!root) {
    // No landmark: let Readability score the page, else fall back to the body.
    const article = new Readability(doc.cloneNode(true) as Document, {
      charThreshold: 100,
    }).parse();
    if (article?.content) {
      const holder = doc.createElement('div');
      holder.innerHTML = article.content;
      root = holder;
    } else {
      root = doc.body;
    }
  }
  root.querySelectorAll(NOISE).forEach((n) => {
    n.remove();
  });
  const markdown = turndown().turndown(root.innerHTML).trim();
  return { markdown, title: document.title, url: location.href };
}

(globalThis as unknown as { __bctlRead: typeof extract }).__bctlRead = extract;
