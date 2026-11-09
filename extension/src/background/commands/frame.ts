// `frame`: scope later commands to an iframe (agent-browser's `frame`).

import { type Command, REDACTED } from '../command';
import { isRef, resolve } from '../dom';
import { UserError } from '../errors';
import { findFrame, hostedFrameId, setScope } from '../frames';
import { syncDocument } from '../refs';
import { state } from '../state';
import * as cdp from '../cdp';

const frame: Command = {
  name: 'frame',
  group: 'Interaction',
  usage: 'frame <selector|@ref|name|url|main>',
  summary:
    'Scope snapshot, selectors, get, eval and wait --fn to an iframe (main resets; navigation resets)',
  // Selectors, refs and names are targets like any other. A URL may carry a token.
  log: (a) => a.pos.slice(0, 1).map((p) => (p.includes('://') ? REDACTED : p)),
  async run(ctx, a) {
    const what = a.need(0, 'frame (selector, @ref, name, url or main)');
    const tabId = await ctx.tab();
    await syncDocument(tabId); // a new document clears the old scope
    if (what === 'main') {
      setScope(tabId, undefined);
      return { text: '✓ Done', data: { frame: 'main' } };
    }
    let picked: { frameId: string; name: string } | undefined;
    // 1. An element (ref, CSS or XPath) that is an iframe. Resolved from the main frame, so a
    //    nested selector needs the outer frame first.
    const previous = state.frames[tabId];
    setScope(tabId, undefined);
    let found = false;
    try {
      const h = await resolve(tabId, what);
      found = true;
      const frameId = await hostedFrameId(tabId, h.sessionId, { objectId: h.objectId });
      if (!frameId) {
        throw new UserError(`${what} is not an iframe`, 'bad_args');
      }
      const label = await cdp
        .send<{ result: { value?: string } }>(
          tabId,
          'Runtime.callFunctionOn',
          {
            objectId: h.objectId,
            functionDeclaration: 'function () { return this.name || this.title || this.id || ""; }',
            returnByValue: true,
          },
          h.sessionId,
        )
        .then((r) => r.result.value ?? '')
        .catch(() => '');
      picked = { frameId, name: label || frameId };
    } catch (e) {
      // Not an element: refs must be, names and URLs may follow.
      if (found || isRef(what)) {
        if (previous) setScope(tabId, previous);
        throw e;
      }
    }
    // 2. A frame by name or URL.
    picked ??= await findFrame(tabId, what);
    if (!picked) {
      if (previous) setScope(tabId, previous);
      throw new UserError(`Frame not found: ${what}`, 'not_found');
    }
    setScope(tabId, picked);
    return { text: '✓ Done', data: { frame: picked.name } };
  },
};

export const frameCommands: Command[] = [frame];
