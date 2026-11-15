// What `fill` expects of date-like inputs and how it judges the value read back afterwards.
// Pure, so the rules are unit-testable.

/** Input types whose value insertText cannot set: filled through the native value setter. */
export const SPECIAL_INPUT_TYPES = [
  'time',
  'date',
  'datetime-local',
  'month',
  'week',
  'color',
  'range',
] as const;

/** Value format per type, for error messages. */
export const FILL_FORMATS: Record<string, string> = {
  time: 'HH:MM',
  date: 'YYYY-MM-DD',
  'datetime-local': 'YYYY-MM-DDTHH:MM',
  month: 'YYYY-MM',
  week: 'YYYY-Www',
  color: '#rrggbb',
  range: 'a number within min and max',
  number: 'a number',
};

export interface FillProblem {
  /** true: the text did not land (error). false: it landed changed (warning). */
  fail: boolean;
  message: string;
}

/**
 * Compare the requested text with the value read back. Inputs may legitimately reformat (number
 * `1e3`, a range clamped to its bounds, a color lowercased, maxlength, masks): a changed but
 * non-empty value is only a warning. An empty value for non-empty text is a failure. Passwords
 * are never echoed.
 */
export function fillProblem(type: string, text: string, value: string): FillProblem | undefined {
  if (text === '') return undefined;
  const norm = (s: string) => s.replace(/\r\n?/g, '\n');
  if (norm(value) === norm(text)) return undefined;
  const lower = type === 'color';
  if (lower && value.toLowerCase() === text.toLowerCase()) return undefined;
  if ((type === 'number' || type === 'range') && value !== '' && Number(value) === Number(text)) {
    return undefined;
  }
  const secret = type === 'password';
  const shown = secret ? '(hidden)' : `"${value}"`;
  const format = FILL_FORMATS[type];
  const hint = format ? ` (input type=${type} expects ${format})` : '';
  if (value === '') {
    if (!format) {
      return {
        fail: true,
        message:
          'fill did not stick: value is "" (the page may have reset the field, e.g. while it was still loading; retry, or wait for the page first)',
      };
    }
    return { fail: true, message: `fill did not stick: value is ""${hint}` };
  }
  return {
    fail: false,
    message: `fill changed the text: the field now holds ${shown}${hint}`,
  };
}
