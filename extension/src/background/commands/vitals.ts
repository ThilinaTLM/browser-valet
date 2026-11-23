import * as cdp from '../cdp';
import { Args, type Command } from '../command';
import { UserError } from '../errors';
import { compute, format, type RawVitals, vitalsScript } from '../vitals';
import { navigationCommands } from './navigation';

interface EvalResult {
  result: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

/**
 * Runs the collector in an isolated world of the top frame: read-only, no page globals and no
 * page CSP involved, and independent of the `frame` scope.
 */
async function collect(tabId: number): Promise<RawVitals | undefined> {
  const tree = await cdp.send<{ frameTree: { frame: { id: string } } }>(tabId, 'Page.getFrameTree');
  const world = await cdp.send<{ executionContextId: number }>(tabId, 'Page.createIsolatedWorld', {
    frameId: tree.frameTree.frame.id,
    worldName: 'bvl-vitals',
  });
  const r = await cdp.send<EvalResult>(tabId, 'Runtime.evaluate', {
    expression: vitalsScript,
    contextId: world.executionContextId,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails)
    throw new UserError(
      r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'vitals failed',
    );
  return r.result.value as RawVitals | undefined;
}

export const vitalsCommands: Command[] = [
  {
    name: 'vitals',
    details:
      'Prints Core Web Vitals (TTFB, FCP, LCP, CLS, INP) with good / needs-improvement / poor ratings, read from the page\'s buffered performance entries. Read-only. Given a URL it opens it in an agent tab first (like `open`, including its warnings), waits for load and a short settle. Agent tabs load in the background, where Chrome reports no LCP (and no FCP): those print as "not measurable (page loaded in a background tab)" and are null in --json (see `notMeasurable`). For real LCP, measure a tab the user shared and has in front; do not bring tabs forward unless the user asks. INP only has interactions Chrome buffered (≥ 104 ms), so a fast page prints `inp: -`.',
    examples: ['bvl vitals', 'bvl vitals https://example.com --json'],
    show: Infinity,
    group: 'Debugging',
    usage: 'vitals [url]',
    summary: 'Core Web Vitals: LCP, CLS, INP, FCP, TTFB with ratings',
    async run(ctx, a) {
      const url = a.pos[0];
      let opened: { warning?: string | string[]; data?: unknown } | undefined;
      if (url) {
        // Same rules as `open <url>`: never navigates a tab the user shared.
        const open = navigationCommands.find((c) => c.name === 'open');
        opened = await open?.run(ctx, new Args([url], new Map()));
        await new Promise((r) => setTimeout(r, 500));
      }
      const id = await ctx.tab();
      const raw = await collect(id);
      if (!raw?.states) throw new UserError('Could not read performance entries from the page');
      const v = compute(raw);
      const nav = opened?.data as { loaded?: boolean; status?: number } | undefined;
      return {
        text: format(v),
        data: url
          ? { ...v, loaded: nav?.loaded ?? true, ...(nav?.status ? { status: nav.status } : {}) }
          : v,
        ...(opened?.warning ? { warning: opened.warning } : {}),
      };
    },
  },
];
