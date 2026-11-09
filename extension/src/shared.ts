// Types shared by the background worker and the popup.

/** A request from the CLI (see docs/architecture/protocol.md). */
export interface CliRequest {
  argv: string[];
  cwd: string;
  tmp: string;
  sep: string;
  platform: string;
  session: string;
  stdin?: string;
}

/** The response the CLI executes: write files, print stdout/stderr, exit. */
export interface CliResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
  files?: { path: string; base64: string }[];
}

export type ConnStatus = 'off' | 'waiting' | 'connected' | 'auth-failed';

export interface Connection {
  status: ConnStatus;
  /** Set once the CLI has successfully connected with the current secret. */
  paired: boolean;
  /** Secret and port come from `pairing.json` (installed by `bctl setup`). */
  managed?: boolean;
  /** Effective port (from pairing.json when managed). */
  port?: number;
}

export type Control = 'agent' | 'user';

export interface TabMeta {
  tid: string;
  label?: string;
  /** Present when the agent may control this tab: opened by the agent, or approved by the user. */
  control?: Control;
  /** Session that opened the tab (agent-owned tabs are closed by `bctl close`). */
  owner?: string;
}

export interface Approval {
  id: string;
  tabId: number;
  session: string;
  ts: number;
}

export interface LogEntry {
  ts: number;
  session: string;
  command: string;
  tid?: string;
  ok: boolean;
  error?: string;
}

export interface RefInfo {
  backendNodeId: number;
  role: string;
  name: string;
}

export interface State {
  nextTid: number;
  tabs: Record<number, TabMeta>;
  sessions: Record<string, { tab?: number }>;
  refs: Record<number, Record<string, RefInfo>>;
  approvals: Approval[];
  log: LogEntry[];
  conn: Connection;
}

export interface Settings {
  secret: string;
  port: number;
  enabled: boolean;
}

/** Shape of `pairing.json` in the managed extension folder. */
export interface Pairing {
  secret: string;
  port: number;
}

export const DEFAULT_PORT = 47823;

/** Messages from the popup to the background worker. */
export type PopupMessage =
  | { type: 'ping' }
  | { type: 'decide'; id: string; allow: boolean }
  | { type: 'share'; tabId: number }
  | { type: 'revoke'; tabId: number }
  | { type: 'revokeAll' }
  | { type: 'settings'; settings: Partial<Settings> }
  | { type: 'repair' };
