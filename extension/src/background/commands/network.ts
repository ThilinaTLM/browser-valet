// `network requests` / `network request <id>`: read-only inspection of the tab's traffic.
// Credentials are always redacted (see network.ts and security.md); there is no reveal flag.

import type { Command } from '../command';
import { UserError } from '../dom';
import * as net from '../network';

const HINT = 'Recording started; reload the page or repeat the action to capture requests.';

function entryJson(e: net.Entry, body?: net.Body): Record<string, unknown> {
  return {
    requestId: e.id,
    method: e.method,
    url: e.url,
    resourceType: e.type,
    status: e.status ?? null,
    statusText: e.statusText ?? null,
    mimeType: e.mimeType ?? null,
    failed: e.failed ?? null,
    durationMs: e.durationMs ?? null,
    size: e.size ?? null,
    headers: e.requestHeaders,
    responseHeaders: e.responseHeaders,
    postData: e.postData ?? null,
    ...(body
      ? { body: body.text ?? null, bodyNote: body.note ?? null, bodyTruncated: !!body.truncated }
      : {}),
  };
}

function headerBlock(h: Record<string, string>): string {
  const lines = Object.entries(h).map(([k, v]) => `  ${k}: ${v}`);
  return lines.length ? lines.join('\n') : '  (none)';
}

export const networkCommands: Command[] = [
  {
    name: 'network',
    group: 'Debugging',
    usage:
      'network requests [--filter <substr>] [--type <t,…>] [--method <m>] [--status <s>] [--clear]\nnetwork request <id>',
    summary: 'Inspect requests the page made (read-only; credentials are redacted)',
    // `network request <id>`: the id is not user text.
    show: 2,
    showFlags: ['type', 'method', 'status'],
    flags: [
      { name: 'filter', type: 'string', desc: 'Only URLs containing this text' },
      {
        name: 'type',
        type: 'string',
        desc: 'Resource types, comma-separated (xhr,fetch,document,…)',
      },
      { name: 'method', type: 'string', desc: 'HTTP method (GET, POST, …)' },
      { name: 'status', type: 'string', desc: 'Status: 200, 2xx or 400-499' },
      { name: 'clear', type: 'bool', desc: 'Clear the request log' },
    ],
    async run(ctx, a) {
      const tabId = await ctx.tab();
      const sub = a.pos[0];
      if (sub !== 'requests' && sub !== 'request') {
        throw new UserError('Usage: network requests [flags] | network request <id>');
      }
      const started = await net.startRecording(tabId);

      if (sub === 'request') {
        const id = a.need(1, 'request id (see `network requests`)');
        const e = net.getEntry(tabId, id);
        if (!e) {
          throw new UserError(`Request not found: ${id}${started ? ` (${HINT})` : ''}`);
        }
        const body = await net.responseBody(tabId, e);
        const parts = [
          net.line(e),
          `Time: ${e.durationMs === undefined ? 'n/a' : `${e.durationMs} ms`}   Size: ${e.size ?? 'n/a'} bytes   MIME: ${e.mimeType ?? 'n/a'}`,
          `Request headers:\n${headerBlock(e.requestHeaders)}`,
        ];
        if (e.postData !== undefined) parts.push(`Request body:\n${e.postData}`);
        parts.push(`Response headers:\n${headerBlock(e.responseHeaders)}`);
        parts.push(
          body.text !== undefined
            ? `Response body:\n${body.text}${body.truncated ? `\n… [truncated at ${net.MAX_BODY_CHARS} characters]` : ''}`
            : `Response body: (${body.note ?? 'empty'})`,
        );
        return { text: parts.join('\n\n'), data: entryJson(e, body) };
      }

      if (a.has('clear')) {
        net.clearLog(tabId);
        return {
          text: '✓ Request log cleared',
          data: { cleared: true, recordingStarted: started },
        };
      }
      const type = a.str('type');
      const status = a.str('status');
      let statusFn: ((s: number) => boolean) | undefined;
      try {
        if (status !== undefined) statusFn = net.parseStatus(status);
      } catch (e) {
        throw new UserError((e as Error).message, { cause: e });
      }
      const entries = net.list(tabId, {
        filter: a.str('filter'),
        types: type
          ?.split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
        method: a.str('method'),
        status: statusFn,
      });
      const lines = entries.map(net.line);
      if (started) lines.push(HINT);
      else if (!lines.length) lines.push('No requests captured');
      return {
        text: lines.join('\n'),
        data: { recordingStarted: started, requests: entries.map((e) => entryJson(e)) },
      };
    },
  },
];
