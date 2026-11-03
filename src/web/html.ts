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
