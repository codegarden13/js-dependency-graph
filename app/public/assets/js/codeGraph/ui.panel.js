
/**
 * CodeGraph legend/filter panel.
 *
 * Scope
 * -----
 * - Builds the legend/filter panel markup.
 * - Owns panel-local hover/help behavior.
 * - Applies checkbox changes through injected state helpers.
 *
 * This module must not depend on hidden globals from `ui.js`.
 * All state/update hooks are passed in through `opts`.
 */
export function buildLegendFilterPanel(svgId, nodes, links, opts = {}) {
  const root = document.getElementById("legendFilterPanel");
  if (!root) return;

  const getState = opts.getState;
  const dispatchFiltersChanged = opts.dispatchFiltersChanged;
  const updateGroupFilter = opts.updateGroupFilter;
  const updateLinkFilter = opts.updateLinkFilter;
  const updateOptionFilter = opts.updateOptionFilter;
  const stateBySvgId = opts.stateBySvgId;
  const escape = typeof opts.escapeHtml === "function"
    ? opts.escapeHtml
    : defaultEscapeHtml;

  if (typeof getState !== "function") return;
  if (typeof dispatchFiltersChanged !== "function") return;
  if (typeof updateGroupFilter !== "function") return;
  if (typeof updateLinkFilter !== "function") return;
  if (typeof updateOptionFilter !== "function") return;
  if (!(stateBySvgId instanceof Map)) return;

  const id = String(svgId || "");
  const state = getState(id);
  const vm = buildLegendPanelViewModel({ state, nodes, links, opts });

  root.innerHTML = renderLegendPanel(vm, escape);
  bindLegendPanelEvents(root, id, {
    getState,
    dispatchFiltersChanged,
    updateGroupFilter,
    updateLinkFilter,
    updateOptionFilter,
    stateBySvgId,
  });

  dispatchFiltersChanged(id);
  updateLegendSummary(state);
}

function defaultEscapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildLegendPanelViewModel({ state, nodes, links, opts }) {
  const groupColors = opts.nodeGroupColors || Object.create(null);
  const linkColors = opts.linkTypeColors || Object.create(null);

  const sections = [
    {
      key: "groups",
      title: "Node groups",
      subtitle: "What kinds of nodes are visible.",
      items: buildNodeGroupItems(state, nodes, groupColors),
    },
    {
      key: "links",
      title: "Link types",
      subtitle: "What relationships are drawn between nodes.",
      items: buildLinkTypeItems(state, links, linkColors),
    },
    {
      key: "options",
      title: "Options",
      subtitle: "How the graph is reduced or emphasized.",
      items: buildOptionItems(state),
    },
  ];

  return {
    sections: sections.map((section) => ({
      ...section,
      itemCount: Array.isArray(section.items) ? section.items.length : 0,
      checkedCount: Array.isArray(section.items)
        ? section.items.filter((item) => item.checked === true).length
        : 0,
    })),
    totals: {
      sectionCount: sections.length,
      itemCount: sections.reduce(
        (sum, section) => sum + (Array.isArray(section.items) ? section.items.length : 0),
        0
      ),
    },
    helpTitle: "Legend help",
    helpText:
      "Hover a node group, link type, or option to see what it means and how it affects the graph.",
  };
}

function buildNodeGroupItems(state, nodes, groupColors) {
  return [
    createLegendItem({
      key: "root",
      label: "Project root",
      kind: "group",
      title: "Project root node",
      description: "Top-level entry node for the scanned application or workspace.",
      badgeColor: groupColors.root,
      count: countNodesByGroup(nodes, "root"),
      checked: state.showNodeGroups.root !== false,
    }),
    createLegendItem({
      key: "dir",
      label: "Directories",
      kind: "group",
      title: "Directory nodes",
      description: "Folders that structure the codebase and group files below the project root.",
      badgeColor: groupColors.dir,
      count: countNodesByGroup(nodes, "dir"),
      checked: state.showNodeGroups.dir !== false,
    }),
    createLegendItem({
      key: "code",
      label: "Source files",
      kind: "group",
      title: "Source code nodes",
      description: "Implementation files such as JavaScript or TypeScript modules.",
      badgeColor: groupColors.code,
      count: countNodesByGroup(nodes, "code"),
      checked: state.showNodeGroups.code !== false,
    }),
    createLegendItem({
      key: "doc",
      label: "Docs",
      kind: "group",
      title: "Documentation nodes",
      description: "Markdown or other documentation files that belong to the app structure.",
      badgeColor: groupColors.doc,
      count: countNodesByGroup(nodes, "doc"),
      checked: state.showNodeGroups.doc !== false,
    }),
    createLegendItem({
      key: "data",
      label: "Data/config",
      kind: "group",
      title: "Data and config nodes",
      description: "Configuration, JSON, fixtures, and other non-code data files.",
      badgeColor: groupColors.data,
      count: countNodesByGroup(nodes, "data"),
      checked: state.showNodeGroups.data !== false,
    }),
    createLegendItem({
      key: "image",
      label: "Images/assets",
      kind: "group",
      title: "Image and asset nodes",
      description: "Static media assets such as images and related binary resources.",
      badgeColor: groupColors.image,
      count: countNodesByGroup(nodes, "image"),
      checked: state.showNodeGroups.image !== false,
    }),
  ];
}

function buildLinkTypeItems(state, links, linkColors) {
  return [
    createLegendItem({
      key: "include",
      label: "Imports/includes",
      kind: "link",
      title: "Include relationship",
      description: "A file or module includes another file through an import-like dependency.",
      badgeColor: linkColors.include,
      count: countLinksByType(links, "include"),
      checked: state.visibleLinkTypes.include !== false,
    }),
    createLegendItem({
      key: "use",
      label: "Uses/reference",
      kind: "link",
      title: "Use relationship",
      description: "A node references or uses another symbol without necessarily calling it.",
      badgeColor: linkColors.use,
      count: countLinksByType(links, "use"),
      checked: state.visibleLinkTypes.use !== false,
    }),
    createLegendItem({
      key: "call",
      label: "Function calls",
      kind: "link",
      title: "Call relationship",
      description: "A function directly invokes another function.",
      badgeColor: linkColors.call,
      count: countLinksByType(links, "call"),
      checked: state.visibleLinkTypes.call !== false,
    }),
    createLegendItem({
      key: "extends",
      label: "Inheritance",
      kind: "link",
      title: "Extends relationship",
      description: "A class or structure derives from another base type.",
      badgeColor: linkColors.extends,
      count: countLinksByType(links, "extends"),
      checked: state.visibleLinkTypes.extends !== false,
    }),
  ];
}

function buildOptionItems(state) {
  return [
    createLegendItem({
      key: "showFilesDirs",
      label: "Show files/dirs",
      kind: "opt",
      title: "Show file and directory nodes",
      description: "Keeps structural filesystem nodes visible in the graph.",
      checked: state.showFilesDirs !== false,
    }),
    createLegendItem({
      key: "showFunctions",
      label: "Show functions",
      kind: "opt",
      title: "Show function nodes",
      description: "Displays function-level nodes in addition to file-level structure.",
      checked: state.showFunctions !== false,
    }),
    createLegendItem({
      key: "showHulls",
      label: "Show hull zones",
      kind: "opt",
      title: "Show cluster hull zones",
      description: "Shows the soft area overlays that group related nodes into larger architecture zones.",
      checked: state.showHulls !== false,
    }),
    createLegendItem({
      key: "showUnused",
      label: "Show unused",
      kind: "opt",
      title: "Show unused functions",
      description: "Makes functions marked as unused visible and eligible for highlighting.",
      checked: state.showUnused === true,
    }),
    createLegendItem({
      key: "unusedOnly",
      label: "Unused only",
      kind: "opt",
      title: "Focus unused functions",
      description: "Reduces the graph to unused function candidates only.",
      checked: state.unusedOnly === true,
    }),
    createLegendItem({
      key: "showVisitorHandlers",
      label: "Show visitor handlers",
      kind: "opt",
      title: "Show AST visitor handlers",
      description: "Shows parser and traversal handler functions such as Babel visitor callbacks.",
      checked: state.showVisitorHandlers !== false,
    }),
    createLegendItem({
      key: "hideIsolates",
      label: "Hide isolates",
      kind: "opt",
      title: "Hide isolated nodes",
      description: "Hides nodes without visible incoming or outgoing links.",
      checked: state.hideIsolates === true,
    }),
  ];
}

function createLegendItem(cfg) {
  return {
    key: cfg.key,
    label: cfg.label,
    kind: cfg.kind,
    title: cfg.title,
    description: cfg.description,
    badgeColor: cfg.badgeColor || "",
    count: cfg.count,
    checked: cfg.checked === true,
  };
}

function renderLegendPanel(vm, safe) {
  return `
    <div data-legend-layout="dense">
      <div class="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-2">
        <div class="small fw-semibold">Graph legend & filters</div>
        <div class="d-flex flex-wrap align-items-center gap-2 small">
          <span class="badge text-bg-light border">${safe(String(vm.totals.sectionCount))} sections</span>
          <span class="badge text-bg-light border">${safe(String(vm.totals.itemCount))} controls</span>
        </div>
      </div>

      <div class="mb-2">
        <label for="legendFilterSearch" class="form-label small mb-1">Filter legend entries</label>
        <input
          id="legendFilterSearch"
          type="search"
          class="form-control form-control-sm"
          placeholder="Search groups, links, or options"
          autocomplete="off"
        />
      </div>

      <div class="d-flex flex-column gap-2">
        ${vm.sections.map((section) => renderSection(section, safe)).join("")}
      </div>

      <div class="mt-2 small text-secondary" id="legendExplainText">${safe(vm.helpText)}</div>
      <div class="d-none" id="legendExplainTitle">${safe(vm.helpTitle)}</div>
    </div>
  `;
}

function renderSection(section, safe) {
  return `
    <div class="border rounded px-2 py-2 bg-body" data-legend-card="${safe(section.key || "")}">
      <div class="d-flex align-items-center justify-content-between gap-2 mb-2">
        <div>
          <div class="small fw-semibold lh-sm">${safe(section.title)}</div>
          <div class="small text-secondary lh-sm">${safe(section.checkedCount || 0)} / ${safe(section.itemCount || 0)} active</div>
        </div>
      </div>
      <div class="d-flex flex-column gap-1" data-legend-section="${safe(section.key || "")}">
        ${section.items.map((item) => renderLegendItem(item, safe)).join("")}
      </div>
    </div>
  `;
}

function renderLegendItem(item, safe) {
  const name = `${item.kind}:${item.key}`;
  const badgeHtml = renderColorDot(item.badgeColor, safe);
  const metaHtml = renderItemMeta(item, safe);

  return `
    <label
      class="d-flex align-items-center justify-content-between gap-2 px-2 py-1 border rounded legend-filter-item"
      data-cg-name="${safe(name)}"
      data-legend-title="${safe(item.title || item.label)}"
      data-legend-text="${safe(item.description || "")}" 
      data-legend-search="${safe(`${item.label} ${item.title || ""} ${item.description || ""} ${item.kind}`.toLowerCase())}"
    >
      <span class="d-flex align-items-center gap-2 flex-grow-1 min-w-0">
        <input
          type="checkbox"
          class="form-check-input mt-0"
          data-cg-name="${safe(name)}"
          ${item.checked ? "checked" : ""}
        />
        ${badgeHtml}
        <span class="small text-truncate flex-grow-1">${safe(item.label)}</span>
        <span class="badge rounded-pill text-bg-light border text-uppercase" style="font-size:10px">${safe(item.kind)}</span>
      </span>
      ${metaHtml}
    </label>
  `;
}

function renderItemMeta(item, safe) {
  if (!Number.isFinite(item.count)) return "";
  return `<span class="badge rounded-pill text-bg-light border">${safe(String(item.count))}</span>`;
}

function renderColorDot(color, safe) {
  if (!color) return "";

  const safeColor = safe(color || "#999");
  return `
    <span
      class="rounded-circle border flex-shrink-0"
      aria-hidden="true"
      style="display:inline-block;width:10px;height:10px;background:${safeColor};border-color:rgba(0,0,0,0.12)!important"
    ></span>
  `;
}

function countNodesByGroup(list, group) {
  let count = 0;
  for (const node of list || []) {
    const nodeGroup = node?.group ?? "";
    if (nodeGroup !== group) continue;
    count += 1;
  }
  return count;
}

function countLinksByType(list, type) {
  let count = 0;
  for (const link of list || []) {
    const linkType = resolveLegendLinkType(link);
    if (linkType !== type) continue;
    count += 1;
  }
  return count;
}

function resolveLegendLinkType(link) {
  const raw = firstNonEmptyLegendString(
    link?.type,
    link?.edgeType,
    link?.relation,
    link?.rel,
    link?.kind,
    link?.label
  ).toLowerCase();

  if (!raw) return "use";
  if (raw.includes("include")) return "include";
  if (raw.includes("call")) return "call";
  if (raw.includes("extend")) return "extends";
  if (raw.includes("inherit")) return "extends";
  if (raw.includes("import")) return "use";
  if (raw.includes("use")) return "use";
  return raw;
}

function firstNonEmptyLegendString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function bindLegendPanelEvents(root, id, deps) {
  root.onchange = (ev) => handleLegendFilterChange(ev, id, deps);
  root.oninput = handleLegendFilterSearch;
  root.onmouseover = handleLegendFilterHover;
  root.onfocusin = handleLegendFilterHover;
  root.onmouseleave = resetLegendExplanation;
  root.onfocusout = handleLegendFilterFocusOut;
}

function readCheckboxTarget(ev) {
  return /** @type {HTMLInputElement|null} */ (ev?.target || null);
}

function readFilterKey(el) {
  return String(el?.getAttribute("data-cg-name") || "");
}

function applyFilterUpdate(state, key, checked, deps) {
  if (key.startsWith("group:")) {
    deps.updateGroupFilter(state, key, checked);
    return true;
  }

  if (key.startsWith("link:")) {
    deps.updateLinkFilter(state, key, checked);
    return true;
  }

  if (key.startsWith("opt:")) {
    deps.updateOptionFilter(state, key, checked);
    return true;
  }

  return false;
}

function handleLegendFilterChange(ev, id, deps) {
  const el = readCheckboxTarget(ev);
  if (!el) return;

  const key = readFilterKey(el);
  if (!key) return;

  const checked = el.checked === true;
  const state = deps.getState(id);

  if (!applyFilterUpdate(state, key, checked, deps)) return;

  deps.stateBySvgId.set(id, state);
  deps.dispatchFiltersChanged(id);
}

function handleLegendFilterSearch(ev) {
  const el = ev?.target;
  if (!(el instanceof HTMLInputElement)) return;
  if (el.id !== "legendFilterSearch") return;

  const query = String(el.value || "").trim().toLowerCase();
  const root = document.getElementById("legendFilterPanel");
  if (!root) return;

  const items = root.querySelectorAll(".legend-filter-item");
  for (const item of items) {
    if (!(item instanceof HTMLElement)) continue;
    const haystack = String(item.getAttribute("data-legend-search") || "");
    const matches = !query || haystack.includes(query);
    item.hidden = !matches;
  }

  const sections = root.querySelectorAll("[data-legend-section]");
  for (const section of sections) {
    if (!(section instanceof HTMLElement)) continue;
    const visibleItems = Array.from(section.children).filter(
      (child) => child instanceof HTMLElement && child.hidden !== true
    );
    const card = section.closest("[data-legend-card]");
    if (card instanceof HTMLElement) card.hidden = visibleItems.length === 0;
  }
}

function findLegendItemElement(start) {
  if (!(start instanceof Element)) return null;
  return start.closest("[data-legend-title]");
}

function handleLegendFilterHover(ev) {
  const itemEl = findLegendItemElement(ev?.target);
  if (!itemEl) return;

  setLegendExplanation(
    itemEl.getAttribute("data-legend-title"),
    itemEl.getAttribute("data-legend-text")
  );
}

function handleLegendFilterFocusOut(ev) {
  const next = ev?.relatedTarget;
  if (document.getElementById("legendFilterPanel")?.contains(next)) return;
  resetLegendExplanation();
}

function setLegendExplanation(title, text) {
  const titleEl = document.getElementById("legendExplainTitle");
  const textEl = document.getElementById("legendExplainText");
  if (titleEl) titleEl.textContent = String(title || "Legend help");
  if (textEl) textEl.textContent = String(text || "");
}

function resetLegendExplanation() {
  setLegendExplanation(
    "Legend help",
    "Hover a node group, link type, or option to see what it means and how it affects the graph."
  );
}

function updateLegendSummary(state) {
  try {
    const summary = document.getElementById("filterSummary");
    if (summary) summary.textContent = String(state.preset || "custom");
  } catch {
    // ignore
  }
}