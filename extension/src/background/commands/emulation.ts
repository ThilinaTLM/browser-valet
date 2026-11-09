// `pdf` (read-only) and `set viewport` / `set media` (agent tabs only). See automation.md.
//
// Emulation lives in the tab's debugger session: it persists across navigations while attached and
// ends on detach (close, revoke, the user closing the debugging bar), so nothing is tracked here.
// It never touches the profile.

import * as cdp from '../cdp';
import type { Command, Ctx } from '../command';
import { UserError } from '../dom';
import { meta, state } from '../state';

/** Overrides change what the user sees, so only tabs the agent opened qualify. */
async function agentTab(ctx: Ctx, what: string): Promise<number> {
  const id = await ctx.tab();
  if (state.tabs[id]?.control !== 'agent') {
    throw new UserError(
      `${what} is only allowed on tabs the agent opened; ${meta(id).tid} is the user's shared tab (the user would see their page change). Run \`bvl open <url>\` for an agent tab.`,
    );
  }
  return id;
}

function positive(v: string | undefined, what: string, usage: string): number {
  const n = Number(v);
  if (v === undefined || !Number.isFinite(n) || n <= 0)
    throw new UserError(`${what}\n${usage}`, 'bad_args');
  return n;
}

const VIEWPORT_USAGE = 'Usage: bvl set viewport <width> <height> [scale] | set viewport reset';
const MEDIA_USAGE = 'Usage: bvl set media [dark|light] [reduced-motion] | set media reset';

async function setViewport(ctx: Ctx, rest: string[]) {
  const id = await agentTab(ctx, 'set viewport');
  if (rest[0] === 'reset') {
    await cdp.send(id, 'Emulation.clearDeviceMetricsOverride');
    return { text: '✓ Done', data: { reset: true } };
  }
  if (rest.length < 2)
    throw new UserError(`Missing arguments for: set viewport\n${VIEWPORT_USAGE}`, 'bad_args');
  const width = Math.round(positive(rest[0], 'Width must be a positive number', VIEWPORT_USAGE));
  const height = Math.round(positive(rest[1], 'Height must be a positive number', VIEWPORT_USAGE));
  const deviceScaleFactor =
    rest[2] === undefined
      ? 1
      : positive(rest[2], 'Scale must be a positive number', VIEWPORT_USAGE);
  await cdp.send(id, 'Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor,
    mobile: false,
  });
  return { text: '✓ Done', data: { width, height, deviceScaleFactor, mobile: false } };
}

async function setMedia(ctx: Ctx, rest: string[]) {
  const id = await agentTab(ctx, 'set media');
  if (rest.length === 1 && rest[0] === 'reset') {
    await cdp.send(id, 'Emulation.setEmulatedMedia', { media: '', features: [] });
    return { text: '✓ Done', data: { reset: true } };
  }
  const features: { name: string; value: string }[] = [];
  let colorScheme: string | undefined;
  let reducedMotion = false;
  for (const w of rest) {
    if (w === 'dark' || w === 'light') colorScheme = w;
    else if (w === 'reduced-motion') reducedMotion = true;
    else throw new UserError(`Unknown media option: ${w}\n${MEDIA_USAGE}`, 'bad_args');
  }
  if (colorScheme === undefined && !reducedMotion) throw new UserError(MEDIA_USAGE, 'bad_args');
  if (colorScheme) features.push({ name: 'prefers-color-scheme', value: colorScheme });
  if (reducedMotion) features.push({ name: 'prefers-reduced-motion', value: 'reduce' });
  await cdp.send(id, 'Emulation.setEmulatedMedia', { features });
  return { text: '✓ Done', data: { set: true, colorScheme: colorScheme ?? null, reducedMotion } };
}

const NOT_SUPPORTED = ['device', 'geo', 'geolocation', 'offline', 'headers', 'credentials', 'auth'];

export const emulationCommands: Command[] = [
  {
    name: 'pdf',
    show: Infinity,
    group: 'Reading',
    usage: 'pdf <path> [--landscape] [--background]',
    summary: 'Save the page as a PDF (read-only; works on shared tabs too)',
    flags: [
      { name: 'landscape', type: 'bool', desc: 'Landscape orientation' },
      { name: 'background', type: 'bool', desc: 'Print background graphics and colors' },
    ],
    async run(ctx, a) {
      const id = await ctx.tab();
      const path = ctx.path(a.need(0, 'path. Usage: bvl pdf <path> [--landscape] [--background]'));
      let data: string;
      try {
        ({ data } = await cdp.send<{ data: string }>(id, 'Page.printToPDF', {
          landscape: a.has('landscape'),
          printBackground: a.has('background'),
        }));
      } catch (e) {
        throw new UserError(
          `Chrome could not print this page to PDF: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      ctx.files.push({ path, base64: data });
      return { text: `✓ PDF saved to ${path}`, data: { path } };
    },
  },
  {
    name: 'set',
    show: Infinity,
    group: 'Debugging',
    usage:
      'set viewport <w> <h> [scale] | set viewport reset | set media [dark|light] [reduced-motion] | set media reset',
    summary: 'Emulate viewport size or color scheme on agent tabs (cleared on close)',
    async run(ctx, a) {
      const [sub, ...rest] = a.pos;
      if (sub === 'viewport') return setViewport(ctx, rest);
      if (sub === 'media') return setMedia(ctx, rest);
      if (sub === undefined) {
        throw new UserError(
          'Missing arguments for: set\nUsage: bvl set <viewport|media> [args...]',
          'bad_args',
        );
      }
      if (NOT_SUPPORTED.includes(sub)) {
        throw new UserError(
          `set ${sub} is not supported: it would change what servers see in the user's logged-in browser. Only \`set viewport\` and \`set media\` exist, on agent tabs.`,
          'bad_args',
        );
      }
      throw new UserError(`Unknown subcommand: ${sub}\nValid options: viewport, media`, 'bad_args');
    },
  },
];
