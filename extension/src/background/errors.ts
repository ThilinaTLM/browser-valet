// Errors the agent should see verbatim, with an optional stable machine code for `--json`.

/** Stable codes in `--json` errors (`code`); the table is in automation.md. */
export type ErrorCode =
  | 'unknown_command'
  | 'bad_args'
  | 'unknown_ref'
  | 'stale_ref'
  | 'not_found'
  | 'not_visible'
  | 'disabled'
  | 'covered'
  | 'timeout'
  | 'dialog_open'
  | 'no_tab'
  | 'tab_gone'
  | 'not_shared'
  | 'denied'
  | 'revoked';

/** A failure with a message written for the agent (shown without a stack, no "Error:" prefix). */
export class UserError extends Error {
  readonly code: ErrorCode | undefined;

  constructor(message: string, code?: ErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}
