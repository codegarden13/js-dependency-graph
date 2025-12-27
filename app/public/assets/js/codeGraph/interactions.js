// public/assets/js/interactions.js
/**
 * Graph Interactions (UI-side)
 * ===========================
 * Centralizes click/drag suppression and selection dispatch.
 *
 * Exposes: window.CodeGraphInteractions
 */

(function () {
  "use strict";

  const CodeGraphInteractions = {};

  /**
   * Attach drag + click behavior to node selections.
   *
   * Required:
   * - nodeSel: d3 selection of node <g>
   * - simulation: d3 forceSimulation instance
   *
   * Options:
   * - thresholdPx: drag movement threshold for click suppression (default: 3)
   * - onSelected(node): async/sync selection callback (e.g. info panel + README)
   * - legacyRedirect(node): optional legacy redirect handler
   * - enableLegacyRedirect: boolean flag gate
   */
  CodeGraphInteractions.attachNodeInteractions = function attachNodeInteractions(nodeSel, options) {
    const simulation = options?.simulation;
    if (!simulation) throw new Error("attachNodeInteractions requires { simulation }");

    const thresholdPx = Number.isFinite(options?.thresholdPx) ? options.thresholdPx : 3;
    const thresholdSq = thresholdPx * thresholdPx;

    let dragMoved = false;
    let dragStart = null;

    function dragStarted(event, d) {
      simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    }

    function dragged(event, d) {
      d.fx = event.x;
      d.fy = event.y;
    }

    function dragEnded(event, d) {
      d.fx = null;
      d.fy = null;
      setTimeout(() => simulation.alphaTarget(0), 300);
    }

    nodeSel
      .on("click", async (event, d) => {
        // Suppress click after drag-like interaction
        if (dragMoved) {
          dragMoved = false;
          dragStart = null;
          return;
        }

        // Primary selection integration (README + info panel)
        if (typeof options?.onSelected === "function") {
          try {
            await options.onSelected(d, event);
          } catch (e) {
            console.warn("onSelected failed:", e);
          }
        }

        // Optional legacy redirect behavior
        if (options?.enableLegacyRedirect === true && typeof options?.legacyRedirect === "function") {
          try {
            options.legacyRedirect(d, event);
          } catch (e) {
            console.warn("legacyRedirect failed:", e);
          }
        }
      })
      .call(
        d3.drag()
          .on("start", (event, d) => {
            dragMoved = false;
            dragStart = { x: event.x, y: event.y };
            dragStarted(event, d);
          })
          .on("drag", (event, d) => {
            if (dragStart) {
              const dx = event.x - dragStart.x;
              const dy = event.y - dragStart.y;
              if ((dx * dx + dy * dy) > thresholdSq) dragMoved = true;
            }
            dragged(event, d);
          })
          .on("end", (event, d) => {
            dragEnded(event, d);
          })
      );
  };

  window.CodeGraphInteractions = CodeGraphInteractions;
})();