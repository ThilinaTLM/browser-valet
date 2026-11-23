// `a11y`: an axe-core accessibility audit. axe-core is a separate file in the extension package
// (`axe.min.js`, loaded on first use) and runs in an isolated world of every frame, so it shares
// the DOM but not the page's globals: nothing is added to `window`, a page's own `window.axe` is
// left alone, and the page's CSP does not apply. The per-frame partial results are merged in the
// main frame with `axe.finishRun`. See automation.md ("a11y").

import * as cdp from '../cdp';
import { Args, type Command } from '../command';
import { type EvalResult, UserError } from '../dom';
import { hostedFrameId } from '../frames';
import { mainFrame, syncDocument } from '../refs';
import { nodeKey, type NodeKey } from '../ref-table';
import { state } from '../state';
import {
  type A11yData,
  type A11yRule,
  type AxeReportRaw,
  type TargetPart,
  formatText,
  parseTags,
  shapeRules,
} from '../a11y-format';
import { navigationCommands } from './navigation';

let axeLoad: Promise<{ source: string; world: string }> | undefined;

/** The axe-core bundle, fetched from the extension package on first use. */
function axeSource(): Promise<{ source: string; world: string }> {
  axeLoad ??= fetch(chrome.runtime.getURL('axe.min.js'))
    .then(async (r) => {
      const source = await r.text();
      // The world name carries the version: a page keeps its isolated world (and the axe loaded
      // in it) across audits, and an updated extension must not meet an older axe there.
      const version = /axe v(\d+(?:\.\d+)*)/.exec(source)?.[1] ?? 'x';
      return { source, world: `bvl-a11y-${version}` };
    })
    .catch((e: unknown) => {
      axeLoad = undefined;
      throw e;
    });
  return axeLoad;
}

/** An isolated world of one frame with axe loaded. */
interface World {
  contextId: number;
  /** Session the frame lives in; undefined = the tab's own session. */
  sessionId?: string;
}

interface FrameRef {
  frameId: string;
  sessionId?: string;
}

interface PartialRun {
  partial: unknown;
  frames: { frameSelector: TargetPart; frameContext: unknown }[];
}

const MAX_DEPTH = 8;

function failure(r: EvalResult): string | undefined {
  const d = r.exceptionDetails;
  return d && (d.exception?.description ?? d.text ?? 'JavaScript exception');
}

async function evaluateIn(
  tabId: number,
  w: World,
  expression: string,
  byValue = true,
): Promise<EvalResult> {
  const r = await cdp.send<EvalResult>(
    tabId,
    'Runtime.evaluate',
    { expression, contextId: w.contextId, awaitPromise: true, returnByValue: byValue },
    w.sessionId,
  );
  const f = failure(r);
  if (f) throw new Error(f);
  return r;
}

async function makeWorld(tabId: number, frame: FrameRef): Promise<World> {
  const { source, world } = await axeSource();
  const { executionContextId } = await cdp.send<{ executionContextId: number }>(
    tabId,
    'Page.createIsolatedWorld',
    { frameId: frame.frameId, worldName: world },
    frame.sessionId,
  );
  const w: World = {
    contextId: executionContextId,
    ...(frame.sessionId ? { sessionId: frame.sessionId } : {}),
  };
  const has = await evaluateIn(tabId, w, "typeof axe !== 'undefined'");
  if (has.result.value !== true) await evaluateIn(tabId, w, `${source}\n;0`);
  return w;
}

/** The frame hosted by the `<iframe>` that `selector` (an axe selector path) names in `w`. */
async function childFrame(
  tabId: number,
  w: World,
  selector: TargetPart,
): Promise<string | undefined> {
  const path = Array.isArray(selector) ? selector : [selector];
  const r = await evaluateIn(tabId, w, `axe.utils.shadowSelect(${JSON.stringify(path)})`, false);
  const objectId = r.result.objectId;
  if (!objectId) return undefined;
  try {
    return await hostedFrameId(tabId, w.sessionId, { objectId });
  } finally {
    void cdp.send(tabId, 'Runtime.releaseObject', { objectId }, w.sessionId).catch(() => 0);
  }
}

/** Runs `axe.runPartial` in every frame, depth first, as `axe.finishRun` expects them. */
async function collect(
  tabId: number,
  top: FrameRef,
  context: unknown,
  options: unknown,
): Promise<{ partials: unknown[]; worlds: Map<string, World>; top: World }> {
  const partials: unknown[] = [];
  const worlds = new Map<string, World>();

  async function walk(frame: FrameRef, path: TargetPart[], ctx: unknown, depth: number) {
    let w: World;
    try {
      w = await makeWorld(tabId, frame);
    } catch (e) {
      if (path.length === 0) throw e;
      // An out-of-process iframe that was not reported yet: try its own session.
      const child = await cdp.sessionForFrame(tabId, frame.frameId, 1000);
      if (!child || child.sessionId === frame.sessionId) {
        partials.push(null);
        return;
      }
      try {
        w = await makeWorld(tabId, { frameId: frame.frameId, sessionId: child.sessionId });
      } catch {
        partials.push(null);
        return;
      }
    }
    worlds.set(JSON.stringify(path), w);
    let run: PartialRun;
    try {
      const r = await evaluateIn(
        tabId,
        w,
        `(async () => {
          const ctx = ${JSON.stringify(ctx ?? null)} ?? document;
          const opts = ${JSON.stringify(options)};
          const partial = await axe.runPartial(ctx, opts);
          const frames = axe.utils.getFrameContexts(ctx, opts);
          return JSON.stringify({ partial, frames });
        })()`,
      );
      run = JSON.parse(String(r.result.value)) as PartialRun;
    } catch (e) {
      if (path.length === 0) throw e;
      partials.push(null);
      return;
    }
    partials.push(run.partial);
    for (const f of run.frames) {
      let id: string | undefined;
      try {
        id = depth < MAX_DEPTH ? await childFrame(tabId, w, f.frameSelector) : undefined;
      } catch {
        id = undefined;
      }
      if (!id) {
        partials.push(null);
        continue;
      }
      const sid = cdp.childSessions(tabId).find((c) => c.targetId === id)?.sessionId ?? w.sessionId;
      await walk(
        { frameId: id, ...(sid ? { sessionId: sid } : {}) },
        [...path, f.frameSelector],
        f.frameContext,
        depth + 1,
      );
    }
  }

  await walk(top, [], context, 0);
  const topWorld = worlds.get('[]');
  if (!topWorld) throw new UserError('Could not audit the page');
  return { partials, worlds, top: topWorld };
}

/** Refs of the tab's last snapshot, by node. */
function knownRefs(tabId: number): Map<NodeKey, string> {
  const m = new Map<NodeKey, string>();
  for (const [ref, i] of Object.entries(state.refs[tabId] ?? {})) {
    m.set(nodeKey(i.backendNodeId, i.frameId), ref);
  }
  return m;
}

/** Add `ref` to the nodes that are in the last snapshot (best effort). */
async function addRefs(
  tabId: number,
  rules: A11yRule[],
  worlds: Map<string, World>,
): Promise<void> {
  const refs = knownRefs(tabId);
  if (!refs.size) return;
  for (const rule of rules) {
    for (const node of rule.nodes) {
      const last = node.target[node.target.length - 1];
      const w = worlds.get(JSON.stringify(node.target.slice(0, -1)));
      if (last === undefined || !w) continue;
      try {
        const r = await evaluateIn(
          tabId,
          w,
          `axe.utils.shadowSelect(${JSON.stringify(Array.isArray(last) ? last : [last])})`,
          false,
        );
        const objectId = r.result.objectId;
        if (!objectId) continue;
        const { node: n } = await cdp.send<{ node: { backendNodeId: number } }>(
          tabId,
          'DOM.describeNode',
          { objectId },
          w.sessionId,
        );
        void cdp.send(tabId, 'Runtime.releaseObject', { objectId }, w.sessionId).catch(() => 0);
        const frameId = w.sessionId ? cdp.childSession(tabId, w.sessionId)?.targetId : undefined;
        const ref = refs.get(nodeKey(n.backendNodeId, frameId));
        if (ref) node.ref = ref;
      } catch {
        // not mappable: the selector is still printed
      }
    }
  }
}

export const a11yCommands: Command[] = [
  {
    name: 'a11y',
    group: 'Reading',
    usage: 'a11y [url] [--tags <t1,t2>] [-s <selector>]',
    summary: 'Accessibility audit (axe-core): violations by impact with failing selectors',
    details:
      'Runs axe-core in every frame (iframes included) without touching the page: nothing is added to the page and its CSP does not matter. Prints violations by impact (critical first), with the rule, fix guidance URL and up to 5 failing selectors; `@eN` marks elements that are in your last snapshot. --json gives counts, violations and incomplete (rules that need a manual review) with up to 10 nodes each. Exit code is 0 even with violations. Given a URL it opens it in an agent tab first.',
    examples: [
      'bvl a11y',
      'bvl a11y --tags wcag2a,wcag2aa',
      'bvl a11y --selector "#main" --json',
      'bvl a11y https://example.com',
    ],
    flags: [
      {
        name: 'tags',
        type: 'string',
        desc: 'Only rules with these axe tags (e.g. wcag2a,wcag2aa,best-practice)',
      },
      { name: 'selector', short: 's', type: 'string', desc: 'Only audit this subtree (CSS)' },
    ],
    showFlags: ['tags', 'selector'],
    async run(ctx, a) {
      const url = a.pos[0];
      if (url) {
        // Same rules as `open <url>`: never navigates a tab the user shared.
        const open = navigationCommands.find((c) => c.name === 'open');
        await open?.run(ctx, new Args([url], new Map()));
      }
      const tabId = await ctx.tab();
      const selector = a.str('selector');
      const tags = parseTags(a.str('tags') ?? '');
      if (a.has('tags') && !tags.length) throw new UserError('--tags needs a value', 'bad_args');

      const { frameTree } = await cdp.send<{ frameTree: { frame: { id: string } } }>(
        tabId,
        'Page.getFrameTree',
      );
      const top: FrameRef = { frameId: frameTree.frame.id };
      const options = {
        resultTypes: ['violations', 'incomplete'],
        ...(tags.length ? { runOnly: { type: 'tag', values: tags } } : {}),
      };

      if (selector) {
        // Fail like upstream instead of auditing nothing.
        const w = await makeWorld(tabId, top);
        let found: unknown;
        try {
          found = (
            await evaluateIn(
              tabId,
              w,
              `document.querySelector(${JSON.stringify(selector)}) !== null`,
            )
          ).result.value;
        } catch {
          throw new UserError(`Invalid selector: ${selector}`, 'bad_args');
        }
        if (found !== true)
          throw new UserError(`No element matches selector: ${selector}`, 'not_found');
      }

      const run = await collect(
        tabId,
        top,
        selector ? { include: [selector] } : undefined,
        options,
      );
      const fin = await evaluateIn(
        tabId,
        run.top,
        `(async () => JSON.stringify({ version: axe.version, report: await axe.finishRun(${JSON.stringify(run.partials)}, ${JSON.stringify(options)}) }))()`,
      );
      const { version, report } = JSON.parse(String(fin.result.value)) as {
        version: string;
        report: AxeReportRaw;
      };

      const data: A11yData = {
        axeVersion: version,
        url: (await mainFrame(tabId))?.url ?? '',
        counts: {
          violations: report.violations?.length ?? 0,
          incomplete: report.incomplete?.length ?? 0,
          passes: report.passes?.length ?? 0,
          inapplicable: report.inapplicable?.length ?? 0,
        },
        violations: shapeRules(report.violations),
        incomplete: shapeRules(report.incomplete),
      };
      await syncDocument(tabId);
      await addRefs(tabId, [...data.violations, ...data.incomplete], run.worlds);
      return { text: formatText(data), data };
    },
  },
];
