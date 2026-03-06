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

  return {
    sections: [
      {
        title: "Node groups",
        subtitle: "What kinds of nodes are visible.",
        items: buildNodeGroupItems(state, nodes, groupColors),
      },
      {
        title: "Link types",
        subtitle: "What relationships are drawn between nodes.",
        items: buildLinkTypeItems(state, links, linkColors),
      },
      {
        title: "Options",
        subtitle: "How the graph is reduced or emphasized.",
        items: buildOptionItems(state),
      },
    ],
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
    <div class="small text-secondary mb-3">
      Filter what is visible in the graph. Hover or focus an entry to see what it means.
    </div>

    <div class="row g-3">
      ${vm.sections.map((section) => renderSection(section, safe)).join("")}
    </div>

    <div class="mt-3 border rounded p-3 bg-body-tertiary">
      <div class="small fw-semibold mb-1" id="legendExplainTitle">${safe(vm.helpTitle)}</div>
      <div class="small text-secondary" id="legendExplainText">${safe(vm.helpText)}</div>
    </div>
  `;
}

function renderSection(section, safe) {
  return `
    <div class="col-12 col-md-4">
      <div class="border rounded p-2 h-100">
        <div class="small fw-semibold">${safe(section.title)}</div>
        <div class="small text-secondary mb-2">${safe(section.subtitle || "")}</div>
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
      class="d-flex align-items-start justify-content-between gap-2 py-1"
      data-cg-name="${safe(name)}"
      data-legend-title="${safe(item.title || item.label)}"
      data-legend-text="${safe(item.description || "")}"
    >
      <span class="d-flex align-items-start gap-2">
        <input
          type="checkbox"
          class="form-check-input mt-1"
          data-cg-name="${safe(name)}"
          ${item.checked ? "checked" : ""}
        />
        <span>
          <span class="small d-block">${safe(item.label)}</span>
          ${metaHtml}
        </span>
      </span>
      ${badgeHtml}
    </label>
  `;
}

function renderItemMeta(item, safe) {
  if (!Number.isFinite(item.count)) return "";

  const unit = item.kind === "link" ? "edges" : "nodes";
  return `<span class="text-secondary" style="font-size:12px">${safe(String(item.count))} ${safe(unit)}</span>`;
}

function renderColorDot(color, safe) {
  if (!color) return "";

  const safeColor = safe(color || "#999");
  return `<span class="rounded-circle" style="display:inline-block;width:10px;height:10px;background:${safeColor}"></span>`;
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
    const linkType = link?.type ?? "use";
    if (linkType !== type) continue;
    count += 1;
  }
  return count;
}

function bindLegendPanelEvents(root, id, deps) {
  root.onchange = (ev) => handleLegendFilterChange(ev, id, deps);
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