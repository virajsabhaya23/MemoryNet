import { ValidationError } from "./errors.ts";

/** Labels on sources and proposals that point reviewers to content needing a closer look. */
export const CONTENT_FLAGS = [
  "secret_removed",
  "personal_data",
  "truncated",
  "instruction_like",
] as const;
export type ContentFlag = (typeof CONTENT_FLAGS)[number];

/** Stands in for each likely secret removed from automatically captured text. */
export const SECRET_PLACEHOLDER = "[secret removed]";

// Bounded credential families also checked by the public release exporter.
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
  { label: "provider credential", pattern: /()\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{40,255}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,255})\b/g },
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

// Text addressed to an AI model rather than describing engineering knowledge: attempts to override
// instructions, impersonate chat roles, or hide characters. Bounded patterns; reviewers judge the flag.
const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\s{1,5}(?:all\s{1,5}|any\s{1,5}|the\s{1,5})?(?:previous|prior|above|earlier|system|other)\s{1,5}(?:instructions?|prompts?|messages?|rules|context)\b/i,
  /\byou\s{1,5}are\s{1,5}now\s{1,5}(?:a|an|the|in)\b/i,
  /\b(?:new|updated|real|actual)\s{1,5}(?:system\s{1,5})?instructions?\s{0,5}:/i,
  /\b(?:system|developer)\s{1,5}(?:prompt|message|instructions?)\s{0,5}[:=]/i,
  /<\/?\s{0,3}(?:system|assistant|tool|im_start|im_end|instructions?)\b[^>]{0,40}>/i,
  /\[\/?(?:INST|SYS)\]/,
  /\b(?:do\s{1,5}not|don't|never)\s{1,5}(?:tell|inform|mention|reveal\s{1,5}(?:this\s{1,5})?to)\s{1,5}(?:the\s{1,5})?(?:user|human|reviewer|operator)\b/i,
  // Zero-width and bidirectional control characters can hide text from a reviewer.
  /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/,
];

/** True when text looks like instructions aimed at an AI model. A flag for reviewers, not a block. */
export function mayContainInstructions(text: string): boolean {
  return INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text));
}

/** The flags a person's typed text earns: possible personal data and instruction-like text. */
export function typedTextFlags(text: string): ContentFlag[] {
  const flags: ContentFlag[] = [];
  if (mayContainPersonalData(text)) flags.push("personal_data");
  if (mayContainInstructions(text)) flags.push("instruction_like");
  return flags;
}
