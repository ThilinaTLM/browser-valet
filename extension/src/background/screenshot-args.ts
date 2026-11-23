// `screenshot [selector] [path]`: with one positional, is it the path or the target? Matches
// agent-browser 0.41.2 (source and binary); see `looksLikePath` for the rule and our differences.
// Two positionals are always target, then path. A lone `//h1` XPath is a path (as upstream).

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const DRIVE = /^[a-z]:[\\/]/i;
// Characters that only a selector has: a value with a `/` and one of them is not a path.
const SELECTOR_CHARS = /[[\]()>="']/;

/**
 * agent-browser 0.41.2 (`cli/src/commands.rs`): a value starting with `.`, `#` or `@` (but not
 * `./`, `../`) is a target; else a path if it contains `/` or ends in `.png/.jpg/.jpeg/.webp`
 * (lowercase); else a target. Differences, all deliberate: the extension match ignores case
 * (`OUT.PNG`); a leading `/` or `\` or a drive path (`C:\x`) is a path (upstream: `C:\x` is a
 * target); a value with a `/` AND selector characters (`a[href="/x"]`, `div > a/b`) is a target.
 */
export function looksLikePath(s: string): boolean {
  if (/^\.{1,2}[\\/]/.test(s)) return true;
  if (/^[.#@]/.test(s)) return false; // `.shots/a.png` and `#a/b` are targets, as upstream
  if (IMAGE_EXT.test(s) || DRIVE.test(s) || /^[/\\]/.test(s)) return true;
  return s.includes('/') && !SELECTOR_CHARS.test(s);
}

export function splitScreenshotArgs(pos: string[]): { target?: string; path?: string } {
  const [first, second] = pos;
  if (first === undefined) return {};
  if (second !== undefined) return { target: first, path: second };
  return looksLikePath(first) ? { path: first } : { target: first };
}
