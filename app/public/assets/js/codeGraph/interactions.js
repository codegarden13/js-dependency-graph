// public/assets/js/codeGraph/interactions.js
/**
 * Graph Interactions (UI-side)
 * ===========================
 * Centralizes click/drag suppression and selection dispatch.
 *
 * Exposes: window.CodeGraphInteractions
 */

// ESM: no global namespace. Keep everything as explicit exports.

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
   * - onSelected(node, event): async/sync selection callback (e.g. info panel + README)
   * - legacyRedirect(node, event): optional legacy redirect handler
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

    function dragEnded() {
      // Let the simulation settle back down.
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
            // Release the fixed position.
            d.fx = null;
            d.fy = null;
            dragEnded(event, d);
          })
      );
  };

  /* ====================================================================== */
  /* Highlight ring                                                          */
  /* ====================================================================== */

  /**
   * Draw a highlight ring around the selected node.
   * @param {object} d Node datum.
   * @param {any} layer d3 selection of the highlight layer.
   */
  function drawHighlight(d, layer) {
    if (!layer) return;
    layer.selectAll("*").remove();

    const rBase = d?._lineScore != null ? 10 + 20 * d._lineScore : 20;

    layer.append("circle")
      .datum(d)
      .attr("cx", d?.x)
      .attr("cy", d?.y)
      .attr("r", rBase)
      .attr("fill", "none")
      .attr("stroke", "#FFD166")
      .attr("stroke-width", 4)
      .attr("pointer-events", "none")
      .attr("opacity", 0.95);
  }

  /**
   * Keep highlight ring anchored to its datum across simulation ticks.
   * @param {any} layer d3 selection of the highlight layer.
   */
  function anchorHighlight(layer) {
    if (!layer) return;
    const ring = layer.select("circle");
    if (ring.empty()) return;
    const d = ring.datum();
    ring.attr("cx", d?.x).attr("cy", d?.y);
  }

  CodeGraphInteractions.drawHighlight = drawHighlight;
  CodeGraphInteractions.anchorHighlight = anchorHighlight;

export { CodeGraphInteractions };
export default CodeGraphInteractions;