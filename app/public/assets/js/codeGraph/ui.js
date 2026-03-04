// public/assets/js/uiWidgets.js
/**
 * Graph UI Widgets (UI-side)
 * =========================
 * Houses optional DOM-bound widgets:
 * - Filters toolbar
 * - Legend
 * - Diagnostics table
 *
 * All functions are no-ops if the expected DOM anchor does not exist.
 *
 * Exposes: window.CodeGraphUI
 */

(function () {
  "use strict";

  const CodeGraphUI = {};

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  CodeGraphUI.escapeHtml = escapeHtml;

  // --- Helper functions and state utilities for combined Legend & Filter panel ---

  /**
   * Returns the global store object for legend/filter state.
   * Initializes if missing.
   */
  function getLegendFilterStore() {
    if (!window.__codeGraphLegendFilterState) window.__codeGraphLegendFilterState = {};
    return window.__codeGraphLegendFilterState;
  }

  /**
   * Retrieves the stored state object for a given svgId.
   * Returns a new default state if none exists.
   * @param {string} svgId
   * @returns {object}
   */
  function getState(svgId) {
    const store = getLegendFilterStore();
    if (!store[svgId]) {
      store[svgId] = {
        preset: "architecture",
        showNodeGroups: {
          root: true,
          dir: true,
          code: true,
          doc: true,
          data: true,
          image: true,
        },
        visibleLinkTypes: {
          include: true,
          use: true,
          call: true,
          extends: true,
        },
        showFilesDirs: true,
        showFunctions: true,
        showUnused: false,
        unusedOnly: false,
        showVisitorHandlers: true,
        hideIsolates: false,
      };
    }
    return store[svgId];
  }


    /**
   * Build tooltip HTML for a node (pure string builder).
   * Rendering/positioning is handled by window.CodeStructure.tooltip.
   * @param {object} d Node datum.
   * @returns {string} HTML string.
   */
  function buildTooltipHtml(d) {
    const esc = window.CodeGraphUI.escapeHtml;

    const lines =
      d.__displayLines ??
      d.lines ??
      d.loc ??
      d.size ??
      "?";

    const cx =
      d.__displayComplexity ??
      d.complexity ??
      d.cc ??
      ((d._inbound || 0) + (d._outbound || 0)) ??
      "?";

    const display = d.__displayLabel ? esc(d.__displayLabel) : esc(d.id);
    const t = esc(d.type || "file");

    const line = Number.isFinite(d.__startLine) ? d.__startLine : null;
    const file = d.__fileFromId || d.file || "";
    const url = buildNodeSourceUrl(d);

    const atLineHtml = (line && url)
      ? `<br><small>At: <a href="${esc(url)}" target="_blank" rel="noopener">${esc(String(file))}:${esc(String(line))}</a></small>`
      : (line ? `<br><small>At: ${esc(String(file))}:${esc(String(line))}</small>` : "");

    const idHtml = (d.__displayLabel && d.id && d.__displayLabel !== d.id)
      ? `<br><small>ID: ${esc(String(d.id))}</small>`
      : "";

    const fnDiag = (() => {
      if (!isFunctionNode(d)) return "";

      const inCalls = toSafeInt(d?._inCalls);
      const outCalls = toSafeInt(d?._outCalls);
      const exported = d?.exported === true ? "yes" : "no";
      const unused = d?._unused === true ? "yes" : "no";

      const callers = Array.isArray(d?._callers) ? d._callers : [];
      const callees = Array.isArray(d?._callees) ? d._callees : [];

      const topCallers = callers.slice(0, 5).map((x) => esc(shortIdLabel(x))).join(", ");
      const topCallees = callees.slice(0, 5).map((x) => esc(shortIdLabel(x))).join(", ");

      const callersHtml = callers.length
        ? `<br><small>Top callers: ${topCallers}</small>`
        : `<br><small>Top callers: (none)</small>`;

      const calleesHtml = callees.length
        ? `<br><small>Top callees: ${topCallees}</small>`
        : `<br><small>Top callees: (none)</small>`;

      return (
        `<br><small>Calls: in ${esc(String(inCalls))} / out ${esc(String(outCalls))}</small>` +
        `<br><small>Exported: ${esc(exported)} | Unused: ${esc(unused)}</small>` +
        callersHtml +
        calleesHtml
      );
    })();

    return (
      `<strong>${display}</strong>` +
      `<br><small>Type: ${t}</small>` +
      atLineHtml +
      idHtml +
      `<br><small>Lines: ${esc(lines)}</small>` +
      `<br><small>Complexity: ${esc(cx)}</small>` +
      fnDiag
    );
  }

  /**
   * Build a best-effort URL to open a node at its source location.
   * Uses the legacy CMS tooling route if available.
   *
   * Contract:
   * - If a node has `__startLine` and a resolvable file path, we create a URL
   *   including `file`, `highlight`, and `line`.
   * - If not, returns null.
   *
   * @param {object} d Node datum.
   * @returns {string|null} URL to open the source location, or null.
   */
  function buildNodeSourceUrl(d) {
    try {
      const file = d?.__fileFromId || d?.file || resolveFile(d);
      const line = Number.isFinite(d?.__startLine) ? d.__startLine : null;
      if (!file || !line) return null;

      const base = window.CMS_TOOLS_BASE || "/cms/_tools";
      const highlightId = encodeURIComponent(String(d?.id || ""));
      const url = `${base}/viewD3CodeNodes?file=${encodeURIComponent(String(file))}&highlight=${highlightId}&line=${encodeURIComponent(String(line))}`;
      return url;
    } catch {
      return null;
    }
  }

  /**
   * Make a short display label from a node id (best-effort).
   * @param {string} id Node id.
   * @returns {string} Short label.
   */
  function shortIdLabel(id) {
    const s = String(id || "");
    if (!s) return "";
    // Prefer the last path segment; keep function ids readable.
    const last = s.split("/").pop() || s;
    return last;
  }


  /**
   * Resolve the file path for a node datum (best-effort).
   * Used by legacy navigation.
   * @param {object} d Node datum.
   * @returns {string|null} Resolved file path or null.
   */
  function resolveFile(d) {
    const normalize = (p) => (p ? p.replace(/\\/g, "/") : null);

    if (d?.file) return normalize(d.file);
    if (typeof d?.id !== "string") return null;

    const id = normalize(d.id);
    if (!id) return null;

    const lower = id.toLowerCase();

    const looksLikeFile =
      /\.php$/.test(lower) ||
      lower.includes("app/") ||
      lower.includes("cms/") ||
      lower.includes("public/") ||
      lower.includes("modules/") ||
      lower.includes("config/") ||
      lower.includes("core/");

    return looksLikeFile ? id : null;
  }


  /**
   * Sets the stored state object for a given svgId.
   * Performs shallow merge with existing state.
   * @param {string} svgId
   * @param {object} state
   */
  function setState(svgId, state) {
    const store = getLegendFilterStore();
    store[svgId] = Object.assign(getState(svgId), state);
  }

  /**
   * Deep clones an object or array.
   * @param {object|array} obj
   * @returns {object|array}
   */
  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  /**
   * Counts elements in an array that satisfy a predicate.
   * @param {array} arr
   * @param {function} pred
   * @returns {number}
   */
  function countBy(arr, pred) {
    let count = 0;
    for (const el of arr) if (pred(el)) count++;
    return count;
  }

  /**
   * Determines if a node represents a function (contract-first).
   *
   * Preferred contract:
   * - CodeGraphData.normalize() hydrates `_isFunction`.
   *
   * Fallbacks:
   * - kind === "function"
   */
  function isFunctionNode(d) {
    if (!d) return false;
    if (typeof d._isFunction === "boolean") return d._isFunction;
    return String(d.kind || "") === "function";
  }

  /**
   * Determines if a function node is unused (contract-first).
   *
   * Preferred contract:
   * - CodeGraphData.normalize() hydrates `_isUnusedFunction`.
   *
   * Fallbacks:
   * - backend `_unused === true`
   */
  function isUnusedFunctionNode(d) {
    if (!isFunctionNode(d)) return false;
    if (typeof d._isUnusedFunction === "boolean") return d._isUnusedFunction;
    if (typeof d._unused === "boolean") return d._unused === true;
    return false;
  }

  /**
   * Determines if a node is a visitor handler (heuristic).
   * @param {object} d
   * @returns {boolean}
   */
  function isVisitorHandlerNode(d) {
    if (!d) return false;
    // Check _role or _framework properties
    if (d._role === "visitor-handler") return true;
    if (d._framework === "babel-traverse") return true;
    // Check name matches common Babel visitor keys
    const babelVisitorKeys = new Set([
      "Program", "Identifier", "FunctionDeclaration", "VariableDeclaration",
      "ExpressionStatement", "CallExpression", "MemberExpression", "Literal",
      "BlockStatement", "ReturnStatement", "IfStatement", "ForStatement",
      "WhileStatement", "ArrowFunctionExpression", "ObjectExpression"
    ]);
    if (d.name && babelVisitorKeys.has(d.name)) {
      // Check file contains 'parseAst' or 'parseast' (case insensitive)
      if (d.file && /parseast/i.test(d.file)) return true;
    }
    return false;
  }

  /**
   * Applies a preset configuration to a state object.
   * @param {object} state
   * @param {string} presetName
   */
  function applyPreset(state, presetName) {
    // Reset all to defaults first
    state.preset = presetName;
    state.showNodeGroups = {
      root: false,
      dir: false,
      code: false,
      doc: false,
      data: false,
      image: false,
    };
    state.visibleLinkTypes = {
      include: false,
      use: false,
      call: false,
      extends: false,
    };
    state.showFilesDirs = false;
    state.showFunctions = false;
    state.showUnused = false;
    state.unusedOnly = false;
    state.showVisitorHandlers = false;
    state.hideIsolates = false;

    switch (presetName) {
      case "architecture":
        state.showNodeGroups.root = true;
        state.showNodeGroups.dir = true;
        state.showNodeGroups.code = true;
        state.visibleLinkTypes.include = true;
        state.visibleLinkTypes.use = true;
        state.showFilesDirs = true;
        state.showFunctions = true;
        break;
      case "runtime":
        state.showNodeGroups.code = true;
        state.showNodeGroups.doc = true;
        state.visibleLinkTypes.call = true;
        state.showFilesDirs = true;
        state.showFunctions = true;
        state.showVisitorHandlers = true;
        break;
      case "cleanup":
        state.showNodeGroups.code = true;
        state.showUnused = true;
        state.unusedOnly = true;
        state.showFunctions = true;
        state.hideIsolates = true;
        break;
      case "debug":
        state.showNodeGroups.root = true;
        state.showNodeGroups.dir = true;
        state.showNodeGroups.code = true;
        state.showNodeGroups.doc = true;
        state.showNodeGroups.data = true;
        state.showNodeGroups.image = true;
        state.visibleLinkTypes.include = true;
        state.visibleLinkTypes.use = true;
        state.visibleLinkTypes.call = true;
        state.visibleLinkTypes.extends = true;
        state.showFilesDirs = true;
        state.showFunctions = true;
        state.showUnused = true;
        state.unusedOnly = false;
        state.showVisitorHandlers = true;
        state.hideIsolates = false;
        break;
      default:
        // unknown preset, fallback to architecture
        applyPreset(state, "architecture");
        break;
    }

    // unusedOnly implies showUnused
    if (state.unusedOnly) {
      state.showUnused = true;
    }
  }

  // --- New API function: combined Legend & Filter panel renderer ---

  /**
   * Builds a combined Legend & Filter panel UI into #legendFilterPanel.
   * Provides presets, interactive toggles for node groups, link types, filters.
   * Calls opts.applyFilters(state) on changes if provided.
   *
   * @param {string} svgId - SVG graph identifier
   * @param {Array} nodes - array of node objects
   * @param {Array} links - array of link objects
   * @param {object} opts - options object, may contain applyFilters(state) function
   */
  CodeGraphUI.buildLegendFilterPanel = function buildLegendFilterPanel(svgId, nodes, links, opts) {
    const container = document.getElementById("legendFilterPanel");
    if (!container) return;

    // Defensive clones to avoid mutation
    const nodesClone = Array.isArray(nodes) ? nodes.slice() : [];
    const linksClone = Array.isArray(links) ? links.slice() : [];
    opts = opts || {};

    // Optional direct callback integration (renderer can pass a function).
    const applyFn = (typeof opts.applyFilters === "function") ? opts.applyFilters : null;

    // Event-based integration (recommended): renderer can listen to
    // `codegraph:filters-changed` and apply state without passing functions.
    const emitEvent = (opts.emitEvent === false) ? false : true;

    function emitFiltersChanged(nextState) {
      if (!emitEvent) return;
      try {
        window.dispatchEvent(new CustomEvent("codegraph:filters-changed", {
          detail: { svgId, state: clone(nextState) }
        }));
      } catch {
        // ignore
      }
    }

    // Retrieve or initialize state
    const state = clone(getState(svgId));

    // Compute counts for display
    const totalFunctions = countBy(nodesClone, isFunctionNode);
    const totalUnusedFunctions = countBy(nodesClone, isUnusedFunctionNode);
    const totalVisitorHandlers = countBy(nodesClone, isVisitorHandlerNode);

    // Count links per type
    const linkTypeCounts = {};
    for (const l of linksClone) {
      if (!l.type) continue;
      linkTypeCounts[l.type] = (linkTypeCounts[l.type] || 0) + 1;
    }

    // Node groups to show as chips with labels and keys
    const nodeGroupKeys = ["root", "dir", "code", "doc", "data", "image"];
    const nodeGroupLabels = {
      root: "Root",
      dir: "Directory",
      code: "Code",
      doc: "Doc",
      data: "Data",
      image: "Image",
    };

    // Link types to show as chips with labels and keys
    const linkTypeKeys = ["include", "use", "call", "extends"];
    const linkTypeLabels = {
      include: "include",
      use: "use",
      call: "call",
      extends: "extends",
    };

    // Helper to update UI and apply filters
    function updateUI() {
      // Save state globally
      setState(svgId, clone(state));

      // Update all UI controls to reflect current state
      // Presets buttons
      const presetButtons = container.querySelectorAll(".preset-btn");
      presetButtons.forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.preset === state.preset);
      });

      // Node group chips
      nodeGroupKeys.forEach((key) => {
        const chip = container.querySelector(`.node-group-chip[data-key="${key}"]`);
        if (chip) chip.classList.toggle("active", !!state.showNodeGroups[key]);
      });

      // Link type chips
      linkTypeKeys.forEach((key) => {
        const chip = container.querySelector(`.link-type-chip[data-key="${key}"]`);
        if (chip) chip.classList.toggle("active", !!state.visibleLinkTypes[key]);
      });

      // Toggles
      container.querySelectorAll("input[type=checkbox]").forEach((input) => {
        const name = input.name;
        if (name in state) {
          input.checked = !!state[name];
        }
      });

      // Enforce unusedOnly implies showUnused
      if (state.unusedOnly && !state.showUnused) {
        state.showUnused = true;
      }

      // If unusedOnly is checked, ensure showUnused is also checked in UI
      const unusedOnlyInput = container.querySelector("input[name='unusedOnly']");
      const showUnusedInput = container.querySelector("input[name='showUnused']");
      if (unusedOnlyInput && showUnusedInput) {
        if (unusedOnlyInput.checked && !showUnusedInput.checked) {
          showUnusedInput.checked = true;
          state.showUnused = true;
        }
      }

      // Apply filters (two supported integrations):
      // 1) Direct callback: opts.applyFilters(state)
      // 2) Event-based:     window event "codegraph:filters-changed"
      const next = clone(state);

      if (applyFn) {
        applyFn(next);
      }

      emitFiltersChanged(next);

      // Note visibility: hide only when a direct callback is wired.
      const note = container.querySelector(".apply-filters-note");
      if (note) note.style.display = applyFn ? "none" : "block";
    }

    /**
     * Handles user interaction that changes the state.
     * @param {function} updater - function that modifies state
     */
    function onChange(updater) {
      updater(state);
      // If preset changed by user action, set to 'custom'
      if (state.preset !== "custom" && !updater.presetChange) {
        state.preset = "custom";
      }
      updateUI();
    }

    // Build HTML content with Bootstrap classes
    container.innerHTML = `
      <div class="card border-0 shadow-sm mb-3">
        <div class="card-header py-2">
          <div class="d-flex flex-wrap align-items-center gap-2">
            <div class="btn-group btn-group-sm" role="group" aria-label="Presets">
              <button type="button" class="btn btn-outline-primary preset-btn" data-preset="architecture" title="Architecture preset">Architecture</button>
              <button type="button" class="btn btn-outline-primary preset-btn" data-preset="runtime" title="Runtime preset">Runtime</button>
              <button type="button" class="btn btn-outline-primary preset-btn" data-preset="cleanup" title="Cleanup preset">Cleanup</button>
              <button type="button" class="btn btn-outline-primary preset-btn" data-preset="debug" title="Debug preset">Debug</button>
            </div>
            <button type="button" class="btn btn-sm btn-outline-secondary ms-auto reset-btn" title="Reset to Architecture preset">Reset</button>
          </div>
        </div>
        <div class="card-body py-2">
          <div class="mb-2">
            <strong>Node Groups:</strong>
            <div class="d-flex flex-wrap gap-2 mt-1">
              ${nodeGroupKeys.map((key) => {
                return `<div class="badge node-group-chip btn btn-sm btn-outline-secondary" role="button" data-key="${key}" title="${nodeGroupLabels[key]}">${nodeGroupLabels[key]}</div>`;
              }).join("")}
            </div>
          </div>
          <div class="mb-2">
            <strong>Link Types:</strong>
            <div class="d-flex flex-wrap gap-2 mt-1">
              ${linkTypeKeys.map((key) => {
                const count = linkTypeCounts[key] || 0;
                return `<div class="badge link-type-chip btn btn-sm btn-outline-secondary" role="button" data-key="${key}" title="${linkTypeLabels[key]} (${count})">${linkTypeLabels[key]} (${count})</div>`;
              }).join("")}
            </div>
          </div>
          <div class="mb-2">
            <strong>Filters:</strong>
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="showFilesDirs" name="showFilesDirs">
              <label class="form-check-label" for="showFilesDirs">Show files/dirs</label>
            </div>
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="showFunctions" name="showFunctions">
              <label class="form-check-label" for="showFunctions">Show functions</label>
            </div>
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="showUnused" name="showUnused">
              <label class="form-check-label" for="showUnused">Show unused <span class="badge bg-secondary">${totalUnusedFunctions}</span></label>
            </div>
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="unusedOnly" name="unusedOnly">
              <label class="form-check-label" for="unusedOnly">Unused only (functions)</label>
            </div>
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="showVisitorHandlers" name="showVisitorHandlers">
              <label class="form-check-label" for="showVisitorHandlers">Show visitor handlers <span class="badge bg-secondary">${totalVisitorHandlers}</span></label>
            </div>
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="hideIsolates" name="hideIsolates">
              <label class="form-check-label" for="hideIsolates">Hide isolates</label>
            </div>
          </div>
          <div class="mb-2 small text-muted">
            <strong>Counts:</strong> Total functions: <span class="badge bg-info">${totalFunctions}</span>,
            Unused functions: <span class="badge bg-secondary">${totalUnusedFunctions}</span>,
            Visitor handlers: <span class="badge bg-secondary">${totalVisitorHandlers}</span>
          </div>
          <div class="mb-2 small text-muted">
            <strong>Legend:</strong> Fill = node group; Tone = usage; Radius = complexity; Arrows = direction; Rings = clusters; <code>!</code> = unused
          </div>
          <div class="apply-filters-note alert alert-warning py-1 px-2 m-0 small" style="display:none;">
            <div><strong>Filter wiring missing.</strong> The panel updates state, but the renderer is not applying it yet.</div>
            <div class="mt-1">Integration options:</div>
            <ul class="mb-0">
              <li>Pass <code>opts.applyFilters(state)</code> when building the panel, or</li>
              <li>Listen to <code>window</code> event <code>codegraph:filters-changed</code> and apply <code>detail.state</code>.</li>
            </ul>
          </div>
        </div>
      </div>
    `;

    // Attach event listeners

    // Preset buttons
    container.querySelectorAll(".preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const preset = btn.dataset.preset;
        if (!preset) return;
        applyPreset(state, preset);
        updateUI();
      });
    });

    // Reset button
    const resetBtn = container.querySelector(".reset-btn");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        applyPreset(state, "architecture");
        updateUI();
      });
    }

    // Node group chips toggle
    nodeGroupKeys.forEach((key) => {
      const chip = container.querySelector(`.node-group-chip[data-key="${key}"]`);
      if (chip) {
        chip.style.cursor = "pointer";
        chip.addEventListener("click", () => {
          state.showNodeGroups[key] = !state.showNodeGroups[key];
          // Mark preset as custom
          state.preset = "custom";
          updateUI();
        });
      }
    });

    // Link type chips toggle
    linkTypeKeys.forEach((key) => {
      const chip = container.querySelector(`.link-type-chip[data-key="${key}"]`);
      if (chip) {
        chip.style.cursor = "pointer";
        chip.addEventListener("click", () => {
          state.visibleLinkTypes[key] = !state.visibleLinkTypes[key];
          // Mark preset as custom
          state.preset = "custom";
          updateUI();
        });
      }
    });

    // Toggle switches
    container.querySelectorAll("input[type=checkbox]").forEach((input) => {
      input.addEventListener("change", () => {
        const name = input.name;
        if (!(name in state)) return;
        const checked = input.checked;
        // Manage unusedOnly implies showUnused
        if (name === "unusedOnly") {
          state.unusedOnly = checked;
          if (checked) {
            state.showUnused = true;
          }
        } else if (name === "showUnused") {
          state.showUnused = checked;
          // If showUnused is turned off, forcibly turn off unusedOnly too
          if (!checked && state.unusedOnly) {
            state.unusedOnly = false;
            const unusedOnlyInput = container.querySelector("input[name='unusedOnly']");
            if (unusedOnlyInput) unusedOnlyInput.checked = false;
          }
        } else {
          state[name] = checked;
        }
        // Mark preset as custom
        state.preset = "custom";
        updateUI();
      });
    });

    // Initial UI update
    updateUI();
  };

  // --- Existing exported API functions ---

  CodeGraphUI.setupGraphFilters = function setupGraphFilters(svgId, metrics, nodeSel, linkSel) {
    const root = document.querySelector(`[data-graph-filter="${svgId}"]`);
    if (!root) return;

    const regexInput = root.querySelector('[data-filter="regex"]');
    const typeInput = root.querySelector('[data-filter="type"]');
    const clearBtn = root.querySelector('[data-filter="clear"]');
    const status = root.querySelector('[data-filter="status"]');

    if (!regexInput) return;

    function applyFilters() {
      const raw = regexInput.value.trim();
      const typeFilter = typeInput?.value || "";

      let regex = null;
      if (raw) {
        try {
          regex = new RegExp(raw, "i");
        } catch {
          if (status) {
            status.textContent = "Invalid regex";
            status.classList.add("text-danger");
          }
          return;
        }
      }

      const visibleLinks = new Set();

      linkSel.each(function (d) {
        let match = true;

        if (typeFilter) match = d.type === typeFilter;

        if (match && regex) {
          const haystack = `${d.source.id || d.source} ${d.target.id || d.target}`;
          match = regex.test(haystack);
        }

        d._visible = match;
        d3.select(this).style("opacity", match ? 0.9 : 0.05);
        if (match) visibleLinks.add(d);
      });

      let visibleNodeCount = 0;

      nodeSel.each(function (d) {
        let visible = true;

        if (regex) {
          const hay = `${d.id} ${d.label || ""} ${d.file || ""}`.toLowerCase();
          visible = regex.test(hay);
        }

        if (typeFilter) {
          const participates = [...visibleLinks].some((l) => l.source === d || l.target === d);
          visible = visible && participates;
        }

        d._visible = visible;
        if (visible) visibleNodeCount++;

        d3.select(this).style("opacity", visible ? 1 : 0.1);
      });

      if (status) {
        status.textContent =
          raw || typeFilter
            ? `Showing ${visibleNodeCount}/${(metrics.nodes || []).length}`
            : "";
        status.classList.remove("text-danger");
      }
    }

    regexInput.addEventListener("input", applyFilters);
    typeInput?.addEventListener("change", applyFilters);
    clearBtn?.addEventListener("click", () => {
      regexInput.value = "";
      if (typeInput) typeInput.value = "";
      applyFilters();
    });

    applyFilters();
  };

  CodeGraphUI.buildGraphLegend = function buildGraphLegend(svgId, nodes, links, nodeColors, linkColors, clusterColorScale) {
    // Early return if combined legend/filter panel exists to avoid duplicate UI
    if (document.getElementById("legendFilterPanel")) return;

    const root = document.querySelector(`[data-graph-legend="${svgId}"]`);
    if (!root) return;

    root.innerHTML = "";
    root.style.display = "flex";
    root.style.flexWrap = "wrap";
    root.style.gap = "12px";
    root.style.alignItems = "center";

    const presentTypes = new Set(nodes.map((n) => n.type || "file"));
    presentTypes.forEach((type) => {
      const chip = document.createElement("div");
      chip.style.display = "flex";
      chip.style.alignItems = "center";
      chip.style.gap = "4px";

      const dot = document.createElement("span");
      dot.style.width = "12px";
      dot.style.height = "12px";
      dot.style.borderRadius = "50%";
      dot.style.backgroundColor = nodeColors[type] || nodeColors.file;

      const label = document.createElement("span");
      label.className = "text-muted small";
      label.textContent = type;

      chip.appendChild(dot);
      chip.appendChild(label);
      root.appendChild(chip);
    });

    const typeSet = new Set(links.map((l) => l.type).filter(Boolean));
    typeSet.forEach((type) => {
      const wrap = document.createElement("div");
      wrap.style.display = "flex";
      wrap.style.alignItems = "center";
      wrap.style.gap = "4px";

      const bar = document.createElement("span");
      bar.style.width = "20px";
      bar.style.height = "4px";
      bar.style.borderRadius = "2px";
      bar.style.backgroundColor = linkColors[type] || linkColors.default;

      const label = document.createElement("span");
      label.className = "text-muted small";
      label.textContent = type;

      wrap.appendChild(bar);
      wrap.appendChild(label);
      root.appendChild(wrap);
    });

    const clusters = new Set(nodes.map((n) => n.clusterId));
    clusters.forEach((cid) => {
      const chip = document.createElement("div");
      chip.style.display = "flex";
      chip.style.alignItems = "center";
      chip.style.gap = "4px";

      const box = document.createElement("span");
      box.style.width = "14px";
      box.style.height = "10px";
      box.style.borderRadius = "2px";
      box.style.opacity = "0.3";
      box.style.backgroundColor = clusterColorScale(cid);

      const txt = document.createElement("span");
      txt.className = "text-muted small";
      txt.textContent = cid;

      chip.appendChild(box);
      chip.appendChild(txt);
      root.appendChild(chip);
    });
  };

  CodeGraphUI.buildGraphDiagnosticsPanel = function buildGraphDiagnosticsPanel(svgId, nodes, links, width, height) {
    const root = document.querySelector(`[data-graph-stats="${svgId}"]`);
    if (!root) return;

    const cx = width / 2;
    const cy = height / 2;

    const deg = new Map();
    nodes.forEach((n) => deg.set(n.id, { in: 0, out: 0 }));

    links.forEach((l) => {
      const sid = typeof l.source === "object" ? l.source.id : l.source;
      const tid = typeof l.target === "object" ? l.target.id : l.target;
      if (deg.has(sid)) deg.get(sid).out++;
      if (deg.has(tid)) deg.get(tid).in++;
    });

    const enriched = nodes.map((n) => {
      const d = deg.get(n.id) || { in: 0, out: 0 };
      const inbound = d.in;
      const outbound = d.out;
      const degree = inbound + outbound;

      const dist = Math.round(Math.hypot((n.x ?? cx) - cx, (n.y ?? cy) - cy));

      const rawComplexity = n.complexity != null ? n.complexity : (n.cc != null ? n.cc : null);
      const normComplexity = n._complexityScore != null ? Number(n._complexityScore.toFixed(2)) : null;
      const complexity = rawComplexity != null ? rawComplexity : normComplexity;

      let status = "normal";
      if (degree === 0) status = "isolated";
      else if (inbound === 0 && outbound > 0) status = "producer";
      else if (inbound > 0 && outbound === 0) status = "consumer";
      else if (degree >= 6) status = "hub";

      return { id: n.id, type: n.type, degree, inbound, outbound, complexity, distance: dist, status };
    });

    root.innerHTML = `
      <div class="card border-0 shadow-sm">
        <div class="card-header py-2">
          <div class="d-flex justify-content-between align-items-center">
            <span class="fw-semibold">Graph Diagnostics</span>
            <div class="small text-muted">nodes: ${nodes.length}</div>
          </div>
        </div>
        <div class="card-body p-2">
          <div class="d-flex gap-2 mb-2">
            <select class="form-select form-select-sm" data-diag-filter="status" style="max-width:150px;">
              <option value="">All statuses</option>
              <option value="isolated">🟥 Isolated</option>
              <option value="producer">🔵 Producer</option>
              <option value="consumer">🟢 Consumer</option>
              <option value="hub">🟣 Hub</option>
            </select>

            <select class="form-select form-select-sm" data-diag-filter="type" style="max-width:150px;">
              <option value="">All types</option>
              <option value="controller">controller</option>
              <option value="service">service</option>
              <option value="repository">repository</option>
              <option value="config">config</option>
              <option value="core">core</option>
              <option value="helper">helper</option>
              <option value="file">file</option>
            </select>
          </div>

          <div class="table-responsive">
            <table class="table table-sm table-hover mb-0" style="font-size: 12px;">
              <thead>
                <tr>
                  <th data-sort="id">File</th>
                  <th data-sort="type">Type</th>
                  <th data-sort="status">Status</th>
                  <th data-sort="degree">Deg</th>
                  <th data-sort="inbound">In</th>
                  <th data-sort="outbound">Out</th>
                  <th data-sort="complexity">Cx</th>
                  <th data-sort="distance">Dist</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    const tbody = root.querySelector("tbody");
    const sortState = { column: "distance", asc: false };

    const truncate = (s) => {
      if (!s) return "";
      if (s.length < 40) return s;
      return "…" + s.slice(-38);
    };

    const statusEmoji = (st) => ({ isolated: "🟥", producer: "🔵", consumer: "🟢", hub: "🟣" }[st] || "");

    function renderTable() {
      const statusFilter = root.querySelector('[data-diag-filter="status"]').value;
      const typeFilter = root.querySelector('[data-diag-filter="type"]').value;

      let rows = enriched.filter((r) => {
        if (statusFilter && r.status !== statusFilter) return false;
        if (typeFilter && r.type !== typeFilter) return false;
        return true;
      });

      rows.sort((a, b) => {
        const col = sortState.column;
        const av = a[col] ?? -Infinity;
        const bv = b[col] ?? -Infinity;
        if (av < bv) return sortState.asc ? -1 : 1;
        if (av > bv) return sortState.asc ? 1 : -1;
        return 0;
      });

      tbody.innerHTML = rows.map((r) => `
        <tr data-node="${escapeHtml(r.id)}">
          <td title="${escapeHtml(r.id)}">${escapeHtml(truncate(r.id))}</td>
          <td>${escapeHtml(r.type)}</td>
          <td>${statusEmoji(r.status)} ${escapeHtml(r.status)}</td>
          <td>${r.degree}</td>
          <td>${r.inbound}</td>
          <td>${r.outbound}</td>
          <td>${r.complexity ?? "–"}</td>
          <td>${r.distance}</td>
        </tr>
      `).join("");
    }

    tbody.addEventListener("click", (e) => {
      const tr = e.target.closest("tr");
      if (!tr) return;
      const id = tr.getAttribute("data-node");
      if (!id) return;
      window.highlightGraphNode(svgId, id);
    });

    root.querySelectorAll("th[data-sort]").forEach((th) => {
      th.style.cursor = "pointer";
      th.addEventListener("click", () => {
        const col = th.getAttribute("data-sort");
        if (sortState.column === col) sortState.asc = !sortState.asc;
        else { sortState.column = col; sortState.asc = true; }
        renderTable();
      });
    });

    root.querySelectorAll("[data-diag-filter]").forEach((sel) => {
      sel.addEventListener("change", renderTable);
    });

    renderTable();
  };

  /* ====================================================================== */
  /* Legend & Filter -> D3 wiring (event-driven)                              */
  /* ====================================================================== */

  /**
   * Attach an event listener that applies legend/filter state to D3 selections.
   *
   * Why this lives in ui.js
   * ----------------------
   * The renderer (d3_codeStructure.js) should stay focused on building layers,
   * simulation, and selections. All DOM/state wiring for filters belongs here.
   *
   * Integration contract
   * --------------------
   * - `buildLegendFilterPanel()` emits `codegraph:filters-changed` events.
   * - This function listens and updates `display` on node/link selections.
   * - Call this once per render-run (it de-dupes per svgId automatically).
   *
   * @param {string} svgId
   * @param {Array} nodes
   * @param {Array} links
   * @param {{ nodeShapeSel:any, labelSel:any, linkSel:any, unusedBadgeSel?:any }} sels
   */
  CodeGraphUI.attachLegendFilterWiring = function attachLegendFilterWiring(svgId, nodes, links, sels) {
    const id = String(svgId || "");
    if (!id) return;

    const nodeShapeSel = sels?.nodeShapeSel;
    const labelSel = sels?.labelSel;
    const linkSel = sels?.linkSel;
    const unusedBadgeSel = sels?.unusedBadgeSel;

    if (!nodeShapeSel || !labelSel || !linkSel) {
      console.warn("CodeGraphUI.attachLegendFilterWiring: missing selections", { svgId, sels });
      return;
    }

    // De-dupe listeners across re-renders.
    try {
      if (!window.__codeGraphFilterListeners) window.__codeGraphFilterListeners = Object.create(null);
      const prev = window.__codeGraphFilterListeners[id];
      if (prev) window.removeEventListener("codegraph:filters-changed", prev);
    } catch {
      // ignore
    }

    // Pre-compute degrees once per apply.
    const computeDegrees = () => {
      const deg = new Map();
      for (const n of nodes || []) deg.set(String(n?.id || ""), { in: 0, out: 0 });
      for (const l of links || []) {
        const sid = typeof l?.source === "object" ? l.source?.id : l?.source;
        const tid = typeof l?.target === "object" ? l.target?.id : l?.target;
        const sId = String(sid || "");
        const tId = String(tid || "");
        if (deg.has(sId)) deg.get(sId).out++;
        if (deg.has(tId)) deg.get(tId).in++;
      }
      return deg;
    };

    const isIsolateNode = (d, deg) => {
      const k = String(d?.id || "");
      const x = deg.get(k);
      if (!x) return false;
      return (Number(x.in || 0) + Number(x.out || 0)) === 0;
    };

    const applyFiltersFromState = (state) => {
      const s = state && typeof state === "object" ? state : Object.create(null);

      // Defaults (architecture-first)
      const showNodeGroups = s.showNodeGroups && typeof s.showNodeGroups === "object" ? s.showNodeGroups : Object.create(null);
      const visibleLinkTypes = s.visibleLinkTypes && typeof s.visibleLinkTypes === "object" ? s.visibleLinkTypes : Object.create(null);

      const showFilesDirs = (typeof s.showFilesDirs === "boolean") ? s.showFilesDirs : true;
      const showFunctions = (typeof s.showFunctions === "boolean") ? s.showFunctions : true;
      const showUnused = (typeof s.showUnused === "boolean") ? s.showUnused : false;
      const unusedOnly = (typeof s.unusedOnly === "boolean") ? s.unusedOnly : false;
      const showVisitorHandlers = (typeof s.showVisitorHandlers === "boolean") ? s.showVisitorHandlers : true;
      const hideIsolates = (typeof s.hideIsolates === "boolean") ? s.hideIsolates : false;

      // unusedOnly implies showUnused
      const effShowUnused = unusedOnly ? true : showUnused;

      const deg = computeDegrees();

      // First compute hidden node ids (so links can be hidden consistently).
      const hidden = new Set();

      for (const n of nodes || []) {
        const nid = String(n?.id || "");
        if (!nid) continue;

        const kind = String(n?.kind || "");
        const group = String(n?.group || "").trim();

        // Group filter (canonical contract)
        if (group && Object.prototype.hasOwnProperty.call(showNodeGroups, group) && !showNodeGroups[group]) {
          hidden.add(nid);
          continue;
        }

        // High-level category toggles
        if (!showFunctions && isFunctionNode(n)) {
          hidden.add(nid);
          continue;
        }

        if (!showFilesDirs && !isFunctionNode(n)) {
          // Treat everything non-function as "file/dir" content.
          hidden.add(nid);
          continue;
        }

        // Unused filter
        if (!effShowUnused && isUnusedFunctionNode(n)) {
          hidden.add(nid);
          continue;
        }

        if (unusedOnly && isFunctionNode(n) && !isUnusedFunctionNode(n)) {
          hidden.add(nid);
          continue;
        }

        // Visitor handler filter (heuristic)
        if (!showVisitorHandlers && isFunctionNode(n) && isVisitorHandlerNode(n)) {
          hidden.add(nid);
          continue;
        }

        // Hide isolates (degree 0)
        if (hideIsolates && isIsolateNode(n, deg)) {
          hidden.add(nid);
          continue;
        }
      }

      const nodeDisplay = (d) => (hidden.has(String(d?.id || "")) ? "none" : null);

      // Apply node visibility
      nodeShapeSel.style("display", nodeDisplay);
      labelSel.style("display", nodeDisplay);

      // Badge follows node visibility + unused logic
      if (unusedBadgeSel) {
        unusedBadgeSel.style("display", (d) => {
          const nid = String(d?.id || "");
          if (hidden.has(nid)) return "none";
          // When effShowUnused is false, badges should not show.
          if (!effShowUnused) return "none";
          return isUnusedFunctionNode(d) ? "block" : "none";
        });
      }

      // Apply link visibility
      linkSel.style("display", (l) => {
        const sid = typeof l?.source === "object" ? l.source?.id : l?.source;
        const tid = typeof l?.target === "object" ? l.target?.id : l?.target;
        const sId = String(sid || "");
        const tId = String(tid || "");

        if (hidden.has(sId) || hidden.has(tId)) return "none";

        const ty = String(l?.type || "use");
        if (Object.prototype.hasOwnProperty.call(visibleLinkTypes, ty) && !visibleLinkTypes[ty]) return "none";

        return null;
      });
    };

    const onFiltersChanged = (ev) => {
      try {
        const detail = ev?.detail;
        if (!detail || String(detail.svgId || "") !== id) return;
        applyFiltersFromState(detail.state);
      } catch {
        // ignore
      }
    };

    // Register listener (and remember it for de-dupe)
    try {
      if (!window.__codeGraphFilterListeners) window.__codeGraphFilterListeners = Object.create(null);
      window.__codeGraphFilterListeners[id] = onFiltersChanged;
      window.addEventListener("codegraph:filters-changed", onFiltersChanged);
    } catch {
      // ignore
    }

    // Apply immediately using stored state (so the first render matches the panel).
    try {
      const initial = getState(id);
      applyFiltersFromState(initial);
    } catch {
      // ignore
    }
  };

  window.CodeGraphUI = CodeGraphUI;
})();
// public/assets/js/codeGraph/ui.js
/**
 * Graph UI Widgets (UI-side)
 * =========================
 *
 * This file is intentionally kept as ONE physical file for stability.
 * Internally it is split into **pseudo-modules** (multiple IIFEs) so each
 * responsibility stays isolated:
 *
 * - ui.core        : tiny shared helpers
 * - ui.state       : per-svgId legend/filter state store
 * - ui.predicates  : node classification helpers (function/unused/visitor)
 * - ui.tooltip     : tooltip HTML builder + source URL helper
 * - ui.presets     : preset application (architecture/runtime/cleanup/debug)
 * - ui.panel       : combined Legend & Filter panel DOM builder
 * - ui.legacy      : legacy widgets (regex/type filter bar + old legend)
 * - ui.diagnostics : diagnostics table
 * - ui.wiring      : event-driven Legend/Filter -> D3 selection wiring
 *
 * Exposes: window.CodeGraphUI
 */

/* ========================================================================== */
/* ui.core                                                                    */
/* ========================================================================== */
(function () {
  "use strict";

  const CodeGraphUI = (window.CodeGraphUI ||= {});

  /** Minimal HTML escape for safe templating. */
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  /** Deep clone for JSON-serializable state objects. */
  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  /** Count elements in an array that satisfy a predicate. */
  function countBy(arr, pred) {
    let count = 0;
    for (const el of arr || []) if (pred(el)) count++;
    return count;
  }

  /** Safe int conversion for tooltip diagnostics. */
  function toSafeInt(x) {
    const n = Number(x);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }

  CodeGraphUI.escapeHtml = escapeHtml;
  CodeGraphUI.clone = clone;
  CodeGraphUI.countBy = countBy;
  CodeGraphUI.toSafeInt = toSafeInt;
})();

/* ========================================================================== */
/* ui.state                                                                   */
/* ========================================================================== */
(function () {
  "use strict";

  const CodeGraphUI = window.CodeGraphUI;

  /** Returns the global store object for legend/filter state. */
  function getLegendFilterStore() {
    if (!window.__codeGraphLegendFilterState) window.__codeGraphLegendFilterState = {};
    return window.__codeGraphLegendFilterState;
  }

  /**
   * Retrieves the stored state object for a given svgId.
   * Initializes defaults if none exists.
   */
  function getState(svgId) {
    const store = getLegendFilterStore();
    const id = String(svgId || "");
    if (!id) return {};

    if (!store[id]) {
      store[id] = {
        preset: "architecture",
        showNodeGroups: {
          root: true,
          dir: true,
          code: true,
          doc: true,
          data: true,
          image: true
        },
        visibleLinkTypes: {
          include: true,
          use: true,
          call: true,
          extends: true
        },
        showFilesDirs: true,
        showFunctions: true,
        showUnused: false,
        unusedOnly: false,
        showVisitorHandlers: true,
        hideIsolates: false
      };
    }

    return store[id];
  }

  /** Sets state for svgId via shallow merge onto existing defaults. */
  function setState(svgId, state) {
    const store = getLegendFilterStore();
    const id = String(svgId || "");
    if (!id) return;
    store[id] = Object.assign(getState(id), state);
  }

  CodeGraphUI.getState = getState;
  CodeGraphUI.setState = setState;
})();

/* ========================================================================== */
/* ui.predicates                                                              */
/* ========================================================================== */
(function () {
  "use strict";

  const CodeGraphUI = window.CodeGraphUI;

  /** Is this node a function node? (contract-first) */
  function isFunctionNode(d) {
    if (!d) return false;
    if (typeof d._isFunction === "boolean") return d._isFunction;
    return String(d.kind || "") === "function";
  }

  /** Is this function node unused? (contract-first) */
  function isUnusedFunctionNode(d) {
    if (!isFunctionNode(d)) return false;
    if (typeof d._isUnusedFunction === "boolean") return d._isUnusedFunction;
    if (typeof d._unused === "boolean") return d._unused === true;
    return false;
  }

  /** Heuristic: visitor handler nodes (Babel traverse handlers etc.). */
  function isVisitorHandlerNode(d) {
    if (!d) return false;

    // Strong signals:
    if (d._role === "visitor-handler") return true;
    if (d._framework === "babel-traverse") return true;

    // Name matches common Babel visitor keys and file looks like parseAst.
    const name = String(d.name || "");
    if (!name) return false;

    const babelVisitorKeys = new Set([
      "Program",
      "Identifier",
      "FunctionDeclaration",
      "VariableDeclaration",
      "ExpressionStatement",
      "CallExpression",
      "MemberExpression",
      "Literal",
      "BlockStatement",
      "ReturnStatement",
      "IfStatement",
      "ForStatement",
      "WhileStatement",
      "ArrowFunctionExpression",
      "ObjectExpression"
    ]);

    if (!babelVisitorKeys.has(name)) return false;

    const file = String(d.file || "");
    return /parseast/i.test(file);
  }

  CodeGraphUI.isFunctionNode = isFunctionNode;
  CodeGraphUI.isUnusedFunctionNode = isUnusedFunctionNode;
  CodeGraphUI.isVisitorHandlerNode = isVisitorHandlerNode;
})();

/* ========================================================================== */
/* ui.tooltip                                                                 */
/* ========================================================================== */
(function () {
  "use strict";

  const CodeGraphUI = window.CodeGraphUI;

  function shortIdLabel(id) {
    const s = String(id || "");
    if (!s) return "";
    return s.split("/").pop() || s;
  }

  function resolveFile(d) {
    const normalize = (p) => (p ? String(p).replace(/\\/g, "/") : null);

    if (d?.file) return normalize(d.file);
    if (typeof d?.id !== "string") return null;

    const id = normalize(d.id);
    if (!id) return null;

    const lower = id.toLowerCase();
    const looksLikeFile =
      /\.php$/.test(lower) ||
      lower.includes("app/") ||
      lower.includes("cms/") ||
      lower.includes("public/") ||
      lower.includes("modules/") ||
      lower.includes("config/") ||
      lower.includes("core/");

    return looksLikeFile ? id : null;
  }

  function buildNodeSourceUrl(d) {
    try {
      const file = d?.__fileFromId || d?.file || resolveFile(d);
      const line = Number.isFinite(d?.__startLine) ? d.__startLine : null;
      if (!file || !line) return null;

      const base = window.CMS_TOOLS_BASE || "/cms/_tools";
      const highlightId = encodeURIComponent(String(d?.id || ""));
      return `${base}/viewD3CodeNodes?file=${encodeURIComponent(String(file))}&highlight=${highlightId}&line=${encodeURIComponent(String(line))}`;
    } catch {
      return null;
    }
  }

  /**
   * Build tooltip HTML for a node (pure string builder).
   * Rendering/positioning is handled by window.CodeStructure.tooltip.
   */
  function buildTooltipHtml(d) {
    const esc = CodeGraphUI.escapeHtml;
    const toSafeInt = CodeGraphUI.toSafeInt;

    const lines = d.__displayLines ?? d.lines ?? d.loc ?? d.size ?? "?";

    const cx =
      d.__displayComplexity ??
      d.complexity ??
      d.cc ??
      ((d._inbound || 0) + (d._outbound || 0)) ??
      "?";

    const display = d.__displayLabel ? esc(d.__displayLabel) : esc(d.id);
    const t = esc(d.type || "file");

    const line = Number.isFinite(d.__startLine) ? d.__startLine : null;
    const file = d.__fileFromId || d.file || "";
    const url = buildNodeSourceUrl(d);

    const atLineHtml = (line && url)
      ? `<br><small>At: <a href="${esc(url)}" target="_blank" rel="noopener">${esc(String(file))}:${esc(String(line))}</a></small>`
      : (line ? `<br><small>At: ${esc(String(file))}:${esc(String(line))}</small>` : "");

    const idHtml = (d.__displayLabel && d.id && d.__displayLabel !== d.id)
      ? `<br><small>ID: ${esc(String(d.id))}</small>`
      : "";

    const fnDiag = (() => {
      if (!CodeGraphUI.isFunctionNode(d)) return "";

      const inCalls = toSafeInt(d?._inCalls);
      const outCalls = toSafeInt(d?._outCalls);
      const exported = d?.exported === true ? "yes" : "no";
      const unused = d?._unused === true ? "yes" : "no";

      const callers = Array.isArray(d?._callers) ? d._callers : [];
      const callees = Array.isArray(d?._callees) ? d._callees : [];

      const topCallers = callers.slice(0, 5).map((x) => esc(shortIdLabel(x))).join(", ");
      const topCallees = callees.slice(0, 5).map((x) => esc(shortIdLabel(x))).join(", ");

      const callersHtml = callers.length
        ? `<br><small>Top callers: ${topCallers}</small>`
        : `<br><small>Top callers: (none)</small>`;

      const calleesHtml = callees.length
        ? `<br><small>Top callees: ${topCallees}</small>`
        : `<br><small>Top callees: (none)</small>`;

      return (
        `<br><small>Calls: in ${esc(String(inCalls))} / out ${esc(String(outCalls))}</small>` +
        `<br><small>Exported: ${esc(exported)} | Unused: ${esc(unused)}</small>` +
        callersHtml +
        calleesHtml
      );
    })();

    return (
      `<strong>${display}</strong>` +
      `<br><small>Type: ${t}</small>` +
      atLineHtml +
      idHtml +
      `<br><small>Lines: ${esc(lines)}</small>` +
      `<br><small>Complexity: ${esc(cx)}</small>` +
      fnDiag
    );
  }

  CodeGraphUI.shortIdLabel = shortIdLabel;
  CodeGraphUI.resolveFile = resolveFile;
  CodeGraphUI.buildNodeSourceUrl = buildNodeSourceUrl;
  CodeGraphUI.buildTooltipHtml = buildTooltipHtml;

  // IMPORTANT: d3_codeStructure.js previously called `buildTooltipHtml(d)` as a free function.
  // Keep a stable bridge so tooltips work even if the renderer wasn't updated yet.
  // (This is intentionally tiny and well-scoped.)
  if (typeof window.buildTooltipHtml !== "function") {
    window.buildTooltipHtml = buildTooltipHtml;
  }
})();

/* ========================================================================== */
/* ui.presets                                                                 */
/* ========================================================================== */
(function () {
  "use strict";

  const CodeGraphUI = window.CodeGraphUI;

  /** Apply a named preset to the given state object (in-place). */
  function applyPreset(state, presetName) {
    // Reset to defaults first
    state.preset = presetName;

    state.showNodeGroups = { root: false, dir: false, code: false, doc: false, data: false, image: false };
    state.visibleLinkTypes = { include: false, use: false, call: false, extends: false };

    state.showFilesDirs = false;
    state.showFunctions = false;
    state.showUnused = false;
    state.unusedOnly = false;
    state.showVisitorHandlers = false;
    state.hideIsolates = false;

    switch (presetName) {
      case "architecture":
        state.showNodeGroups.root = true;
        state.showNodeGroups.dir = true;
        state.showNodeGroups.code = true;
        state.visibleLinkTypes.include = true;
        state.visibleLinkTypes.use = true;
        state.showFilesDirs = true;
        state.showFunctions = true;
        break;

      case "runtime":
        state.showNodeGroups.code = true;
        state.showNodeGroups.doc = true;
        state.visibleLinkTypes.call = true;
        state.showFilesDirs = true;
        state.showFunctions = true;
        state.showVisitorHandlers = true;
        break;

      case "cleanup":
        state.showNodeGroups.code = true;
        state.showUnused = true;
        state.unusedOnly = true;
        state.showFunctions = true;
        state.hideIsolates = true;
        break;

      case "debug":
        state.showNodeGroups.root = true;
        state.showNodeGroups.dir = true;
        state.showNodeGroups.code = true;
        state.showNodeGroups.doc = true;
        state.showNodeGroups.data = true;
        state.showNodeGroups.image = true;
        state.visibleLinkTypes.include = true;
        state.visibleLinkTypes.use = true;
        state.visibleLinkTypes.call = true;
        state.visibleLinkTypes.extends = true;
        state.showFilesDirs = true;
        state.showFunctions = true;
        state.showUnused = true;
        state.unusedOnly = false;
        state.showVisitorHandlers = true;
        state.hideIsolates = false;
        break;

      default:
        // unknown preset => fallback
        applyPreset(state, "architecture");
        return;
    }

    // unusedOnly implies showUnused
    if (state.unusedOnly) state.showUnused = true;
  }

  CodeGraphUI.applyPreset = applyPreset;
})();

/* ========================================================================== */
/* ui.panel                                                                   */
/* ========================================================================== */
(function () {
  "use strict";

  const CodeGraphUI = window.CodeGraphUI;

  /**
   * Builds a combined Legend & Filter panel UI into #legendFilterPanel.
   * Emits `codegraph:filters-changed` on updates.
   */
  CodeGraphUI.buildLegendFilterPanel = function buildLegendFilterPanel(svgId, nodes, links, opts) {
    const container = document.getElementById("legendFilterPanel");
    if (!container) return;

    const id = String(svgId || "");
    if (!id) return;

    // Defensive clones to avoid mutation
    const nodesClone = Array.isArray(nodes) ? nodes.slice() : [];
    const linksClone = Array.isArray(links) ? links.slice() : [];
    opts = opts || {};

    // Optional direct callback integration
    const applyFn = (typeof opts.applyFilters === "function") ? opts.applyFilters : null;

    // Event-based integration (recommended)
    const emitEvent = (opts.emitEvent === false) ? false : true;

    function emitFiltersChanged(nextState) {
      if (!emitEvent) return;
      try {
        window.dispatchEvent(new CustomEvent("codegraph:filters-changed", {
          detail: { svgId: id, state: CodeGraphUI.clone(nextState) }
        }));
      } catch {
        // ignore
      }
    }

    // Retrieve or initialize state
    const state = CodeGraphUI.clone(CodeGraphUI.getState(id));

    // Compute counts for display
    const totalFunctions = CodeGraphUI.countBy(nodesClone, CodeGraphUI.isFunctionNode);
    const totalUnusedFunctions = CodeGraphUI.countBy(nodesClone, CodeGraphUI.isUnusedFunctionNode);
    const totalVisitorHandlers = CodeGraphUI.countBy(nodesClone, CodeGraphUI.isVisitorHandlerNode);

    // Count links per type
    const linkTypeCounts = {};
    for (const l of linksClone) {
      if (!l?.type) continue;
      linkTypeCounts[l.type] = (linkTypeCounts[l.type] || 0) + 1;
    }

    const nodeGroupKeys = ["root", "dir", "code", "doc", "data", "image"];
    const nodeGroupLabels = { root: "Root", dir: "Directory", code: "Code", doc: "Doc", data: "Data", image: "Image" };

    const linkTypeKeys = ["include", "use", "call", "extends"];
    const linkTypeLabels = { include: "include", use: "use", call: "call", extends: "extends" };

    function updateUI() {
      // Persist state
      CodeGraphUI.setState(id, CodeGraphUI.clone(state));

      // Preset buttons
      container.querySelectorAll(".preset-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.preset === state.preset);
      });

      // Chips
      nodeGroupKeys.forEach((key) => {
        const chip = container.querySelector(`.node-group-chip[data-key="${key}"]`);
        if (chip) chip.classList.toggle("active", !!state.showNodeGroups[key]);
      });

      linkTypeKeys.forEach((key) => {
        const chip = container.querySelector(`.link-type-chip[data-key="${key}"]`);
        if (chip) chip.classList.toggle("active", !!state.visibleLinkTypes[key]);
      });

      // Switches
      container.querySelectorAll("input[type=checkbox]").forEach((input) => {
        const name = input.name;
        if (name in state) input.checked = !!state[name];
      });

      // Enforce unusedOnly => showUnused
      if (state.unusedOnly && !state.showUnused) state.showUnused = true;

      const unusedOnlyInput = container.querySelector("input[name='unusedOnly']");
      const showUnusedInput = container.querySelector("input[name='showUnused']");
      if (unusedOnlyInput && showUnusedInput) {
        if (unusedOnlyInput.checked && !showUnusedInput.checked) {
          showUnusedInput.checked = true;
          state.showUnused = true;
        }
      }

      const next = CodeGraphUI.clone(state);

      if (applyFn) applyFn(next);
      emitFiltersChanged(next);

      // Only show note when neither callback nor event is effectively used.
      const note = container.querySelector(".apply-filters-note");
      if (note) note.style.display = applyFn ? "none" : "block";
    }

    // Build HTML
    container.innerHTML = `
      <div class="card border-0 shadow-sm mb-3">
        <div class="card-header py-2">
          <div class="d-flex flex-wrap align-items-center gap-2">
            <div class="btn-group btn-group-sm" role="group" aria-label="Presets">
              <button type="button" class="btn btn-outline-primary preset-btn" data-preset="architecture" title="Architecture preset">Architecture</button>
              <button type="button" class="btn btn-outline-primary preset-btn" data-preset="runtime" title="Runtime preset">Runtime</button>
              <button type="button" class="btn btn-outline-primary preset-btn" data-preset="cleanup" title="Cleanup preset">Cleanup</button>
              <button type="button" class="btn btn-outline-primary preset-btn" data-preset="debug" title="Debug preset">Debug</button>
            </div>
            <button type="button" class="btn btn-sm btn-outline-secondary ms-auto reset-btn" title="Reset to Architecture preset">Reset</button>
          </div>
        </div>
        <div class="card-body py-2">
          <div class="mb-2">
            <strong>Node Groups:</strong>
            <div class="d-flex flex-wrap gap-2 mt-1">
              ${nodeGroupKeys.map((key) =>
                `<div class="badge node-group-chip btn btn-sm btn-outline-secondary" role="button" data-key="${key}" title="${nodeGroupLabels[key]}">${nodeGroupLabels[key]}</div>`
              ).join("")}
            </div>
          </div>

          <div class="mb-2">
            <strong>Link Types:</strong>
            <div class="d-flex flex-wrap gap-2 mt-1">
              ${linkTypeKeys.map((key) => {
                const count = linkTypeCounts[key] || 0;
                return `<div class="badge link-type-chip btn btn-sm btn-outline-secondary" role="button" data-key="${key}" title="${linkTypeLabels[key]} (${count})">${linkTypeLabels[key]} (${count})</div>`;
              }).join("")}
            </div>
          </div>

          <div class="mb-2">
            <strong>Filters:</strong>
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="showFilesDirs" name="showFilesDirs">
              <label class="form-check-label" for="showFilesDirs">Show files/dirs</label>
            </div>
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="showFunctions" name="showFunctions">
              <label class="form-check-label" for="showFunctions">Show functions</label>
            </div>
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="showUnused" name="showUnused">
              <label class="form-check-label" for="showUnused">Show unused <span class="badge bg-secondary">${totalUnusedFunctions}</span></label>
            </div>
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="unusedOnly" name="unusedOnly">
              <label class="form-check-label" for="unusedOnly">Unused only (functions)</label>
            </div>
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="showVisitorHandlers" name="showVisitorHandlers">
              <label class="form-check-label" for="showVisitorHandlers">Show visitor handlers <span class="badge bg-secondary">${totalVisitorHandlers}</span></label>
            </div>
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="hideIsolates" name="hideIsolates">
              <label class="form-check-label" for="hideIsolates">Hide isolates</label>
            </div>
          </div>

          <div class="mb-2 small text-muted">
            <strong>Counts:</strong>
            Total functions: <span class="badge bg-info">${totalFunctions}</span>,
            Unused functions: <span class="badge bg-secondary">${totalUnusedFunctions}</span>,
            Visitor handlers: <span class="badge bg-secondary">${totalVisitorHandlers}</span>
          </div>

          <div class="mb-2 small text-muted">
            <strong>Legend:</strong>
            Fill = node group; Tone = usage; Radius = complexity; Arrows = direction; Rings = clusters; <code>!</code> = unused
          </div>

          <div class="apply-filters-note alert alert-warning py-1 px-2 m-0 small" style="display:none;">
            <div><strong>Filter wiring missing.</strong> The panel updates state, but the renderer is not applying it yet.</div>
            <div class="mt-1">Integration options:</div>
            <ul class="mb-0">
              <li>Pass <code>opts.applyFilters(state)</code> when building the panel, or</li>
              <li>Listen to <code>window</code> event <code>codegraph:filters-changed</code> and apply <code>detail.state</code>.</li>
            </ul>
          </div>
        </div>
      </div>
    `;

    // Presets
    container.querySelectorAll(".preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const preset = btn.dataset.preset;
        if (!preset) return;
        CodeGraphUI.applyPreset(state, preset);
        updateUI();
      });
    });

    const resetBtn = container.querySelector(".reset-btn");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        CodeGraphUI.applyPreset(state, "architecture");
        updateUI();
      });
    }

    // Node group chips
    nodeGroupKeys.forEach((key) => {
      const chip = container.querySelector(`.node-group-chip[data-key="${key}"]`);
      if (!chip) return;
      chip.style.cursor = "pointer";
      chip.addEventListener("click", () => {
        state.showNodeGroups[key] = !state.showNodeGroups[key];
        state.preset = "custom";
        updateUI();
      });
    });

    // Link type chips
    linkTypeKeys.forEach((key) => {
      const chip = container.querySelector(`.link-type-chip[data-key="${key}"]`);
      if (!chip) return;
      chip.style.cursor = "pointer";
      chip.addEventListener("click", () => {
        state.visibleLinkTypes[key] = !state.visibleLinkTypes[key];
        state.preset = "custom";
        updateUI();
      });
    });

    // Switches
    container.querySelectorAll("input[type=checkbox]").forEach((input) => {
      input.addEventListener("change", () => {
        const name = input.name;
        if (!(name in state)) return;

        const checked = input.checked;

        if (name === "unusedOnly") {
          state.unusedOnly = checked;
          if (checked) state.showUnused = true;
        } else if (name === "showUnused") {
          state.showUnused = checked;
          if (!checked && state.unusedOnly) {
            state.unusedOnly = false;
            const uo = container.querySelector("input[name='unusedOnly']");
            if (uo) uo.checked = false;
          }
        } else {
          state[name] = checked;
        }

        state.preset = "custom";
        updateUI();
      });
    });

    // Initial sync + emit
    updateUI();
  };


/* ====================================================================== */
/* Graph header helpers                                                   */
/* ====================================================================== */

/**
 * Update the small graph header above the graph panel.
 *
 * Accepts either `appName` (preferred, human readable) or `appId`.
 *
 * Example output:
 *   "Graph · My App · ƒ 128 · LOC 14,532"
 *
 * @param {{ appName?: string, appId?: string, functions?: number, loc?: number }} info
 */
CodeGraphUI.updateGraphHeader = function updateGraphHeader(info) {
  const el = document.getElementById("graphInfoHeader");
  if (!el) return;

  const appName = String(info?.appName ?? info?.appId ?? "").trim();//#TODO: name oder id 
  const fnRaw = Number(info?.functions);
  const locRaw = Number(info?.loc);

  const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString() : "?");

  const parts = ["Graph"];
  if (appName) parts.push(appName);
  if (Number.isFinite(fnRaw)) parts.push(`ƒ ${fmt(fnRaw)}`);
  if (Number.isFinite(locRaw)) parts.push(`LOC ${fmt(locRaw)}`);

  el.textContent = parts.join(" · ");
};


})();



/* ========================================================================== */
/* ui.diagnostics                                                            */
/* ========================================================================== */
(function () {
  "use strict";

  const CodeGraphUI = window.CodeGraphUI;

  CodeGraphUI.buildGraphDiagnosticsPanel = function buildGraphDiagnosticsPanel(svgId, nodes, links, width, height) {
    const root = document.querySelector(`[data-graph-stats="${svgId}"]`);
    if (!root) return;

    const cx = width / 2;
    const cy = height / 2;

    const deg = new Map();
    (nodes || []).forEach((n) => deg.set(n.id, { in: 0, out: 0 }));

    (links || []).forEach((l) => {
      const sid = typeof l.source === "object" ? l.source.id : l.source;
      const tid = typeof l.target === "object" ? l.target.id : l.target;
      if (deg.has(sid)) deg.get(sid).out++;
      if (deg.has(tid)) deg.get(tid).in++;
    });

    const enriched = (nodes || []).map((n) => {
      const d = deg.get(n.id) || { in: 0, out: 0 };
      const inbound = d.in;
      const outbound = d.out;
      const degree = inbound + outbound;

      const dist = Math.round(Math.hypot((n.x ?? cx) - cx, (n.y ?? cy) - cy));

      const rawComplexity = n.complexity != null ? n.complexity : (n.cc != null ? n.cc : null);
      const normComplexity = n._complexityScore != null ? Number(n._complexityScore.toFixed(2)) : null;
      const complexity = rawComplexity != null ? rawComplexity : normComplexity;

      let status = "normal";
      if (degree === 0) status = "isolated";
      else if (inbound === 0 && outbound > 0) status = "producer";
      else if (inbound > 0 && outbound === 0) status = "consumer";
      else if (degree >= 6) status = "hub";

      return { id: n.id, type: n.type, degree, inbound, outbound, complexity, distance: dist, status };
    });

    root.innerHTML = `
      <div class="card border-0 shadow-sm">
        <div class="card-header py-2">
          <div class="d-flex justify-content-between align-items-center">
            <span class="fw-semibold">Graph Diagnostics</span>
            <div class="small text-muted">nodes: ${(nodes || []).length}</div>
          </div>
        </div>
        <div class="card-body p-2">
          <div class="d-flex gap-2 mb-2">
            <select class="form-select form-select-sm" data-diag-filter="status" style="max-width:150px;">
              <option value="">All statuses</option>
              <option value="isolated">🟥 Isolated</option>
              <option value="producer">🔵 Producer</option>
              <option value="consumer">🟢 Consumer</option>
              <option value="hub">🟣 Hub</option>
            </select>

            <select class="form-select form-select-sm" data-diag-filter="type" style="max-width:150px;">
              <option value="">All types</option>
              <option value="controller">controller</option>
              <option value="service">service</option>
              <option value="repository">repository</option>
              <option value="config">config</option>
              <option value="core">core</option>
              <option value="helper">helper</option>
              <option value="file">file</option>
            </select>
          </div>

          <div class="table-responsive">
            <table class="table table-sm table-hover mb-0" style="font-size: 12px;">
              <thead>
                <tr>
                  <th data-sort="id">File</th>
                  <th data-sort="type">Type</th>
                  <th data-sort="status">Status</th>
                  <th data-sort="degree">Deg</th>
                  <th data-sort="inbound">In</th>
                  <th data-sort="outbound">Out</th>
                  <th data-sort="complexity">Cx</th>
                  <th data-sort="distance">Dist</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    const tbody = root.querySelector("tbody");
    const sortState = { column: "distance", asc: false };

    const truncate = (s) => {
      if (!s) return "";
      if (s.length < 40) return s;
      return "…" + s.slice(-38);
    };

    const statusEmoji = (st) => ({ isolated: "🟥", producer: "🔵", consumer: "🟢", hub: "🟣" }[st] || "");

    function renderTable() {
      const statusFilter = root.querySelector('[data-diag-filter="status"]').value;
      const typeFilter = root.querySelector('[data-diag-filter="type"]').value;

      let rows = enriched.filter((r) => {
        if (statusFilter && r.status !== statusFilter) return false;
        if (typeFilter && r.type !== typeFilter) return false;
        return true;
      });

      rows.sort((a, b) => {
        const col = sortState.column;
        const av = a[col] ?? -Infinity;
        const bv = b[col] ?? -Infinity;
        if (av < bv) return sortState.asc ? -1 : 1;
        if (av > bv) return sortState.asc ? 1 : -1;
        return 0;
      });

      tbody.innerHTML = rows.map((r) => `
        <tr data-node="${CodeGraphUI.escapeHtml(r.id)}">
          <td title="${CodeGraphUI.escapeHtml(r.id)}">${CodeGraphUI.escapeHtml(truncate(r.id))}</td>
          <td>${CodeGraphUI.escapeHtml(r.type)}</td>
          <td>${statusEmoji(r.status)} ${CodeGraphUI.escapeHtml(r.status)}</td>
          <td>${r.degree}</td>
          <td>${r.inbound}</td>
          <td>${r.outbound}</td>
          <td>${r.complexity ?? "–"}</td>
          <td>${r.distance}</td>
        </tr>
      `).join("");
    }

    tbody.addEventListener("click", (e) => {
      const tr = e.target.closest("tr");
      if (!tr) return;
      const id = tr.getAttribute("data-node");
      if (!id) return;
      window.highlightGraphNode(svgId, id);
    });

    root.querySelectorAll("th[data-sort]").forEach((th) => {
      th.style.cursor = "pointer";
      th.addEventListener("click", () => {
        const col = th.getAttribute("data-sort");
        if (sortState.column === col) sortState.asc = !sortState.asc;
        else { sortState.column = col; sortState.asc = true; }
        renderTable();
      });
    });

    root.querySelectorAll("[data-diag-filter]").forEach((sel) => {
      sel.addEventListener("change", renderTable);
    });

    renderTable();
  };
})();

/* ========================================================================== */
/* ui.wiring                                                                  */
/* ========================================================================== */
(function () {
  "use strict";

  const CodeGraphUI = window.CodeGraphUI;

  /**
   * Attach an event listener that applies legend/filter state to D3 selections.
   * De-dupes per svgId automatically.
   */
  CodeGraphUI.attachLegendFilterWiring = function attachLegendFilterWiring(svgId, nodes, links, sels) {
    const id = String(svgId || "");
    if (!id) return;

    const nodeShapeSel = sels?.nodeShapeSel;
    const labelSel = sels?.labelSel;
    const linkSel = sels?.linkSel;
    const unusedBadgeSel = sels?.unusedBadgeSel;

    if (!nodeShapeSel || !labelSel || !linkSel) {
      console.warn("CodeGraphUI.attachLegendFilterWiring: missing selections", { svgId, sels });
      return;
    }

    // De-dupe listeners across re-renders.
    try {
      if (!window.__codeGraphFilterListeners) window.__codeGraphFilterListeners = Object.create(null);
      const prev = window.__codeGraphFilterListeners[id];
      if (prev) window.removeEventListener("codegraph:filters-changed", prev);
    } catch {
      // ignore
    }

    const computeDegrees = () => {
      const deg = new Map();
      for (const n of nodes || []) deg.set(String(n?.id || ""), { in: 0, out: 0 });
      for (const l of links || []) {
        const sid = typeof l?.source === "object" ? l.source?.id : l?.source;
        const tid = typeof l?.target === "object" ? l.target?.id : l?.target;
        const sId = String(sid || "");
        const tId = String(tid || "");
        if (deg.has(sId)) deg.get(sId).out++;
        if (deg.has(tId)) deg.get(tId).in++;
      }
      return deg;
    };

    const isIsolateNode = (d, deg) => {
      const k = String(d?.id || "");
      const x = deg.get(k);
      if (!x) return false;
      return (Number(x.in || 0) + Number(x.out || 0)) === 0;
    };

    const applyFiltersFromState = (state) => {
      const s = state && typeof state === "object" ? state : Object.create(null);

      const showNodeGroups = s.showNodeGroups && typeof s.showNodeGroups === "object" ? s.showNodeGroups : Object.create(null);
      const visibleLinkTypes = s.visibleLinkTypes && typeof s.visibleLinkTypes === "object" ? s.visibleLinkTypes : Object.create(null);

      const showFilesDirs = (typeof s.showFilesDirs === "boolean") ? s.showFilesDirs : true;
      const showFunctions = (typeof s.showFunctions === "boolean") ? s.showFunctions : true;
      const showUnused = (typeof s.showUnused === "boolean") ? s.showUnused : false;
      const unusedOnly = (typeof s.unusedOnly === "boolean") ? s.unusedOnly : false;
      const showVisitorHandlers = (typeof s.showVisitorHandlers === "boolean") ? s.showVisitorHandlers : true;
      const hideIsolates = (typeof s.hideIsolates === "boolean") ? s.hideIsolates : false;

      // unusedOnly implies showUnused
      const effShowUnused = unusedOnly ? true : showUnused;

      const deg = computeDegrees();

      const hidden = new Set();

      for (const n of nodes || []) {
        const nid = String(n?.id || "");
        if (!nid) continue;

        const group = String(n?.group || "").trim();

        // Group filter (canonical)
        if (group && Object.prototype.hasOwnProperty.call(showNodeGroups, group) && !showNodeGroups[group]) {
          hidden.add(nid);
          continue;
        }

        // High-level category toggles
        if (!showFunctions && CodeGraphUI.isFunctionNode(n)) {
          hidden.add(nid);
          continue;
        }

        if (!showFilesDirs && !CodeGraphUI.isFunctionNode(n)) {
          hidden.add(nid);
          continue;
        }

        // Unused filter
        if (!effShowUnused && CodeGraphUI.isUnusedFunctionNode(n)) {
          hidden.add(nid);
          continue;
        }

        if (unusedOnly && CodeGraphUI.isFunctionNode(n) && !CodeGraphUI.isUnusedFunctionNode(n)) {
          hidden.add(nid);
          continue;
        }

        // Visitor handler filter
        if (!showVisitorHandlers && CodeGraphUI.isFunctionNode(n) && CodeGraphUI.isVisitorHandlerNode(n)) {
          hidden.add(nid);
          continue;
        }

        // Hide isolates
        if (hideIsolates && isIsolateNode(n, deg)) {
          hidden.add(nid);
          continue;
        }
      }

      const nodeDisplay = (d) => (hidden.has(String(d?.id || "")) ? "none" : null);

      nodeShapeSel.style("display", nodeDisplay);
      labelSel.style("display", nodeDisplay);

      if (unusedBadgeSel) {
        unusedBadgeSel.style("display", (d) => {
          const nid = String(d?.id || "");
          if (hidden.has(nid)) return "none";
          if (!effShowUnused) return "none";
          return CodeGraphUI.isUnusedFunctionNode(d) ? "block" : "none";
        });
      }

      linkSel.style("display", (l) => {
        const sid = typeof l?.source === "object" ? l.source?.id : l?.source;
        const tid = typeof l?.target === "object" ? l.target?.id : l?.target;
        const sId = String(sid || "");
        const tId = String(tid || "");

        if (hidden.has(sId) || hidden.has(tId)) return "none";

        const ty = String(l?.type || "use");
        if (Object.prototype.hasOwnProperty.call(visibleLinkTypes, ty) && !visibleLinkTypes[ty]) return "none";

        return null;
      });
    };

    const onFiltersChanged = (ev) => {
      try {
        const detail = ev?.detail;
        if (!detail || String(detail.svgId || "") !== id) return;
        applyFiltersFromState(detail.state);
      } catch {
        // ignore
      }
    };

    // Register listener
    try {
      if (!window.__codeGraphFilterListeners) window.__codeGraphFilterListeners = Object.create(null);
      window.__codeGraphFilterListeners[id] = onFiltersChanged;
      window.addEventListener("codegraph:filters-changed", onFiltersChanged);
    } catch {
      // ignore
    }

    // Apply immediately using stored state
    try {
      applyFiltersFromState(CodeGraphUI.getState(id));
    } catch {
      // ignore
    }
  };
})();