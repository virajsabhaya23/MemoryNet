import { ValidationError } from "./errors.ts";

/** Labels on sources and proposals that point reviewers to content needing a closer look. */
export const CONTENT_FLAGS = [
  "secret_removed",
  "personal_data",
  "truncated",
] as const;
export type ContentFlag = (typeof CONTENT_FLAGS)[number];

/** Stands in for each likely secret removed from automatically captured text. */
export const SECRET_PLACEHOLDER = "[secret removed]";

// Generic formats only: provider token formats wait for owner-approved references.
// Quantifiers are bounded so long input stays fast. Group 1 is kept when a secret is removed.
const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  {
    label: "private key",
    pattern:
      /()-----BEGIN [A-Z\d ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z\d ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  {
    label: "web token",
    pattern: /()\beyJ[\w-]{8,4096}\.eyJ[\w-]{8,4096}\.[\w-]{8,4096}/g,
  },
  { label: "bearer token", pattern: /\b(Bearer\s{1,5})[\w.~+/-]{16,4096}=*/g },
  {
    label: "password in a link",
    pattern:
      /\b([a-z][a-z\d+.-]{0,30}:\/\/)[^\s/:@]{1,256}:[^\s/@]{1,256}(?=@)/gi,
  },
  {
    label: "password or key",
    pattern:
      /(?<![\w.-])([\w.-]{0,40}?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[\w.-]{0,40}["']?\s{0,5}[:=]\s{0,5}["']?)(?![$<{%*])(?=[^\s"'`,;]{0,512}?\d)(?=[^\s"'`,;]{0,512}?[a-z])[^\s"'`,;]{8,512}/gi,
  },
];

// Email addresses, phone numbers, the US social security number format, and labeled health
// record identifiers. Names and free-text clinical details cannot be recognized this way.
const PERSONAL_DATA_PATTERNS: readonly RegExp[] = [
  /(?<![\w.%+-])[\w.%+-]{1,64}@[a-z\d-]{1,63}(?:\.[a-z\d-]{1,63}){0,8}\.[a-z]{2,24}(?![\w-])/i,
  /(?<![\d.])(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}(?![\d.])/,
  /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/,
  /\b(?:MRN|medical record(?: number| no\.?)?|patient (?:id|identifier|number)|date of birth|DOB)\s{0,3}[:#=]\s{0,3}\S{0,20}?\d/i,
];

/** Kinds of likely secrets in the text, such as "private key". Never the values. */
export function findSecrets(text: string): string[] {
  return SECRET_PATTERNS.filter(
    ({ pattern }) => text.search(pattern) !== -1,
  ).map(({ label }) => label);
}

/** Refuses typed-in text that looks like it holds a secret, so the secret is never stored. */
export function requireNoSecrets(text: string, field: string): void {
  const kinds = findSecrets(text);
  if (kinds.length > 0) {
    throw new ValidationError(
      `${field} looks like it contains a secret (${kinds.join(", ")}); remove it and try again`,
    );
  }
}

/** Replaces each likely secret with SECRET_PLACEHOLDER, keeping labels such as "password=". */
export function removeSecrets(text: string): {
  text: string;
  removed: boolean;
} {
  let result = text;
  for (const { pattern } of SECRET_PATTERNS) {
    result = result.replace(pattern, `$1${SECRET_PLACEHOLDER}`);
  }
  return { text: result, removed: result !== text };
}

export function mayContainPersonalData(text: string): boolean {
  return PERSONAL_DATA_PATTERNS.some((pattern) => pattern.test(text));
}

/** Audit detail naming the flags, when there are any. Labels only, never content. */
export function flagDetails(
  flags: readonly ContentFlag[],
): Record<string, string> {
  return flags.length > 0 ? { contentFlags: flags.join(",") } : {};
}
