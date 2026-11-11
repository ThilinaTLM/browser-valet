// The on/off switch follows the proxy: an authenticated connection that ends without an announced
// restart switches the extension off (see runtime.md, "The on/off switch").
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChromeMock, installChromeMock } from '../helpers/chrome-mock';

const SECRET = 'test-secret';

class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket | undefined;
  readyState = FakeSocket.OPEN;
  sent: Record<string, unknown>[] = [];
  onmessage?: (ev: { data: string }) => Promise<void> | void;
  onclose?: () => void;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  async receive(msg: unknown) {
    await this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

let mock: ChromeMock;
let conn: typeof import('../../src/background/connection');
let st: typeof import('../../src/background/state');

const mac = (m: string) => createHmac('sha256', SECRET).update(m).digest('hex');

/** Connect and complete the handshake as the proxy would. */
async function connected(): Promise<FakeSocket> {
  FakeSocket.last = undefined;
  conn.connect();
  await vi.waitFor(() => {
    expect(FakeSocket.last).toBeDefined();
  });
  const sock = FakeSocket.last as unknown as FakeSocket;
  await sock.receive({ t: 'challenge', nonce: 'np' });
  const nc = String(sock.sent[0]?.nonce);
  await sock.receive({ t: 'welcome', mac: mac(`bctl1|server|ext|${nc}|np`) });
  expect(st.state.conn.status).toBe('connected');
  return sock;
}

beforeEach(async () => {
  vi.resetModules();
  FakeSocket.last = undefined;
  mock = installChromeMock();
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('no pairing.json'))),
  );
  mock.local.data = { secret: SECRET, enabled: true };
  mock.session.data.state = { nextTid: 1 }; // not a fresh browser start: the switch stays on
  st = await import('../../src/background/state');
  conn = await import('../../src/background/connection');
  await st.loadState();
  expect(st.settings.enabled).toBe(true);
});

afterEach(() => {
  conn.disconnect();
  vi.unstubAllGlobals();
});

const switchedOff = async () => {
  await vi.waitFor(() => {
    expect(mock.local.data.enabled).toBe(false);
  });
  expect(st.settings.enabled).toBe(false);
  expect(st.state.conn.status).toBe('off');
};

describe('auto-off', () => {
  it.each([
    ['idle', 'idle'],
    ['stop', 'stopped'],
  ])('switches off after bye %s', async (reason, offReason) => {
    const sock = await connected();
    await sock.receive({ t: 'bye', reason });
    sock.close();
    await switchedOff();
    expect(st.state.conn.offReason).toBe(offReason);
    await vi.waitFor(() => {
      expect(mock.chrome.action.setIcon).toHaveBeenLastCalledWith({
        path: { 16: 'icons/icon-off-16.png', 32: 'icons/icon-off-32.png' },
      });
    });
  });

  it('switches off when the connection is lost without a bye', async () => {
    const sock = await connected();
    sock.close();
    await switchedOff();
    expect(st.state.conn.offReason).toBe('lost');
  });

  it('revokes every grant when it switches off', async () => {
    st.meta(5).control = 'user';
    const sock = await connected();
    sock.close();
    await switchedOff();
    await vi.waitFor(() => {
      expect(st.state.tabs[5]?.control).toBeUndefined();
    });
  });

  it('stays on after an announced restart', async () => {
    const sock = await connected();
    await sock.receive({ t: 'bye', reason: 'restart' });
    sock.close();
    await mock.flush();
    expect(st.settings.enabled).toBe(true);
    expect(st.state.conn.status).toBe('waiting');
  });

  it('stays on when the extension closes the connection itself', async () => {
    await connected();
    conn.disconnect();
    await mock.flush();
    expect(st.settings.enabled).toBe(true);
  });

  it('stays on when the handshake never completed (proxy not reached or auth failed)', async () => {
    conn.connect();
    await vi.waitFor(() => {
      expect(FakeSocket.last).toBeDefined();
    });
    const sock = FakeSocket.last as unknown as FakeSocket;
    await sock.receive({ t: 'error', error: 'authentication failed' });
    sock.close();
    await mock.flush();
    expect(st.settings.enabled).toBe(true);
    expect(st.state.conn.status).toBe('auth-failed');
  });

  it('ignores a bye before authentication', async () => {
    conn.connect();
    await vi.waitFor(() => {
      expect(FakeSocket.last).toBeDefined();
    });
    const sock = FakeSocket.last as unknown as FakeSocket;
    await sock.receive({ t: 'bye', reason: 'restart' });
    sock.close();
    await mock.flush();
    expect(st.settings.enabled).toBe(true);
    expect(st.state.conn.status).toBe('waiting');
  });
});
