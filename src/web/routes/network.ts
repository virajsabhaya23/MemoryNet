import type { ScopeRef } from "../../access.ts";
import {
  EDGE_RELATIONS,
  getNetwork,
  isDefinitionKind,
  NODE_KINDS,
  type NetworkGraph,
  type NetworkNode,
} from "../../network.ts";
import { attentionItems } from "../assets/network-view.js";
import { html, table, type SafeHtml } from "../html.ts";
import {
  breadcrumbs,
  page,
  interfaceIcon,
  requireUser,
  type RequestContext,
  type Route,
  type WebResponse,
} from "../kit.ts";
import {
  KIND_INFO,
  LEVEL_INFO,
  MEMORY_TYPE_INFO,
  NODE_INFO,
  RELATION_INFO,
  STATE_INFO,
} from "../labels.ts";
import { roleBadge, scopePath } from "../views.ts";
import { definitionsPath } from "./definitions.ts";

function nodeHref(node: NetworkNode): string | null {
  if (node.kind === "memory") return `/memories/${node.recordId}`;
  if (node.kind === "source") return `/sources/${node.recordId}`;
  if (isDefinitionKind(node.kind)) return `/definitions/${node.recordId}`;
  return null;
}

/** JSON inside a script data block. Escaping <, >, and & keeps any text from closing the block. */
export function scriptJson(value: unknown): SafeHtml {
  return {
    __html: JSON.stringify(value)
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/&/g, "\\u0026")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029"),
  };
}

/** Longest piece of evidence text the map carries; the source's own page has all of it. */
export const EXCERPT_PREVIEW = 280;

/** The details the map needs. Pull request text is shortened: at organization size it was most of the page. */
function previewDetails(node: NetworkNode): NetworkNode["details"] {
  if (node.kind !== "source" || !("excerpt" in node.details)) {
    return node.details;
  }
  const excerpt = node.details.excerpt;
  return excerpt.length <= EXCERPT_PREVIEW
    ? node.details
    : {
        ...node.details,
        excerpt: `${excerpt.slice(0, EXCERPT_PREVIEW - 1).trimEnd()}…`,
      };
}

/** What the page's script draws. Built only from the caller's network, so it holds nothing more. */
export function networkPayload(
  graph: NetworkGraph,
  focus: string | null,
  select: string | null,
) {
  const clusterIds = new Set(graph.clusters.map((cluster) => cluster.id));
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  return {
    generatedAt: graph.generatedAt.toISOString(),
    organization: graph.organization,
    viewer: {
      id: graph.viewer.id,
      displayName: graph.viewer.displayName,
      kind: graph.viewer.kind,
    },
    focus: focus !== null && clusterIds.has(focus) ? focus : null,
    select: select !== null && nodeIds.has(select) ? select : null,
    clusters: graph.clusters.map((cluster) => {
      const scope: ScopeRef = { level: cluster.level, id: cluster.recordId };
      return {
        ...cluster,
        href: scopePath(scope),
        definitionsHref: definitionsPath(scope),
      };
    }),
    nodes: graph.nodes.map((node) => ({
      ...node,
      details: previewDetails(node),
      href: nodeHref(node),
    })),
    edges: graph.edges,
    legend: {
      nodes: NODE_INFO,
      relations: RELATION_INFO,
      kinds: KIND_INFO,
      levels: LEVEL_INFO,
      memoryTypes: MEMORY_TYPE_INFO,
      states: STATE_INFO,
    },
  };
}

/** Rows per table in the list below the map; the Table view pages through everything. */
export const LIST_LIMIT = 400;

function more(total: number, what: string): SafeHtml {
  return total > LIST_LIMIT
    ? html`<p class="hint">
        Showing the first ${LIST_LIMIT} of ${total} ${what}. The Table view
        above lists all of them, and each record has its own page.
      </p>`
    : html``;
}

function listAlternative(graph: NetworkGraph): SafeHtml {
  const clusterName = new Map(
    graph.clusters.map((cluster) => [cluster.id, cluster.name]),
  );
  const nodeLabel = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodeCell = (id: string) => {
    const node = nodeLabel.get(id);
    if (!node) return html`—`;
    const href = nodeHref(node);
    return html`${href === null
        ? node.label
        : html`<a href="${href}">${node.label}</a>`}
      <small>${NODE_INFO[node.kind].label.toLowerCase()}</small>`;
  };
  return html`<details class="network-list" id="net-list">
    <summary>Show the network as a list (same records, no diagram)</summary>
    <h3>Groups</h3>
    ${table(
      ["Group", "Level", "Inside", "Your role"],
      graph.clusters.map((cluster) => [
        html`<a
          href="${scopePath({ level: cluster.level, id: cluster.recordId })}"
          >${cluster.name}</a
        >`,
        html`${LEVEL_INFO[cluster.level].label}`,
        html`${cluster.parentId === null
          ? "—"
          : (clusterName.get(cluster.parentId) ?? "—")}`,
        roleBadge(cluster.role),
      ]),
      "No groups.",
    )}
    <h3>Nodes</h3>
    ${table(
      ["Name", "Kind", "Group", "Status"],
      graph.nodes.slice(0, LIST_LIMIT).map((node) => [
        nodeCell(node.id),
        html`${NODE_INFO[node.kind].label}`,
        html`${clusterName.get(node.clusterId) ?? "—"}`,
        html`${node.status ?? ""}`,
      ]),
      "Nothing you can see here yet.",
    )}
    ${more(graph.nodes.length, "nodes")}
    <h3>Connections</h3>
    ${table(
      ["From", "Connection", "To", "Why it is here"],
      graph.edges.slice(0, LIST_LIMIT).map((edge) => [
        nodeCell(edge.from),
        html`${RELATION_INFO[edge.relation].label}`,
        nodeCell(edge.to),
        html`${edge.why} <small>(${edge.table})</small>`,
      ]),
      "No connections.",
    )}
    ${more(graph.edges.length, "connections")}
  </details>`;
}

/** Things that need someone, not totals. Counts only what this person can see. */
function attention(graph: NetworkGraph): SafeHtml {
  const items = attentionItems(graph.nodes, graph.clusters);
  const chips: SafeHtml[] = [];
  const plural = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;
  if (items.pending.count > 0) {
    chips.push(
      html`<li>
        <span data-attention="pending" data-tone="pending"
          >${plural(
            items.pending.count,
            "change waiting for review",
            "changes waiting for review",
          )}</span
        >
      </li>`,
    );
  }
  if (items.warnings.count > 0) {
    chips.push(
      html`<li>
        <span data-attention="warnings" data-tone="warning"
          >${plural(items.warnings.count, "needs a look", "need a look")}</span
        >
      </li>`,
    );
  }
  if (items.flagged.count > 0) {
    chips.push(
      html`<li>
        <span
          data-attention="flagged"
          data-tone="flagged"
          title="Possible personal data, or a secret was removed"
          >${plural(items.flagged.count, "flagged item", "flagged items")}</span
        >
      </li>`,
    );
  }
  if (chips.length === 0) {
    chips.push(
      html`<li>
        <span data-tone="current">Nothing here needs attention</span>
      </li>`,
    );
  }
  return html`<ul class="net-attention" aria-label="Needs attention">
    ${chips}
  </ul>`;
}

/** Display choices, kept in a menu so the map gets the room. */
function viewMenu(graph: NetworkGraph): SafeHtml {
  const count = (kind: string) =>
    graph.nodes.filter((node) => node.kind === kind).length;
  const retired = graph.nodes.filter(
    (node) => node.status === "retired",
  ).length;
  return html`<details class="net-menu" id="net-view-menu">
    <summary>View</summary>
    <div
      class="net-menu-panel net-view-panel"
      id="net-filters"
      aria-label="Show or hide parts of the network"
    >
      <h2>Show</h2>
      <ul class="chips">
        ${NODE_KINDS.map(
          (kind) =>
            html`<li>
              <label class="chip" title="${NODE_INFO[kind].meaning}">
                <input type="checkbox" data-kind="${kind}" checked />
                <span
                  class="net-icon"
                  data-icon="${kind}"
                  aria-hidden="true"
                ></span>
                ${NODE_INFO[kind].label}
                <span class="net-count">${count(kind)}</span>
              </label>
            </li>`,
        )}
        <li>
          <label
            class="chip"
            title="Retired definitions keep their history but nothing should rely on them."
          >
            <input type="checkbox" id="net-retired" />
            <span
              class="net-icon"
              data-icon="retired"
              aria-hidden="true"
            ></span>
            Retired definitions <span class="net-count">${retired}</span>
          </label>
        </li>
      </ul>
      <h2>Connections</h2>
      <ul class="chips">
        ${EDGE_RELATIONS.map(
          (relation) =>
            html`<li>
              <label class="chip" title="${RELATION_INFO[relation].meaning}">
                <input type="checkbox" data-relation="${relation}" checked />
                <span
                  class="net-line net-line-${relation}"
                  aria-hidden="true"
                ></span>
                ${RELATION_INFO[relation].label}
                <span class="net-count"
                  >${graph.edges.filter((edge) => edge.relation === relation)
                    .length}</span
                >
              </label>
            </li>`,
        )}
      </ul>
      <div class="net-view-grid">
        <label for="net-edge-mode">Draw</label>
        <select id="net-edge-mode">
          <option value="auto">Automatically</option>
          <option value="all">Every connection</option>
          <option value="selection">Only for the selection</option>
        </select>
        <label for="net-depth">Focus depth</label>
        <select id="net-depth">
          <option value="1">1 step</option>
          <option value="2">2 steps</option>
          <option value="99">All</option>
        </select>
        <label for="net-shade">Shade groups by</label>
        <select id="net-shade">
          <option value="none">Nothing</option>
          <option value="items">How much is inside</option>
          <option value="pending">Changes waiting</option>
          <option value="incidents">Incidents</option>
          <option value="recent">Changed in 30 days</option>
        </select>
      </div>
      <label class="toggle"
        ><input type="checkbox" id="net-focus-mode" /> Only what connects to the
        selection</label
      >
      <label class="toggle"
        ><input type="checkbox" id="net-labels" checked /> Names</label
      >
      <label class="toggle"
        ><input type="checkbox" id="net-flow" checked /> Light moving along
        connections</label
      >
    </div>
  </details>`;
}

/** The colour key beside the map. Each kind of memory can be switched off; people start hidden. */
function memoryLegend(graph: NetworkGraph): SafeHtml {
  const tiers = [
    {
      tier: "procedural",
      label: "How we work",
      kinds: ["rule", "instruction", "skill", "agent"],
      title: "Rules, instructions, skills, and agents",
      pressed: true,
    },
    {
      tier: "semantic",
      label: "What we know",
      kinds: ["memory"],
      title: "Approved memories: decisions, reasons, limits, lessons",
      pressed: true,
    },
    {
      tier: "episodic",
      label: "Evidence",
      kinds: ["source"],
      title: "Pull requests the memories were captured from",
      pressed: true,
    },
    {
      tier: "people",
      label: "People",
      kinds: ["person", "agent_account"],
      title:
        "Owners and agent accounts. Hidden at first: owners show as initials on what they own.",
      pressed: false,
    },
  ] as const;
  return html`<div class="net-legend" id="net-legend">
    <p class="net-legend-title">Kinds of memory</p>
    <ul>
      ${tiers.map(
        (entry) =>
          html`<li>
            <button
              type="button"
              data-tier="${entry.tier}"
              aria-pressed="${entry.pressed ? "true" : "false"}"
              title="${entry.title}"
            >
              <span
                class="net-swatch tier-${entry.tier}"
                aria-hidden="true"
              ></span>
              ${entry.label}
              <span class="net-count"
                >${graph.nodes.filter((node) =>
                  (entry.kinds as readonly string[]).includes(node.kind),
                ).length}</span
              >
            </button>
          </li>`,
      )}
    </ul>
  </div>`;
}

const SHORTCUTS: ReadonlyArray<readonly [readonly string[], string]> = [
  [["⌘", "K"], "Search or run a command (also /)"],
  [["Esc"], "Close, then clear the selection"],
  [["Tab"], "Move between things in the diagram"],
  [["←", "→", "↑", "↓"], "Nearest thing in that direction (or pan)"],
  [["Enter"], "Select"],
  [["F"], "Only what connects to the selection"],
  [["I"], "What depends on the selection"],
  [["P"], "Pin the selection to compare"],
  [["H"], "Show or hide people and agent accounts"],
  [["Z"], "Zoom to the selection"],
  [["0"], "Fit everything"],
  [["+", "−"], "Zoom in or out"],
  [["[", "]"], "Back or forward"],
  [["1", "2", "3", "4"], "Network, Timeline, AI Trace, Table"],
];

function toolbar(graph: NetworkGraph): SafeHtml {
  const tab = (mode: string, label: string, selected: boolean) =>
    html`<button
      type="button"
      role="tab"
      id="net-tab-${mode}"
      data-mode="${mode}"
      aria-controls="net-panel-${mode}"
      aria-selected="${selected ? "true" : "false"}"
      tabindex="${selected ? "0" : "-1"}"
    >
      ${label}
    </button>`;
  return html`<div class="net-bar" role="toolbar" aria-label="Network controls">
    <div
      class="net-modes"
      role="tablist"
      aria-label="Views of the same records"
    >
      ${tab("network", "Network", true)} ${tab("timeline", "Timeline", false)}
      ${tab("trace", "AI Trace", false)} ${tab("table", "Table", false)}
    </div>
    <div class="net-search">
      <label class="visually-hidden" for="net-search"
        >Find something in the network, or run a command</label
      >
      <input
        id="net-search"
        type="search"
        role="combobox"
        aria-expanded="false"
        aria-controls="net-search-results"
        aria-autocomplete="list"
        placeholder="Find anything: a rule, agent, memory, person… or a command"
        autocomplete="off"
      />
      <kbd aria-hidden="true">⌘K</kbd>
      <ul
        id="net-search-results"
        class="net-results"
        role="listbox"
        aria-label="Matches"
        hidden
      ></ul>
    </div>
    <div class="net-nav">
      <button
        type="button"
        class="icon-button"
        id="net-back"
        aria-label="Back"
        title="Back ( [ )"
        disabled
      >${interfaceIcon("back")}</button>
      <button
        type="button"
        class="icon-button"
        id="net-forward"
        aria-label="Forward"
        title="Forward ( ] )"
        disabled
      >${interfaceIcon("forward")}</button>
    </div>
    <div class="net-tools">
      ${viewMenu(graph)}
      <details class="net-menu" id="net-views-menu">
        <summary>Saved views</summary>
        <div class="net-menu-panel">
          <h2>Save this view</h2>
          <form id="net-save-view">
            <label class="visually-hidden" for="net-view-name">Name</label>
            <input
              id="net-view-name"
              maxlength="60"
              placeholder="A name, such as Q3 incidents"
              required
            />
            <button type="submit">Save</button>
          </form>
          <p class="hint">
            Kept in this browser, for you only. The page address always holds
            the current view, so a link opens it for anyone allowed to see it.
          </p>
          <h2>Your views</h2>
          <ul class="net-saved" id="net-saved"></ul>
          <p>
            <button type="button" class="secondary" id="net-copy-link">
              Copy a link to this view
            </button>
          </p>
        </div>
      </details>
      <details class="net-menu" id="net-keys-menu">
        <summary aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
          ?
        </summary>
        <div class="net-menu-panel">
          <h2>Keyboard</h2>
          <dl class="net-keys">
            ${SHORTCUTS.map(
              ([keys, meaning]) =>
                html`<dt>${keys.map((key) => html`<kbd>${key}</kbd>`)}</dt>
                  <dd>${meaning}</dd>`,
            )}
          </dl>
        </div>
      </details>
    </div>
  </div>`;
}

const TRACE_PANEL = html`<div class="net-empty-state">
  <div class="net-empty-mark" aria-hidden="true">AI</div>
  <h2>No AI retrieval records yet</h2>
  <p>
    This view will show exactly which memory versions MemoryNet supplied to an
    AI tool, and which it left out. It shows the context supplied to the AI,
    never an explanation of how the model reasoned.
  </p>
  <p>
    Nothing is recorded yet because no AI tool connects to MemoryNet yet.
    Retrieval records arrive with search and the Copilot connection (development
    plan Steps 3 and 4).
  </p>
  <p class="hint">Until then this view stays empty instead of guessing.</p>
</div>`;

async function networkPage(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const evidenceView = rc.req.query.get("evidence") === "all";
  const graph = await getNetwork(rc.ctx, user.id, rc.params.id ?? "", {includeUncitedSources:evidenceView});
  const organization = graph.organization;
  const payload = networkPayload(
    graph,
    rc.req.query.get("focus"),
    rc.req.query.get("node"),
  );
  const count = (kinds: readonly string[]) =>
    graph.nodes.filter((node) => kinds.includes(node.kind)).length;
  return page(rc, {
    title: `${organization.name} network`,
    workspace: true,
    immersive: true,
    body: html`<div class="net-app" id="network">
        <div class="net-stage">
          <div
            class="net-panel network-canvas"
            id="net-panel-network"
            role="tabpanel"
            aria-labelledby="net-tab-network"
          >
            <canvas
              id="net-canvas"
              role="img"
              aria-label="Network diagram of ${organization.name}. Use the Table view or the list below the map for the same records as text."
            ></canvas>
            <div class="net-tooltip" id="net-tooltip" hidden></div>
          </div>
          <div
            class="net-panel net-sheet"
            id="net-panel-timeline"
            role="tabpanel"
            aria-labelledby="net-tab-timeline"
            hidden
          ></div>
          <div
            class="net-panel net-sheet"
            id="net-panel-trace"
            role="tabpanel"
            aria-labelledby="net-tab-trace"
            hidden
          >
            ${TRACE_PANEL}
          </div>
          <div
            class="net-panel net-sheet"
            id="net-panel-table"
            role="tabpanel"
            aria-labelledby="net-tab-table"
            hidden
          ></div>

          <header class="net-hud net-head panel">
            <p class="net-eyebrow">
              <a href="/orgs/${organization.id}">Organization</a>
              <span aria-hidden="true">/</span> Network
            </p>
            <h1>${organization.name}</h1>
            <p class="net-sub">
              <strong>${graph.nodes.length}</strong> items ·
              <strong>${graph.edges.length}</strong> connections ·
              <strong>${graph.clusters.length}</strong> groups
            </p>
            <p class="net-live">
              <span class="net-live-dot" aria-hidden="true"></span> Only what
              you may see
            </p>
            ${attention(graph)}
            <a class="net-evidence-toggle" href="/orgs/${organization.id}/network?evidence=${evidenceView ? "cited" : "all"}">${evidenceView ? "Show cited evidence only" : "Explore all source evidence"}</a>
            ${evidenceView ? html`<p class="hint">Source evidence view. Merged PRs are not locally approved decisions. Up to 200 sources per repository.</p>` : ""}
          </header>

          <div class="net-hud net-topbar panel" id="net-topbar">
            ${toolbar(graph)}
          </div>

          <aside class="net-hud net-inspector panel" id="net-inspector">
            <button
              type="button"
              class="net-inspector-toggle"
              id="net-inspector-toggle"
              aria-expanded="true"
              aria-controls="net-details"
              title="Show or hide details"
            >
              <span aria-hidden="true">⟩</span
              ><span class="visually-hidden">Details</span>
            </button>
            <div class="net-details" id="net-details" aria-label="Details">
              <h2>Details</h2>
              <p>
                Click a node, a connection, or a group to see what it is, who
                owns it, and which record it comes from.
              </p>
            </div>
          </aside>

          <div class="net-hud net-legend-dock panel">
            ${memoryLegend(graph)}
            <p class="net-legend-title">Colours</p>
            <ul class="net-key" id="net-key" aria-label="Colour key"></ul>
            <p class="net-legend-note">
              ${count(["memory"])} memories · ${count(["source"])} pull
              requests
            </p>
          </div>

          <div class="net-hud net-controls">
            <div class="net-zoom panel">
              <button
                type="button"
                id="net-zoom-in"
                aria-label="Zoom in"
                title="Zoom in (+)"
              >${interfaceIcon("plus")}</button>
              <button
                type="button"
                id="net-zoom-out"
                aria-label="Zoom out"
                title="Zoom out (−)"
              >${interfaceIcon("minus")}</button>
              <button
                type="button"
                id="net-fit"
                aria-label="Fit all"
                title="Fit all (0)"
              >${interfaceIcon("fit")}</button>
            </div>
            <div
              class="net-minimap panel"
              id="net-minimap"
              aria-hidden="true"
              hidden
            ></div>
          </div>

          <div class="net-hud net-statusbar">
            <nav
              class="net-where"
              id="net-where"
              aria-label="Where you are in the diagram"
            ></nav>
            <p class="net-status-line">
              <span class="net-tier" id="net-tier"></span>
              <span id="net-status"></span>
            </p>
          </div>

          <div
            class="net-hud net-compare panel"
            id="net-compare"
            aria-label="Pinned side by side"
            hidden
          ></div>
          <aside
            class="net-dock"
            id="net-dock"
            aria-label="Recent changes"
            hidden
          ></aside>
        </div>
        <noscript
          ><p class="warning">
            The diagram needs JavaScript. The same network is listed below.
          </p></noscript
        >
        <p id="net-announce" class="visually-hidden" role="status"></p>
      </div>
      <section class="network-list-wrap">${listAlternative(graph)}</section>
      <script type="application/json" id="network-data">
        ${scriptJson(payload)}
      </script>
      <script type="module" src="/assets/network.js"></script>`,
  });
}

export const networkRoutes: readonly Route[] = [
  {
    method: "GET",
    pattern: /^\/orgs\/(?<id>[^/]+)\/network$/,
    access: "user",
    handle: networkPage,
  },
];
