/** Markup that is already escaped or was built from trusted templates. */
export interface SafeHtml {
  readonly __html: string;
}

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

function isSafeHtml(value: unknown): value is SafeHtml {
  return typeof value === "object" && value !== null && "__html" in value;
}

export function formatDate(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function render(value: unknown): string {
  if (value === null || value === undefined || typeof value === "boolean") {
    return "";
  }
  if (Array.isArray(value)) return value.map(render).join("");
  if (isSafeHtml(value)) return value.__html;
  if (value instanceof Date) return escapeHtml(formatDate(value));
  return escapeHtml(String(value));
}

/** Template tag that escapes every value unless it is SafeHtml. Booleans and null render nothing. */
export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): SafeHtml {
  let out = strings[0] ?? "";
  values.forEach((value, index) => {
    out += render(value) + (strings[index + 1] ?? "");
  });
  return { __html: out };
}

/** Joins fragments without a separator. */
export function join(parts: readonly SafeHtml[]): SafeHtml {
  return { __html: parts.map((part) => part.__html).join("") };
}

/** A link to an outside page. Anything but https becomes plain text. */
export function externalLink(url: string, label: string): SafeHtml {
  if (!url.startsWith("https://")) return html`${label}`;
  return html`<a href="${url}" rel="noopener noreferrer" target="_blank">${label}</a>`;
}

export function badge(label: string, variant = "neutral"): SafeHtml {
  return html`<span class="badge badge-${variant}">${label}</span>`;
}

/** First characters of longer text, for lists. */
export function preview(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function table(
  headers: readonly string[],
  rows: readonly SafeHtml[][],
  empty: string,
): SafeHtml {
  if (rows.length === 0) return html`<p class="empty">${empty}</p>`;
  return html`<div class="table-wrap">
    <table>
      <thead>
        <tr>
          ${headers.map((header) => html`<th scope="col">${header}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${rows.map(
          (cells) => html`<tr>
            ${cells.map((cell) => html`<td>${cell}</td>`)}
          </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

export function options(
  items: ReadonlyArray<{ value: string; label: string }>,
  selected?: string,
): SafeHtml {
  return join(
    items.map(
      (item) =>
        html`<option value="${item.value}" ${item.value === selected ? html`selected` : ""}>
          ${item.label}
        </option>`,
    ),
  );
}

/** Label/value pairs as a hairline-divided strip (Cobalt stat strip). */
export function statStrip(
  items: ReadonlyArray<readonly [label: string, value: string | number]>,
): SafeHtml {
  return html`<dl class="stat-strip">
    ${items.map(
      ([label, value]) => html`<div><dt>${label}</dt><dd>${value}</dd></div>`,
    )}
  </dl>`;
}

/** One ledger row: title, meta line, trailing state/actions; whole-row link when href is given. */
export function ledgerRow(input: {
  href?: string;
  title: SafeHtml | string;
  meta?: SafeHtml | string;
  trailing?: SafeHtml | string;
}): SafeHtml {
  const title = input.href
    ? html`<a class="row-title" href="${input.href}">${input.title}</a>`
    : html`<span class="row-title">${input.title}</span>`;
  return html`<li class="ledger-row">
    ${title}
    ${input.meta !== undefined ? html`<span class="row-meta">${input.meta}</span>` : ""}
    ${input.trailing !== undefined ? html`<span class="row-trailing">${input.trailing}</span>` : ""}
  </li>`;
}

/** The record page header: kind badge, title, status, meta line, actions. */
export function recordHead(input: {
  kind: SafeHtml | string;
  title: string;
  status?: SafeHtml | string;
  meta?: SafeHtml | string;
  actions?: SafeHtml | string;
}): SafeHtml {
  return html`<header class="record-head">
    <div>
      <span class="record-kind">${input.kind}</span>
      <p class="record-title">${input.title}</p>
      ${input.status !== undefined ? html`<span class="record-status">${input.status}</span>` : ""}
    </div>
    ${input.actions !== undefined ? html`<div class="record-actions">${input.actions}</div>` : ""}
    ${input.meta !== undefined ? html`<p class="record-meta">${input.meta}</p>` : ""}
  </header>`;
}

/** Tab-like scope navigation over existing URLs and in-page anchors. */
export function scopeTabs(
  tabs: ReadonlyArray<{ label: string; href: string; count?: number; current?: boolean }>,
): SafeHtml {
  return html`<nav class="scope-tabs" aria-label="Scope sections">
    ${tabs.map(
      (tab) => html`<a href="${tab.href}" ${tab.current ? html`aria-current="page"` : ""}>${tab.label}${tab.count !== undefined ? html`<span class="tab-count">${tab.count}</span>` : ""}</a>`,
    )}
  </nav>`;
}
