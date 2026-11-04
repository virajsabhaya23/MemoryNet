// Your network: you at the center of everything you can reach, drawn on a canvas by graph-engine.js.
// Opening a place asks this site (same origin only) for what it holds and grows the map around it, while
// everything already on screen keeps its place. The page only ever shows what the server sent.
import { createGraphView } from "./graph-engine.js";
import { wrapTitle } from "./graph-tiers.js";
import {
  ACCENT,
  buildGraph,
  chainOf,
  closeForRoom,
  colorOf,
  firstPositions,
  focusOf,
  OPEN_LIMIT,
  YOU,
} from "./my-network-view.js";
import { nearestInDirection } from "./network-view.js";

const RELATION_WORDS = {
  uses: "uses",
  follows: "follows",
  hands_off_to: "hands off to",
  based_on: "is based on",
  cites: "cites",
};
const FAMILY_WORDS = {
  work: "How we work",
  know: "What we know",
  evidence: "Evidence",
};
/** Connections that carry a quiet moving light when nothing is selected. */
const AMBIENT_LIMIT = 120;
const ARROWS = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

const canvas = document.getElementById("myn-canvas");
const dataBlock = document.getElementById("myn-data");
if (canvas && dataBlock) start(JSON.parse(dataBlock.textContent ?? "{}"));

function element(tag, attributes = {}, text) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null)
      node.setAttribute(name, String(value));
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function sameSite(href) {
  return typeof href === "string" && href.startsWith("/") && !href.startsWith("//");
}

function start(data) {
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  const $ = (id) => document.getElementById(id);
  const stage = $("myn-stage");
  const summary = $("myn-summary");
  const detail = $("myn-detail");
  const tip = $("myn-tip");
  const status = $("myn-status");
  const placesNav = $("myn-places");
  const orgId = data.org;
  const tops = data.tops ?? [];
  const kids = data.kids ?? {};

  // What the page knows: the places drawn at first, then whatever opened places bring.
  const info = new Map(Object.entries(data.places ?? {}));
  const itemData = new Map();
  const opened = new Map();
  const order = [];
  const hidden = new Set(["evidence"]);
  let graph = { nodes: [], links: [], parentOf: new Map() };
  let byId = new Map();
  let shown = new Set();
  let ambient = [];
  let selected = null;
  let hovered = null;
  /** What the camera keeps in view: "all", one place, or nothing once you move it yourself. */
  let auto = "all";

  // The map --------------------------------------------------------------------------------------
  const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  const themeName = () => {
    const chosen = document.documentElement.getAttribute("data-theme");
    if (chosen === "light" || chosen === "dark") return chosen;
    return themeMedia.matches ? "dark" : "light";
  };
  const engine = createGraphView(canvas, {
    reduceMotion,
    theme: themeName(),
    font: getComputedStyle(document.body).fontFamily,
  });
  engine.setZoomLimits(0.04, 6);

  function paint() {
    const theme = engine.theme;
    for (const node of graph.nodes) {
      node.color = colorOf(node, theme);
      if (node.item?.owned) node.badge = ACCENT[theme];
    }
    for (const link of graph.links) if (link.access) link.color = ACCENT[theme];
  }
  const syncTheme = () => {
    engine.setTheme(themeName());
    paint();
    engine.redraw();
  };
  themeMedia.addEventListener("change", syncTheme);
  new MutationObserver(syncTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  /** Lays out the map again from what is open; with `grow`, everything on screen keeps its place. */
  function rebuild(grow) {
    graph = buildGraph({
      org: orgId,
      tops,
      kids,
      places: info,
      opened,
      listedCount: data.listedCount ?? 0,
      theme: engine.theme,
    });
    byId = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const node of graph.nodes) {
      node.card = {
        kindLabel: node.kind === "you" ? "You" : (FAMILY_WORDS[node.family] ?? node.kind ?? ""),
        statusLabel: node.item?.owned ? "Yours" : "",
        lines: wrapTitle(node.label ?? ""),
        meta: node.item?.kind ?? node.place?.level ?? "",
        attention: node.item?.owned ? "Owned by you" : null,
      };
    }
    engine.setData(
      graph,
      grow
        ? { keepPositions: true }
        : { keepPositions: true, positions: firstPositions(graph.nodes, orgId) },
    );
    applyFamilies();
    const step = Math.max(1, Math.ceil(graph.links.length / AMBIENT_LIMIT));
    ambient = graph.links.filter(
      (link, index) => !link.hidden && !link.access && index % step === 0,
    );
    syncPlaceLinks();
    if (selected !== null && !byId.has(selected)) select(null);
    else restyle();
  }

  function applyFamilies() {
    shown = new Set(
      graph.nodes
        .filter((node) => !node.family || !hidden.has(node.family))
        .map((node) => node.id),
    );
    if (shown.size < graph.nodes.length) engine.setActive(shown);
  }

  function restyle() {
    const focusId = selected ?? hovered;
    const focus = focusId !== null && byId.has(focusId) ? focusOf(graph, focusId) : null;
    // Your own roles stay bright until something else is in focus.
    const edges = focus
      ? focus.edges
      : new Set(graph.links.filter((link) => link.access).map((link) => link.id));
    engine.setStyle({
      visible: shown,
      highlighting: focus !== null,
      near: focus?.near ?? new Set(),
      activeEdges: edges,
      selected,
      hovered,
      focusGroups: new Set(order),
      labels: true,
      ambient: reduceMotion ? null : ambient,
      flow: reduceMotion ? new Set() : edges,
    });
  }

  // The camera -----------------------------------------------------------------------------------
  const stacked = window.matchMedia("(max-width: 64rem)");
  /** Room the floating panels cover, so framing centres things in the open part of the map. */
  function insets() {
    const frame = canvas.getBoundingClientRect();
    const out = { left: 0, right: 0, top: 0, bottom: 16 };
    // On narrow screens the panels sit above and below the map instead of over it.
    if (frame.width < 900 || stacked.matches) return out;
    const panel = $("myn-panel");
    if (panel && panel.offsetWidth > 0) {
      out.right = Math.max(0, frame.right - panel.getBoundingClientRect().left);
    }
    const bar = stage.querySelector(".myn-bar");
    if (bar) out.top = Math.max(0, bar.getBoundingClientRect().bottom - frame.top);
    const head = stage.querySelector(".myn-head");
    if (head && frame.width >= 1200) {
      out.left = Math.max(0, head.getBoundingClientRect().right - frame.left);
    }
    return out;
  }
  function openCenter() {
    const size = engine.size;
    const room = insets();
    return {
      x: room.left + (size.width - room.left - room.right) / 2,
      y: room.top + (size.height - room.top - room.bottom) / 2,
    };
  }
  function frameCircle(x, y, r, animate) {
    const target = engine.frameTarget(x, y, r, 40, insets());
    // Never so close that a small place fills the window.
    target.k = Math.min(target.k, 2.2);
    const center = openCenter();
    target.x = center.x - x * target.k;
    target.y = center.y - y * target.k;
    if (animate && !reduceMotion) engine.animateTo(target);
    else engine.jumpTo(target);
  }
  function frameIds(ids, animate) {
    const bounds = engine.bounds(ids.filter((id) => shown.has(id)));
    if (bounds) frameCircle(bounds.x, bounds.y, bounds.r, animate);
  }
  /** Everything in view, with you in the middle of it. */
  function fitAll(animate) {
    auto = "all";
    const you = engine.position(YOU);
    if (!you) return;
    let reach = you.r;
    engine.each((node, x, y, r) => {
      if (shown.has(node.id)) reach = Math.max(reach, Math.hypot(x - you.x, y - you.y) + r);
    });
    frameCircle(you.x, you.y, reach + 24, animate);
  }
  function inside(id) {
    const out = [id];
    for (const [child, parent] of graph.parentOf) {
      if (parent === id) out.push(...inside(child));
    }
    return out;
  }
  function framePlace(id, animate) {
    auto = id;
    frameIds(inside(id), animate);
  }
  /** Moves the view just enough to bring a node into the open part of the map. */
  function reveal(id) {
    const p = engine.position(id);
    if (!p) return;
    const s = engine.toScreen(p.x, p.y);
    const size = engine.size;
    const room = insets();
    const margin = 48;
    if (
      s.x > room.left + margin &&
      s.x < size.width - room.right - margin &&
      s.y > room.top + margin &&
      s.y < size.height - room.bottom - margin
    )
      return;
    auto = null;
    const center = openCenter();
    const k = engine.camera.k;
    const target = { k, x: center.x - p.x * k, y: center.y - p.y * k };
    if (reduceMotion) engine.jumpTo(target);
    else engine.animateTo(target);
  }
  function zoomBy(factor) {
    auto = null;
    const center = openCenter();
    engine.zoomAt(factor, center.x, center.y);
  }
  engine.on("settle", () => {
    // Once a grown map has settled, keep what the camera follows fully in view.
    if (auto === "all") fitAll(true);
    else if (auto !== null && byId.has(auto)) framePlace(auto, true);
  });
  new ResizeObserver(() => {
    engine.resize();
    if (auto === "all") fitAll(false);
    else if (auto !== null && byId.has(auto)) framePlace(auto, false);
  }).observe(canvas);

  // Opening and closing places -------------------------------------------------------------------
  function titleOf(id) {
    if (id === YOU) return "You";
    const node = byId.get(id);
    return info.get(id)?.title ?? itemData.get(id)?.label ?? node?.label ?? "";
  }
  async function openPlace(id) {
    if (opened.has(id)) return true;
    const place = info.get(id);
    if (!place?.level) return false;
    const response = await fetch(`${data.endpoint}${encodeURIComponent(id)}`, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    }).catch(() => null);
    if (!response?.ok) {
      announce(`${place.title} could not be opened.`);
      return false;
    }
    const contents = await response.json();
    if (opened.has(id) || !byId.has(id)) return opened.has(id);
    for (const child of contents.children ?? []) {
      if (!info.has(child.id)) info.set(child.id, { ...child, where: place.title });
    }
    for (const item of contents.items ?? []) {
      itemData.set(item.id, { ...item, place: id });
    }
    for (const other of closeForRoom(order, new Set(chainOf(graph.parentOf, id)), OPEN_LIMIT)) {
      closePlace(other, false);
    }
    opened.set(id, contents);
    order.push(id);
    rebuild(true);
    const items = (contents.items ?? []).length;
    const children = (contents.children ?? []).length;
    const parts = [];
    if (children > 0) parts.push(`${children} projects`);
    parts.push(`${items} ${items === 1 ? "piece" : "pieces"} of knowledge`);
    announce(
      `Opened ${place.title}: ${parts.join(" and ")} around it${
        contents.more > 0 ? `, and ${contents.more} more on its page` : ""
      }.`,
    );
    return true;
  }
  function closePlace(id, rebuildNow = true) {
    if (!opened.has(id)) return;
    for (const other of [...order]) {
      if (other !== id && chainOf(graph.parentOf, other).includes(id)) closePlace(other, false);
    }
    opened.delete(id);
    order.splice(order.indexOf(id), 1);
    if (rebuildNow) {
      rebuild(true);
      announce(`Closed ${titleOf(id)}.`);
    }
  }
  let announceFrame = 0;
  function announce(text) {
    if (!status) return;
    status.textContent = "";
    cancelAnimationFrame(announceFrame);
    announceFrame = requestAnimationFrame(() => {
      status.textContent = text;
    });
  }

  // The places as links, for the keyboard and screen readers --------------------------------------
  const fixedLinks = new Set(
    [...(placesNav?.querySelectorAll("a[data-id]") ?? [])].map((link) => link.dataset.id),
  );
  const addedLinks = new Map();
  function linkWords(node) {
    if (node.item) {
      return `${node.item.kindLabel}: ${node.item.label}. In ${titleOf(node.group)}.`;
    }
    if (node.place) {
      const facts = node.place.facts?.[0] ?? "";
      return `${node.place.kind}: ${node.place.title}. ${facts}.`;
    }
    return `${node.label} in ${titleOf(node.group)}, not drawn.`;
  }
  function syncPlaceLinks() {
    if (!placesNav) return;
    for (const [id, row] of addedLinks) {
      if (byId.has(id)) continue;
      row.remove();
      addedLinks.delete(id);
    }
    for (const node of graph.nodes) {
      if (fixedLinks.has(node.id)) continue;
      let row = addedLinks.get(node.id);
      if (!row) {
        const holder = placesNav.querySelector(`ul[data-holds="${CSS.escape(node.group ?? "")}"]`);
        if (!holder) continue;
        const href = node.item?.href ?? node.place?.href;
        row = element("li");
        row.append(
          element(
            "a",
            {
              href: sameSite(href) ? href : "#myn-panel",
              "data-id": node.id,
              "aria-label": linkWords(node),
            },
            node.label,
          ),
        );
        if (node.hub) row.append(element("ul", { "data-holds": node.id }));
        holder.append(row);
        addedLinks.set(node.id, row);
      }
      row.hidden = !shown.has(node.id);
    }
  }
  placesNav?.addEventListener("focusin", (event) => {
    const id = event.target.closest?.("a[data-id]")?.dataset.id;
    if (!id || !byId.has(id)) return;
    select(id);
    reveal(id);
  });
  placesNav?.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[data-id]");
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    activate(link.dataset.id);
  });

  // The panel ------------------------------------------------------------------------------------
  function connections(id) {
    const list = element("ul", { class: "plain myn-connected" });
    for (const link of graph.links) {
      if (!link.relation || (link.source !== id && link.target !== id)) continue;
      const outgoing = link.source === id;
      const other = outgoing ? link.target : link.source;
      const words = RELATION_WORDS[link.relation] ?? link.relation;
      const button = element(
        "button",
        { type: "button", class: "net-link" },
        outgoing ? `${words} ${titleOf(other)}` : `${titleOf(other)} ${words} this`,
      );
      button.addEventListener("click", () => {
        select(other);
        reveal(other);
      });
      const row = element("li");
      row.append(button);
      list.append(row);
    }
    return list.childElementCount === 0 ? null : list;
  }
  function listOf(entries) {
    const list = element("ul", { class: "plain myn-list" });
    for (const [text, onClick, className] of entries) {
      const row = element("li", className ? { class: className } : {});
      const button = element("button", { type: "button", class: "net-link" }, text);
      button.addEventListener("click", onClick);
      row.append(button);
      list.append(row);
    }
    return list;
  }
  function contentsParts(id) {
    const contents = opened.get(id);
    if (!contents) return [];
    const parts = [];
    const children = contents.children ?? [];
    if (children.length > 0) {
      parts.push(
        element("h3", {}, "Projects"),
        listOf(children.map((child) => [child.title, () => void choose(child.id)])),
      );
    }
    if (contents.items.length > 0) {
      parts.push(
        element("h3", {}, "Knowledge here"),
        listOf(
          contents.items.map((item) => [
            `${item.kindLabel}: ${item.label}`,
            () => {
              if (hidden.has(item.family)) toggleFamily(item.family, true);
              select(item.id);
              reveal(item.id);
            },
            `fam-${item.family}`,
          ]),
        ),
      );
    } else if (children.length === 0) {
      parts.push(element("p", { class: "empty" }, "Nothing you can see is kept here yet."));
    }
    if (contents.more > 0) {
      parts.push(
        element(
          "p",
          { class: "hint" },
          `${contents.more} more are not drawn; open the page to see them all.`,
        ),
      );
    }
    return parts;
  }
  function moreParts(id) {
    if (id === "more:units") {
      const parts = [
        element("p", { class: "myn-kind" }, "Business units"),
        element("h2", {}, `${data.listedCount ?? 0} more business units`),
        element(
          "p",
          {},
          "There are too many business units to draw at once. These are listed instead:",
        ),
      ];
      const list = element("ul", { class: "plain myn-list" });
      for (const unit of data.listed ?? []) {
        const row = element("li");
        if (sameSite(unit.href)) row.append(element("a", { href: unit.href }, unit.name));
        else row.append(document.createTextNode(unit.name));
        list.append(row);
      }
      parts.push(list);
      return parts;
    }
    const place = info.get(id.slice(5));
    const parts = [
      element("p", { class: "myn-kind" }, `More in ${place?.title ?? ""}`),
      element("h2", {}, byId.get(id)?.label ?? ""),
      element(
        "p",
        {},
        "Only part of this place is drawn, so the map stays readable. Its page lists everything you can see there.",
      ),
    ];
    if (sameSite(place?.href)) {
      const actions = element("p", { class: "myn-actions" });
      actions.append(element("a", { href: place.href }, "Open its page"));
      parts.push(actions);
    }
    return parts;
  }
  function backButton() {
    const back = element("button", { type: "button", class: "secondary" }, "Back to your access");
    back.addEventListener("click", () => select(null));
    return back;
  }
  function showDetail(id) {
    if (id.startsWith("more:")) {
      detail.replaceChildren(...moreParts(id), backButton());
      summary.hidden = true;
      detail.hidden = false;
      return;
    }
    const place = info.get(id);
    const item = itemData.get(id);
    const entry =
      place ??
      (item && {
        ...item,
        title: item.label,
        kind: item.kindLabel,
        where: info.get(item.place)?.title ?? "",
      });
    if (!entry) return;
    const parts = [
      element(
        "p",
        { class: "myn-kind" },
        entry.where ? `${entry.kind} · in ${entry.where}` : entry.kind,
      ),
      element("h2", {}, entry.title),
    ];
    if (entry.owned) parts.push(element("p", { class: "myn-yours" }, "Yours: you own it"));
    if (place) {
      const access = {
        direct: "Your own role",
        covered: "Covered by a role above",
        inside: "No role here",
      }[place.access];
      if (access) parts.push(element("p", { class: `myn-access access-${place.access}` }, access));
    }
    parts.push(element("h3", {}, "Why you can see it"), element("p", {}, entry.why ?? ""));
    const facts = element("ul", { class: "plain myn-facts" });
    for (const fact of entry.facts ?? []) facts.append(element("li", {}, fact));
    parts.push(facts);
    const connected = connections(id);
    if (connected) parts.push(element("h3", {}, "Connected to"), connected);
    parts.push(...contentsParts(id));
    const actions = element("p", { class: "myn-actions" });
    if (sameSite(entry.href)) actions.append(element("a", { href: entry.href }, "Open its page"));
    const full =
      typeof entry.full === "string"
        ? entry.full
        : `/orgs/${data.organization}/network?node=${encodeURIComponent(id)}`;
    if (sameSite(full)) actions.append(element("a", { href: full }, "Show in the full map"));
    if (opened.has(id)) {
      const close = element("button", { type: "button", class: "secondary" }, "Close it");
      close.addEventListener("click", () => {
        closePlace(id);
        select(null);
        fitAll(true);
      });
      actions.append(close);
    }
    actions.append(backButton());
    parts.push(actions);
    detail.replaceChildren(...parts);
    summary.hidden = true;
    detail.hidden = false;
  }
  function select(id) {
    selected = id;
    for (const link of placesNav?.querySelectorAll("a[aria-current]") ?? []) {
      link.removeAttribute("aria-current");
    }
    if (id !== null) {
      placesNav
        ?.querySelector(`a[data-id="${CSS.escape(id)}"]`)
        ?.setAttribute("aria-current", "true");
    }
    restyle();
    if (id === null || id === YOU) {
      detail.hidden = true;
      summary.hidden = false;
      return;
    }
    showDetail(id);
  }
  async function choose(id) {
    select(id);
    if (!info.get(id)?.level) return;
    const wasOpen = opened.has(id);
    if (!wasOpen && !(await openPlace(id))) return;
    if (selected === id) {
      select(id);
      framePlace(id, true);
    }
  }
  /** What a click, Enter, or a followed link does: open a place, or select anything else. */
  function activate(id) {
    if (id === YOU) {
      select(selected === YOU ? null : YOU);
      return;
    }
    if (id === selected && opened.has(id)) {
      closePlace(id);
      select(null);
      fitAll(true);
      return;
    }
    if (info.get(id)?.level) {
      void choose(id);
      return;
    }
    select(id);
  }

  // Pointing, dragging, and zooming --------------------------------------------------------------
  function hideTip() {
    tip.hidden = true;
  }
  function tipLines(id) {
    if (id === YOU) return ["You", data.viewer ? `${data.viewer} · your access here` : "Your access here"];
    const place = info.get(id);
    if (place) {
      return [
        place.title,
        `${place.kind}${place.where ? ` · in ${place.where}` : ""} · ${place.facts?.[0] ?? ""}`,
      ];
    }
    const item = itemData.get(id);
    if (item) return [item.label, `${item.kindLabel} · in ${titleOf(item.place)}`];
    return [byId.get(id)?.label ?? "", "Not drawn, to keep the map readable"];
  }
  function showTip(id, point) {
    const [title, line] = tipLines(id);
    tip.replaceChildren(element("strong", {}, title), element("span", {}, line));
    tip.hidden = false;
    const box = stage.getBoundingClientRect();
    const left = Math.min(point.x + 14, box.width - tip.offsetWidth - 8);
    const top = Math.min(point.y + 16, box.height - tip.offsetHeight - 8);
    tip.style.setProperty("left", `${Math.max(8, left)}px`);
    tip.style.setProperty("top", `${Math.max(8, top)}px`);
  }
  function localPoint(event) {
    const box = canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }
  function hitAt(point) {
    const id = engine.hitTest(point.x, point.y);
    return id !== null && byId.has(id) && shown.has(id) ? id : null;
  }
  function setHovered(id) {
    if (id === hovered) return;
    hovered = id;
    canvas.classList.toggle("is-pointing", id !== null);
    restyle();
  }

  const pointers = new Map();
  let gesture = null;
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    hideTip();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    canvas.setPointerCapture(event.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = { mode: "pinch", distance: Math.hypot(a.x - b.x, a.y - b.y), moved: true };
      return;
    }
    const point = localPoint(event);
    const target = hitAt(point);
    const origin = { x: event.clientX, y: event.clientY };
    if (target !== null && target !== YOU) {
      const at = engine.position(target);
      const world = engine.toWorld(point.x, point.y);
      gesture = {
        mode: "node",
        target,
        start: origin,
        last: origin,
        moved: false,
        grab: { x: world.x - at.x, y: world.y - at.y },
        modifier: event.metaKey || event.ctrlKey || event.shiftKey,
      };
    } else {
      gesture = { mode: "pan", target, start: origin, last: origin, moved: false };
    }
    canvas.classList.add("is-dragging");
  });
  let hoverFrame = 0;
  let hoverEvent = null;
  canvas.addEventListener("pointermove", (event) => {
    if (!gesture) {
      hoverEvent = event;
      if (!hoverFrame) {
        hoverFrame = requestAnimationFrame(() => {
          hoverFrame = 0;
          if (!hoverEvent || gesture) return;
          const point = localPoint(hoverEvent);
          const id = hitAt(point);
          setHovered(id);
          if (id === null) hideTip();
          else showTip(id, point);
        });
      }
      return;
    }
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (gesture.mode === "pinch" && pointers.size === 2) {
      auto = null;
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const box = canvas.getBoundingClientRect();
      engine.zoomAt(
        distance / (gesture.distance || distance),
        (a.x + b.x) / 2 - box.left,
        (a.y + b.y) / 2 - box.top,
      );
      gesture.distance = distance;
      return;
    }
    const dx = event.clientX - gesture.start.x;
    const dy = event.clientY - gesture.start.y;
    if (!gesture.moved && Math.hypot(dx, dy) > 4) gesture.moved = true;
    if (!gesture.moved) return;
    auto = null;
    if (gesture.mode === "pan") {
      engine.panBy(event.clientX - gesture.last.x, event.clientY - gesture.last.y);
      gesture.last = { x: event.clientX, y: event.clientY };
    } else if (gesture.mode === "node") {
      // Dragging only tidies the picture; let go and it settles back among its neighbours.
      const world = engine.toWorld(localPoint(event).x, localPoint(event).y);
      engine.pin(gesture.target, world.x - gesture.grab.x, world.y - gesture.grab.y);
    }
  });
  function endGesture(event) {
    pointers.delete(event.pointerId);
    if (!gesture) return;
    const finished = gesture;
    if (pointers.size === 0) {
      gesture = null;
      canvas.classList.remove("is-dragging");
    }
    if (finished.mode === "node" && finished.moved) engine.release(finished.target);
    if (finished.mode === "pinch" || finished.moved || event.type !== "pointerup") return;
    if (finished.target === null) {
      select(null);
      return;
    }
    // A modified click follows the link, as it would on a page.
    const href = info.get(finished.target)?.href ?? itemData.get(finished.target)?.href;
    if (finished.modifier && sameSite(href)) {
      window.open(href, "_blank", "noopener");
      return;
    }
    activate(finished.target);
  }
  canvas.addEventListener("pointerup", endGesture);
  canvas.addEventListener("pointercancel", endGesture);
  canvas.addEventListener("pointerleave", () => {
    if (gesture) return;
    hideTip();
    setHovered(null);
  });
  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      hideTip();
      auto = null;
      const point = localPoint(event);
      const speed = event.ctrlKey ? 0.012 : 0.0018;
      engine.zoomAt(Math.exp(-event.deltaY * speed), point.x, point.y);
    },
    { passive: false },
  );
  canvas.addEventListener("dblclick", (event) => {
    const id = hitAt(localPoint(event));
    if (id !== null && info.get(id)?.level) framePlace(id, true);
  });
  $("myn-zoom-in")?.addEventListener("click", () => zoomBy(1.5));
  $("myn-zoom-out")?.addEventListener("click", () => zoomBy(1 / 1.5));
  $("myn-fit")?.addEventListener("click", () => fitAll(true));

  // The keyboard ---------------------------------------------------------------------------------
  canvas.addEventListener("keydown", (event) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const direction = ARROWS[event.key];
    if (direction) {
      event.preventDefault();
      const from = selected ?? YOU;
      const at = engine.position(from) ?? { x: 0, y: 0 };
      const candidates = [];
      engine.each((node, x, y) => {
        if (node.id !== from && shown.has(node.id)) candidates.push({ id: node.id, x, y });
      });
      const next = nearestInDirection(at, candidates, direction);
      if (next === null) return;
      select(next);
      reveal(next);
      announce(tipLines(next).join(". "));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (selected === null) return;
      const href = itemData.get(selected)?.href;
      if (sameSite(href)) window.location.assign(href);
      else activate(selected);
      return;
    }
    if (event.key === "+" || event.key === "=") zoomBy(1.4);
    else if (event.key === "-" || event.key === "_") zoomBy(1 / 1.4);
    else if (event.key === "0") fitAll(true);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || selected === null) return;
    if (event.target instanceof HTMLInputElement) return;
    select(null);
  });

  // Find a place by name -------------------------------------------------------------------------
  const find = $("myn-find");
  find?.addEventListener("change", async () => {
    const wanted = find.value.trim().toLowerCase();
    if (wanted === "") return;
    for (const [id, place] of info) {
      if (place.level && byId.has(id) && place.title.toLowerCase() === wanted) {
        await choose(id);
        return;
      }
    }
    const hit = (data.find ?? []).find((one) => one.name.toLowerCase() === wanted);
    if (!hit?.parent || !byId.has(hit.parent)) {
      announce(`No place called ${find.value.trim()} on your map.`);
      return;
    }
    await openPlace(hit.parent);
    if (byId.has(hit.id)) {
      select(hit.id);
      framePlace(hit.parent, true);
    } else {
      select(hit.parent);
    }
  });

  // Show or hide each kind of knowledge: the map closes up or makes room ------------------------
  function toggleFamily(family, visible) {
    const key = stage.querySelector(`[data-family="${family}"]`);
    key?.setAttribute("aria-pressed", visible ? "true" : "false");
    if (visible) hidden.delete(family);
    else hidden.add(family);
    shown = new Set(
      graph.nodes
        .filter((node) => !node.family || !hidden.has(node.family))
        .map((node) => node.id),
    );
    engine.setActive(shown);
    syncPlaceLinks();
    if (selected !== null && !shown.has(selected)) select(null);
    else restyle();
    announce(`${FAMILY_WORDS[family] ?? family} ${visible ? "shown" : "hidden"}.`);
  }
  for (const key of stage.querySelectorAll("[data-family]")) {
    key.addEventListener("click", () =>
      toggleFamily(key.dataset.family, key.getAttribute("aria-pressed") !== "true"),
    );
  }

  // First picture: settle, fit, count up ---------------------------------------------------------
  engine.resize();
  rebuild(false);
  fitAll(false);
  stage.classList.add("is-ready");
  const counters = [...stage.querySelectorAll("[data-count]")];
  if (!reduceMotion && counters.length > 0) {
    const finals = counters.map((counter) => Number(counter.textContent));
    const began = performance.now();
    const length = 1400;
    const count = (now) => {
      const t = Math.min((now - began) / length, 1);
      counters.forEach((counter, index) => {
        counter.textContent = String(Math.round((finals[index] ?? 0) * (1 - (1 - t) ** 3)));
      });
      if (t < 1) requestAnimationFrame(count);
    };
    requestAnimationFrame(count);
  }
}
