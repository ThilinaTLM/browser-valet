// Vitest globalSetup for the E2E suite: builds everything once, then starts the fixture server,
// a temp bctl config + proxy, and a Chrome (for Testing) with the managed extension loaded.
// Test files get the connection details through `inject('e2e')` (see harness.ts).

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import puppeteer, { type Browser, TargetType } from 'puppeteer-core';
import type { TestProject } from 'vitest/node';

export interface E2eInfo {
  /** Path of the bctl binary under test. */
  bin: string;
  /** Environment for every bctl subprocess (temp BCTL_CONFIG_DIR, non-default BCTL_PORT). */
  env: Record<string, string>;
  /** Browser WebSocket endpoint (connect with puppeteer). */
  wsEndpoint: string;
  /** chrome-extension://<id> of the loaded extension. */
  extensionOrigin: string;
  /** Base URL of the fixture server, no trailing slash. */
  fixtureUrl: string;
  /** Scratch directory used as the CLI's cwd. */
  workDir: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    e2e: E2eInfo;
  }
}

const extDir = resolve(import.meta.dirname, '../..');
const repoDir = resolve(extDir, '..');
const exe = process.platform === 'win32' ? 'bctl.exe' : 'bctl';

/** $CHROME_PATH, else the newest Chrome for Testing in puppeteer's cache. */
function findChrome(): string {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv) return fromEnv;
  const root = join(
    process.env.PUPPETEER_CACHE_DIR ?? join(homedir(), '.cache', 'puppeteer'),
    'chrome',
  );
  if (existsSync(root)) {
    const versions = readdirSync(root).sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true }),
    );
    for (const v of versions) {
      for (const rel of [
        'chrome-linux64/chrome',
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-win64/chrome.exe',
      ]) {
        const p = join(root, v, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  throw new Error(
    'No Chrome for Testing found. Set CHROME_PATH, or run `npx @puppeteer/browsers install chrome@stable`. ' +
      '(Branded Chrome 137+ ignores --load-extension, so it cannot be used.)',
  );
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createNetServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => {
        res(port);
      });
    });
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.txt': 'text/plain',
};

/** Dynamic JSON routes for network tests: /api/ok (200 + Set-Cookie), /api/missing (404), /api/boom (500). */
function serveApi(path: string, res: import('node:http').ServerResponse): void {
  const routes: Record<string, [number, unknown]> = {
    '/api/ok': [200, { message: 'hello', access_token: 'tok-SECRET-123', user: { id: 7 } }],
    '/api/missing': [404, { error: 'not found', detail: 'validation failed' }],
    '/api/boom': [500, { error: 'boom' }],
  };
  const [status, body] = routes[path] ?? [404, { error: 'no such route' }];
  res.writeHead(status, {
    'content-type': 'application/json',
    'set-cookie': 'sid=SESSIONSECRET; HttpOnly',
  });
  res.end(JSON.stringify(body));
}

/** Serves test/e2e/fixtures/ on 127.0.0.1. */
function serveFixtures(): Promise<{ server: Server; url: string }> {
  const root = join(import.meta.dirname, 'fixtures');
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path.startsWith('/api/')) {
      serveApi(path, res);
      return;
    }
    const file = join(root, normalize(path === '/' ? '/index.html' : path));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    readFile(file).then(
      (body) => {
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      },
      () => {
        res.writeHead(404).end('not found');
      },
    );
  });
  return new Promise((res) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      res({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // 1. Build: the CLI embeds extension/dist, so the extension goes first.
  let bin = process.env.BCTL_BIN;
  if (!bin) {
    if (!process.env.E2E_SKIP_BUILD) {
      execFileSync(process.execPath, ['build.mjs'], { cwd: extDir, stdio: 'inherit' });
      execFileSync('cargo', ['build'], { cwd: join(repoDir, 'cli'), stdio: 'inherit' });
    }
    const target = process.env.CARGO_TARGET_DIR ?? join(repoDir, 'cli', 'target');
    bin = join(target, 'debug', exe);
  }
  if (!existsSync(bin)) throw new Error(`bctl binary not found: ${bin}`);

  // 2. Isolated bctl: temp config dir, non-default port. Never the user's real ones.
  const tmp = await mkdtemp(join(tmpdir(), 'bctl-e2e-'));
  const configDir = join(tmp, 'config');
  const workDir = join(tmp, 'work');
  const profileDir = join(tmp, 'profile');
  await Promise.all([mkdir(configDir), mkdir(workDir), mkdir(profileDir)]);
  const port = await freePort();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    BCTL_CONFIG_DIR: configDir,
    BCTL_PORT: String(port),
    BCTL_IDLE_TIMEOUT: '0',
    BCTL_SESSION: 'e2e',
  };
  delete env.BCTL_EXT_WAIT_MS;

  // `setup` copies the folder path to the clipboard when a clipboard tool exists; run it with an
  // empty PATH so the test never touches the developer's clipboard.
  const emptyPath = join(tmp, 'empty-path');
  await mkdir(emptyPath);
  execFileSync(bin, ['setup', '--no-open', '--no-wait'], {
    env: { ...env, PATH: emptyPath },
    stdio: 'pipe',
  });
  const managedDir = join(configDir, 'extension');
  if (!existsSync(join(managedDir, 'manifest.json'))) throw new Error('setup wrote no extension');

  // 3. Chrome for Testing with the managed folder loaded.
  const fixtures = await serveFixtures();
  const headless = process.env.E2E_HEADFUL ? false : true;
  const browser: Browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless,
    userDataDir: profileDir,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--load-extension=${managedDir}`,
      `--disable-extensions-except=${managedDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(process.env.CI ? ['--no-sandbox'] : []),
    ],
  });

  const teardown = async () => {
    try {
      execFileSync(bin, ['stop'], { env, stdio: 'ignore' });
    } catch {
      // proxy already gone
    }
    await browser.close().catch(() => undefined);
    fixtures.server.close();
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    const sw = await browser.waitForTarget(
      (t) => t.type() === TargetType.SERVICE_WORKER && t.url().startsWith('chrome-extension://'),
      { timeout: 30_000 },
    );
    const extensionOrigin = /^chrome-extension:\/\/[^/]+/.exec(sw.url())?.[0] ?? '';

    // 4. Start the proxy (any bctl command does) and wait for the extension to connect.
    const deadline = Date.now() + 60_000;
    for (;;) {
      let out = '';
      try {
        out = execFileSync(bin, ['status', '--json'], { env, encoding: 'utf8' });
        if ((JSON.parse(out) as { ext?: unknown }).ext) break;
      } catch {
        // proxy still starting
      }
      if (Date.now() > deadline) throw new Error(`Extension did not connect. Last status:\n${out}`);
      await sleep(500);
    }

    project.provide('e2e', {
      bin,
      env,
      wsEndpoint: browser.wsEndpoint(),
      extensionOrigin,
      fixtureUrl: fixtures.url,
      workDir,
    });
  } catch (e) {
    await teardown();
    throw e;
  }
  return teardown;
}
