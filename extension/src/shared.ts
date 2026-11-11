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

/** Why the extension switched itself off (absent: off by default, or by the user). */
export type OffReason = 'idle' | 'stopped' | 'lost';

export interface Connection {
  status: ConnStatus;
  /** Set once the CLI has successfully connected with the current secret. */
  paired: boolean;
  /** Secret and port come from `pairing.json` (installed by `bvl setup`). */
  managed?: boolean;
  /** Effective port (from pairing.json when managed). */
  port?: number;
  /** Set when the extension switched itself off because bvl went away; cleared on switch-on. */
  offReason?: OffReason;
}

export type Control = 'agent' | 'user';

export interface TabMeta {
  tid: string;
  label?: string;
  /** Present when the agent may control this tab: opened by the agent, or approved by the user. */
  control?: Control;
  /** Session that opened the tab (agent-owned tabs are closed by `bvl close`). */
  owner?: string;
}

/** What a confirmation card asks about (absent on a plain tab-control request). */
export interface ApprovalAction {
  category: ConfirmCategory;
  /** The command as the activity log shows it (arguments redacted). */
  command: string;
  /** For `navigate-new-site`: the host the agent wants to reach. */
  site?: string;
}

export interface Approval {
  id: string;
  tabId: number;
  session: string;
  ts: number;
  action?: ApprovalAction;
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
  /** Child (out-of-process iframe) session the node lives in; absent for the tab's own session. */
  sessionId?: string;
  /** Target (frame) id of that out-of-process iframe. Stable across session re-creation. */
  frameId?: string;
}

/** An out-of-process iframe reached through `Target.setAutoAttach` (flatten). */
export interface ChildSession {
  sessionId: string;
  /** Equals the id of the iframe's top frame. */
  targetId: string;
  /** Session that owns the iframe element; absent when it is the tab's own session. */
  parent?: string;
  url: string;
}

export interface State {
  nextTid: number;
  tabs: Record<number, TabMeta>;
  sessions: Record<string, { tab?: number; nextRef?: number; sites?: string[] }>;
  /** Refs of the tab's current document (cleared on cross-document navigation). */
  refs: Record<number, Record<string, RefInfo>>;
  /** Loader id of the main-frame document the tab's refs belong to. */
  refDocs: Record<number, string>;
  /** Out-of-process iframe sessions per controlled tab (valid while the debugger stays attached). */
  childSessions: Record<number, ChildSession[]>;
  /** Frame the `frame` command scoped the tab to (absent: main frame). */
  frames: Record<number, { frameId: string; name: string }>;
  approvals: Approval[];
  log: LogEntry[];
  conn: Connection;
}

export interface Settings {
  secret: string;
  port: number;
  /** The popup's on/off switch. Off by default and after every browser start. */
  enabled: boolean;
}

/** Shape of `pairing.json` in the managed extension folder. */
export interface Pairing {
  secret: string;
  port: number;
}

export const DEFAULT_PORT = 47823;

/** Actions that can need a click on Allow each time they run (see guardrails.ts). */
export const CONFIRM_CATEGORIES = ['eval', 'upload', 'navigate-new-site'] as const;
export type ConfirmCategory = (typeof CONFIRM_CATEGORIES)[number];

/** The user's binding policy for agents (popup → `chrome.storage.local` key `guardrails`). */
export interface Guardrails {
  /** Default output limit in characters; 0 = no limit. An agent's `--max-output` overrides it. */
  maxOutput: number;
  /** Wrap page-derived output in nonce markers on every command ("always"). */
  contentBoundaries: boolean;
  /** Domain patterns agent navigation may reach; empty = unrestricted. See guardrails.ts. */
  allowedDomains: string[];
  /** Action categories that need a click on Allow every time they run. */
  confirm: ConfirmCategory[];
}

/** Messages from the popup to the background worker. */
export type PopupMessage =
  | { type: 'ping' }
  | { type: 'decide'; id: string; allow: boolean }
  | { type: 'share'; tabId: number }
  | { type: 'revoke'; tabId: number }
  | { type: 'revokeAll' }
  | { type: 'settings'; settings: Partial<Settings> }
  | { type: 'guardrails'; guardrails: Partial<Guardrails> }
  | { type: 'repair' };
