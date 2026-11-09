import { Args, type Command } from '../command';
import { evaluate, UserError } from '../dom';
import { filterSections, outline } from '../read-format';
import { navigationCommands } from './navigation';

let extractor: Promise<string> | undefined;

/** The page-side extractor (Readability + Turndown) is a separate bundle, loaded on first use. */
function extractorSource(): Promise<string> {
  extractor ??= fetch(chrome.runtime.getURL('read-extractor.js'))
    .then((r) => r.text())
    .catch((e: unknown) => {
      extractor = undefined;
      throw e;
    });
  return extractor;
}

export const readCommands: Command[] = [
  {
    name: 'read',
    details:
      'Prints the page as markdown (main content only). Use --outline for headings, --filter to keep matching sections, --max-output to cap the size. Given a URL it opens it in an agent tab first.',
    examples: ['bvl read', 'bvl read --outline', 'bvl read https://example.com --filter pricing'],
    group: 'Reading',
    usage: 'read [url] [--outline] [--filter <text>] [--max-output <chars>]',
    summary:
      'Page text as markdown (main content only); --outline for headings, --filter for sections',
    flags: [
      { name: 'outline', type: 'bool', desc: 'Headings only, indented by level' },
      {
        name: 'filter',
        type: 'string',
        desc: 'Only sections containing the text (case-insensitive)',
      },
    ],
    async run(ctx, a) {
      const url = a.pos[0];
      if (url) {
        // Same rules as `open <url>`: never navigates a tab the user shared.
        const open = navigationCommands.find((c) => c.name === 'open');
        await open?.run(ctx, new Args([url], new Map()));
      }
      const id = await ctx.tab();
      const r = await evaluate(id, `${await extractorSource()}\n;__bvlRead()`);
      const page = r.value as { markdown: string; title: string; url: string } | undefined;
      if (!page) throw new UserError('Could not read the page');
      let text = page.markdown;
      let source = 'markdown';
      if (a.has('outline')) {
        text = outline(text, page.url);
        source = 'outline';
      } else if (a.str('filter')) {
        text = filterSections(text, a.str('filter') ?? '');
      }
      return {
        text,
        data: {
          content: text,
          url: page.url,
          title: page.title,
          mode: source,
        },
      };
    },
  },
];
