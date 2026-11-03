import {
  DEFINITION_KINDS,
  getDefinition,
  type DefinitionKind,
} from "../../definitions.ts";
import {
  assemblePrompt,
  type PromptAssembly,
  type PromptBlock,
  type PromptSource,
} from "../../prompt.ts";
import {
  barSegments,
  blockSpots,
  formatCount,
  labelSpot,
  linkPath,
  MAX_SATELLITES,
  moreSpot,
  NODE_R,
  SATELLITE_R,
  satelliteSpots,
  STAGES,
  stepNumber,
  type Orientation,
} from "../assets/prompt-view.js";
import { badge, html, type SafeHtml } from "../html.ts";
import {
  page,
  requireUser,
  type RequestContext,
  type Route,
  type WebResponse,
} from "../kit.ts";
import { KIND_INFO, PROMPT_BLOCK_INFO, RELATION_INFO } from "../labels.ts";
import { flagBadges, namesFor, typeLabel } from "../views.ts";
import {
  definitionsPath,
  kindBadge,
  loadScopeView,
  networkPath,
  statusBadge,
} from "./definitions.ts";
import { scriptJson } from "./network.ts";

export function promptPath(definitionId: string): string {
  return `/definitions/${definitionId}/prompt`;
}

function definitionKindOf(source: PromptSource): DefinitionKind | null {
  return DEFINITION_KINDS.find((kind) => kind === source.type) ?? null;
}

function sourceHref(source: PromptSource): string | null {
  if (source.id === null) return null;
  return source.kind === "memory"
    ? `/memories/${source.id}`
    : `/definitions/${source.id}`;
}

const SATELLITE_MARK: Readonly<Record<DefinitionKind | "memory", string>> = {
  agent: "A",
  skill: "S",
  instruction: "I",
  rule: "R",
  memory: "M",
};

function sourceTitle(source: PromptSource): string {
  const kind = definitionKindOf(source);
  const what =
    kind === null
      ? `Memory, ${typeLabel(source.type ?? "")}`
      : KIND_INFO[kind].label;
  const version = source.version === null ? "" : `, version ${source.version}`;
  const left = source.included ? "" : `. ${source.reason ?? "Left out."}`;
  return `${what}: ${source.label}${version}${left}`;
}

function sizeText(tokens: number): string {
  return `≈ ${formatCount(tokens)} tokens`;
}

function passedOf(block: PromptBlock): number {
  return block.checks.filter((check) => check.passed).length;
}

function nodeLabel(block: PromptBlock): string {
  const info = PROMPT_BLOCK_INFO[block.key];
  const checks =
    block.checks.length === 0
      ? ""
      : `, ${passedOf(block)} of ${block.checks.length} checks passed`;
  return `${stepNumber(block.step)} ${info.label}: ${info.meaning}. About ${formatCount(block.tokens)} tokens${checks}.`;
}

/** Linked records fan out beside their block; each is a link to its own page. */
function satellites(
  block: PromptBlock,
  spot: ReturnType<typeof blockSpots>[number],
): SafeHtml {
  const records = block.sources.filter((source) => source.id !== null);
  if (records.length === 0) return html``;
  const spots = satelliteSpots(spot, records.length);
  const more = records.length - MAX_SATELLITES;
  const extra = moreSpot(spot);
  return html`<g class="pa-sats pa-c-${block.key}" data-at="${block.step}">
    ${spots.map((at, index) => {
      const source = records[index];
      if (!source) return "";
      const kind = definitionKindOf(source);
      return html`<a
        class="pa-sat${source.included ? "" : " is-out"}"
        href="${sourceHref(source) ?? "#"}"
        aria-label="${sourceTitle(source)}"
      >
        <title>${sourceTitle(source)}</title>
        <line
          class="pa-sat-line"
          x1="${at.x1}"
          y1="${at.y1}"
          x2="${at.x2}"
          y2="${at.y2}"
          pathLength="1"
        />
        <circle
          class="pa-sat-dot"
          cx="${at.x}"
          cy="${at.y}"
          r="${SATELLITE_R}"
        />
        <text
          class="pa-sat-mark"
          x="${at.x}"
          y="${at.y + 3}"
          text-anchor="middle"
          >${SATELLITE_MARK[kind ?? "memory"]}</text
        >
      </a>`;
    })}
    ${more > 0
      ? html`<text
          class="pa-more"
          x="${extra.x}"
          y="${extra.y}"
          text-anchor="middle"
          >+${more}</text
        >`
      : ""}
  </g>`;
}

/** The constellation: each block a numbered, glowing node, joined in order, with its records around it. */
function stageSvg(
  assembly: PromptAssembly,
  orientation: Orientation,
): SafeHtml {
  const { width, height } = STAGES[orientation];
  const spots = blockSpots(assembly.blocks.length, orientation);
  const glow = `pa-glow-${orientation}`;
  const links = assembly.blocks.slice(1).map((block, index) => {
    const before = assembly.blocks[index];
    const a = spots[index];
    const b = spots[index + 1];
    if (!before || !a || !b) return null;
    return {
      id: `pa-line-${orientation}-${block.step}`,
      before,
      block,
      a,
      b,
    };
  });
  return html`<svg
    class="pa-svg pa-svg-${orientation}"
    viewBox="0 0 ${width} ${height}"
    role="group"
    aria-label="The prompt's ${assembly.blocks
      .length} blocks in order, from Role to Start, with the records each one comes from"
  >
    <defs>
      <filter
        id="${glow}"
        filterUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="${width}"
        height="${height}"
      >
        <feGaussianBlur stdDeviation="5" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      ${links.map((link) =>
        link === null
          ? ""
          : html`<linearGradient
              id="${link.id}"
              gradientUnits="userSpaceOnUse"
              x1="${link.a.x}"
              y1="${link.a.y}"
              x2="${link.b.x}"
              y2="${link.b.y}"
            >
              <stop offset="0" class="pa-stop pa-c-${link.before.key}" />
              <stop offset="1" class="pa-stop pa-c-${link.block.key}" />
            </linearGradient>`,
      )}
    </defs>
    <g class="pa-links">
      ${links.map((link) =>
        link === null
          ? ""
          : html`<path
              class="pa-edge"
              data-at="${link.block.step}"
              d="${linkPath(link.a, link.b, orientation)}"
              stroke="url(#${link.id})"
              filter="url(#${glow})"
              pathLength="1"
            />`,
      )}
    </g>
    ${assembly.blocks.map((block, index) => {
      const spot = spots[index];
      return spot ? satellites(block, spot) : "";
    })}
    ${assembly.blocks.map((block, index) => {
      const spot = spots[index];
      if (!spot) return "";
      const label = labelSpot(spot);
      const info = PROMPT_BLOCK_INFO[block.key];
      return html`<a
        class="pa-node pa-c-${block.key}"
        data-at="${block.step}"
        href="#pa-block-${block.key}"
        aria-label="${nodeLabel(block)}"
      >
        <title>${nodeLabel(block)}</title>
        <circle
          class="pa-halo"
          cx="${spot.x}"
          cy="${spot.y}"
          r="${NODE_R + 16}"
        />
        <circle
          class="pa-ring"
          cx="${spot.x}"
          cy="${spot.y}"
          r="${NODE_R}"
          filter="url(#${glow})"
        />
        <circle
          class="pa-core"
          cx="${spot.x}"
          cy="${spot.y}"
          r="${NODE_R - 7}"
        />
        <text
          class="pa-num"
          x="${spot.x}"
          y="${spot.y + 5}"
          text-anchor="middle"
          >${stepNumber(block.step)}</text
        >
        ${passedOf(block) < block.checks.length
          ? html`<g class="pa-flag">
              <circle
                cx="${spot.x + NODE_R - 6}"
                cy="${spot.y - NODE_R + 6}"
                r="8"
              />
              <text
                x="${spot.x + NODE_R - 6}"
                y="${spot.y - NODE_R + 10}"
                text-anchor="middle"
                >!</text
              >
            </g>`
          : ""}
        <text
          class="pa-name"
          x="${label.x}"
          y="${label.y}"
          text-anchor="${label.anchor}"
          >${info.label}</text
        >
        <text
          class="pa-size"
          x="${label.x}"
          y="${label.y2}"
          text-anchor="${label.anchor}"
          >${sizeText(block.tokens)}</text
        >
      </a>`;
    })}
  </svg>`;
}

function summaryText(assembly: PromptAssembly): string {
  return `Assembled from ${assembly.blocks.length} blocks · about ${formatCount(assembly.tokens)} tokens · ${assembly.checks.passed} of ${assembly.checks.total} checks passed`;
}

/** Live totals along the bottom of the stage. The page's script counts them up as blocks go in. */
function dashboard(assembly: PromptAssembly): SafeHtml {
  const segments = barSegments(
    assembly.blocks.map((block) => block.tokens),
    1000,
    4,
  );
  return html`<div class="pa-dash">
    <dl class="pa-metrics">
      <div class="pa-metric">
        <dt>Blocks</dt>
        <dd>
          <span class="pa-count" data-count="blocks"
            >${assembly.blocks.length}</span
          >
          <span class="pa-of">/ ${assembly.blocks.length}</span>
        </dd>
      </div>
      <div class="pa-metric">
        <dt>Tokens, estimated</dt>
        <dd>
          <span class="pa-of">≈</span>
          <span class="pa-count" data-count="tokens"
            >${formatCount(assembly.tokens)}</span
          >
        </dd>
      </div>
      <div class="pa-metric">
        <dt>Checks passed</dt>
        <dd>
          <span class="pa-count" data-count="checks"
            >${assembly.checks.passed}</span
          >
          <span class="pa-of">/ ${assembly.checks.total}</span>
        </dd>
      </div>
      <div class="pa-metric">
        <dt>Records cited</dt>
        <dd>
          <span class="pa-count" data-count="records">${assembly.records}</span>
        </dd>
      </div>
    </dl>
    <svg
      class="pa-bar"
      viewBox="0 0 1000 8"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      ${assembly.blocks.map((block, index) => {
        const segment = segments[index];
        return segment && segment.width > 0
          ? html`<rect
              class="pa-seg pa-c-${block.key}"
              data-at="${block.step}"
              x="${segment.x}"
              y="0"
              width="${segment.width}"
              height="8"
              rx="2"
            />`
          : "";
      })}
    </svg>
  </div>`;
}

function joinWords(words: readonly string[]): string {
  if (words.length <= 2) return words.join(" and ");
  return `${words.slice(0, -1).join(", ")}, and ${words.at(-1)}`;
}

function sourceItem(source: PromptSource): SafeHtml {
  const kind = definitionKindOf(source);
  const href = sourceHref(source);
  if (source.kind === "memorynet" || href === null) {
    return html`<li>
      ${source.label} <span class="muted">· the same in every prompt</span>
    </li>`;
  }
  const via = source.via === "fixed" ? "" : RELATION_INFO[source.via].label;
  return html`<li>
    <a href="${href}">${source.label}</a>
    ${kind === null
      ? badge(typeLabel(source.type ?? ""), "type")
      : kindBadge(kind)}
    <span class="muted">version ${source.version} · ${via}</span>
    ${source.included
      ? ""
      : html`${badge("left out", "muted")} <small>${source.reason}</small>`}
  </li>`;
}

function blockCard(block: PromptBlock): SafeHtml {
  const info = PROMPT_BLOCK_INFO[block.key];
  const linked = block.sources.filter((source) => source.kind !== "memorynet");
  const fixed = block.sources.filter((source) => source.kind === "memorynet");
  return html`<li class="pa-card pa-c-${block.key}" id="pa-block-${block.key}">
    <div class="pa-card-head">
      <span class="pa-card-num" aria-hidden="true"
        >${stepNumber(block.step)}</span
      >
      <h3>
        ${info.label}
        <span class="pa-card-meaning">${info.meaning}</span>
      </h3>
      <span class="pa-card-size">${sizeText(block.tokens)}</span>
    </div>
    <pre class="pa-text">${block.text}</pre>
    <h4>Comes from</h4>
    <ul class="plain pa-sources">
      ${block.own.length > 0
        ? html`<li>This definition: ${joinWords(block.own)}</li>`
        : ""}
      ${block.key === "review"
        ? html`<li>The blocks above, checked one by one</li>`
        : ""}
      ${[...linked, ...fixed].map(sourceItem)}
      ${block.own.length === 0 &&
      block.sources.length === 0 &&
      block.key !== "review"
        ? html`<li class="empty">Nothing you can see is linked here yet.</li>`
        : ""}
    </ul>
    <h4>Checks</h4>
    ${block.checks.length === 0
      ? html`<p class="empty">
          None: MemoryNet adds the same text to every prompt.
        </p>`
      : html`<ul class="plain pa-checks">
          ${block.checks.map(
            (check) =>
              html`<li data-passed="${check.passed ? "true" : "false"}">
                ${check.passed
                  ? badge("passed", "ok")
                  : badge("needs a look", "warn")}
                ${check.label}
                ${check.passed ? "" : html`<small>${check.advice}</small>`}
              </li>`,
          )}
        </ul>`}
  </li>`;
}

async function promptPage(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const data = await getDefinition(rc.ctx, user.id, rc.params.id ?? "");
  const { definition } = data;
  const view = await loadScopeView(rc, definition.scope);
  const names = await namesFor(rc, [definition.ownerId, definition.runsAs]);
  const assembly = assemblePrompt({
    view: data,
    scope: { level: view.ref.level, name: view.name },
    nameOf: (id) => names.get(id)?.displayName ?? "Unknown",
  });
  const leftOut = assembly.blocks
    .flatMap((block) => block.sources)
    .filter((source) => !source.included).length;
  const payload = {
    intro: "Assembling the prompt, block by block",
    summary: summaryText(assembly),
    checks: assembly.checks.total,
    blocks: assembly.blocks.map((block) => ({
      step: block.step,
      label: PROMPT_BLOCK_INFO[block.key].label,
      meaning: PROMPT_BLOCK_INFO[block.key].meaning,
      tokens: block.tokens,
      passed: passedOf(block),
      checks: block.checks.length,
      records: block.records,
    })),
  };
  return page(rc, {
    title: `Prompt anatomy: ${definition.name}`,
    crumbs: [
      ...view.crumbs,
      ["Definitions", definitionsPath(view.ref)],
      [definition.name, `/definitions/${definition.id}`],
    ],
    body: html`<p>
        ${kindBadge(definition.kind)} ${statusBadge(definition.status)}
        <span class="muted">version ${definition.revision}</span>
        ${flagBadges(definition.flags)} ·
        <a href="/definitions/${definition.id}">Back to the definition</a> ·
        <a
          href="${networkPath(definition.organizationId, {
            node: `definition:${definition.id}`,
          })}"
          >Show in the network</a
        >
      </p>
      <p class="hint">
        How MemoryNet turns this
        ${KIND_INFO[definition.kind].label.toLowerCase()} into a prompt for an
        AI tool: seven building blocks, each made from approved records, put
        together in order. It uses only what you may see. MemoryNet assembles
        the text; it never sends or runs it.
      </p>
      ${definition.status === "retired"
        ? html`<p class="warning">
            Retired: nothing should rely on it now. This is how its last version
            assembles.
          </p>`
        : ""}
      ${leftOut > 0
        ? html`<p class="warning">
            ${leftOut === 1
              ? "1 linked record adds no text"
              : `${leftOut} linked records add no text`}:
            retired definitions and knowledge that is suspended or replaced stay
            listed in their block but are left out of the prompt.
          </p>`
        : ""}
      <div class="pa-stage pa-auto" id="pa-stage">
        <div class="pa-hud">
          <div class="pa-hud-text">
            <p class="pa-eyebrow">Prompt anatomy · ${definition.name}</p>
            <p class="pa-caption" id="pa-caption">${summaryText(assembly)}</p>
          </div>
          <div
            class="pa-controls"
            id="pa-controls"
            role="group"
            aria-label="Play the assembly"
            hidden
          >
            <button type="button" id="pa-replay" title="Assemble it again">
              Replay
            </button>
            <button type="button" id="pa-pause">Pause</button>
            <button
              type="button"
              id="pa-prev"
              aria-label="One block back"
              title="One block back"
            >
              ←
            </button>
            <button
              type="button"
              id="pa-next"
              aria-label="Add the next block"
              title="Add the next block"
            >
              →
            </button>
            <button type="button" id="pa-all">Show all</button>
          </div>
        </div>
        ${stageSvg(assembly, "wide")} ${stageSvg(assembly, "tall")}
        ${dashboard(assembly)}
        <span class="pa-clock" aria-hidden="true"></span>
      </div>
      <p id="pa-announce" class="visually-hidden" role="status"></p>
      <section>
        <h2>The seven blocks</h2>
        <p class="hint">
          In the order they are put together. Token counts are estimates: about
          four characters per token; the real count depends on the AI model.
          Checks look at how the definition is written and linked; they cannot
          tell how well an AI tool will do the work.
        </p>
        <ol class="pa-blocks">
          ${assembly.blocks.map(blockCard)}
        </ol>
      </section>
      <section>
        <h2>The assembled prompt</h2>
        <p class="hint">
          The seven blocks as plain text, to paste into an AI tool by hand. It
          is a copy of version ${definition.revision}: MemoryNet stays the
          source of truth.
        </p>
        <textarea
          class="copy"
          readonly
          rows="18"
          aria-label="The assembled prompt"
        >
${assembly.text}</textarea
        >
      </section>
      <section>
        <h2>Change a block</h2>
        <p>
          Every block comes from a reviewed record, so changes go through review
          like any other:
          <a href="/definitions/${definition.id}#propose-change"
            >propose a change to this definition</a
          >, or open a linked record from its block. Nothing on this page edits
          anything.
        </p>
      </section>
      <script type="application/json" id="pa-data">
        ${scriptJson(payload)}
      </script>
      <script type="module" src="/assets/prompt.js"></script>`,
  });
}

export const promptRoutes: readonly Route[] = [
  {
    method: "GET",
    pattern: /^\/definitions\/(?<id>[^/]+)\/prompt$/,
    access: "user",
    handle: promptPage,
  },
];
