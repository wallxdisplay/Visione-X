import i18n, { currentLocale } from '../i18n';

// Formatters per UI language (dates follow the language the user chose).
const formatters = new Map<string, { dateTime: Intl.DateTimeFormat; dateOnly: Intl.DateTimeFormat }>();
function fmt() {
  const locale = currentLocale();
  let f = formatters.get(locale);
  if (!f) {
    f = {
      dateTime: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
      dateOnly: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }),
    };
    formatters.set(locale, f);
  }
  return f;
}

export const formatDateTime = (ms: number | null | undefined) => (ms ? fmt().dateTime.format(ms) : '—');
export const formatDate = (ms: number | null | undefined) => (ms ? fmt().dateOnly.format(ms) : '—');

export function daysLeft(until: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((until - now) / 86_400_000));
}

/** IANA zones supported by the browser; Asia/Kolkata first. */
export function timezoneOptions() {
  const zones: string[] =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['Asia/Kolkata', 'UTC'];
  const ordered = ['Asia/Kolkata', ...zones.filter((z) => z !== 'Asia/Kolkata')];
  return ordered.map((z) => ({ value: z, label: z.replace(/_/g, ' ') }));
}

export function roleLabel(role: string) {
  return i18n.t(`roles.${role}`, { defaultValue: role });
}

/** Extracts zod-style field errors from an `invalid-argument` callable error or a local parse. */
export function fieldErrors(issues: { path: (string | number)[]; message: string }[]) {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.join('.');
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
