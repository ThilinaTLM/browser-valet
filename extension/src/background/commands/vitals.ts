import { Args, type Command } from '../command';
import { evaluateScoped, UserError } from '../dom';
import { compute, format, type RawVitals, vitalsScript } from '../vitals';
import { navigationCommands } from './navigation';

export const vitalsCommands: Command[] = [
  {
    name: 'vitals',
    details:
      'Prints Core Web Vitals (TTFB, FCP, LCP, CLS, INP) with good / needs-improvement / poor ratings, read from the page\'s buffered performance entries. Read-only. Given a URL it opens it in an agent tab first (like `open`), waits for load and a short settle. Agent tabs load in the background, where Chrome reports no LCP (and no FCP): those print as "not measurable (page loaded in a background tab)" and are null in --json (see `notMeasurable`). Measure in a shared tab the user has in front, or `tab show` it and reload. INP is approximate: Chrome buffers only interactions of 104 ms or more, so a fast page prints `inp: -`.',
    examples: ['bvl vitals', 'bvl vitals https://example.com --json'],
    show: Infinity,
    group: 'Debugging',
    usage: 'vitals [url]',
    summary: 'Core Web Vitals: LCP, CLS, INP, FCP, TTFB with ratings',
    async run(ctx, a) {
      const url = a.pos[0];
      if (url) {
        const open = navigationCommands.find((c) => c.name === 'open');
        await open?.run(ctx, new Args([url], new Map()));
        await new Promise((r) => setTimeout(r, 500));
      }
      const id = await ctx.tab();
      const r = await evaluateScoped(id, vitalsScript);
      const raw = r.value as RawVitals | undefined;
      if (!raw) throw new UserError('Could not read performance entries from the page');
      const v = compute(raw);
      return { text: format(v), data: v };
    },
  },
];
