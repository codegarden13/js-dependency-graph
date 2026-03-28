"use strict";

const SVG_NS = "http://www.w3.org/2000/svg";

export const GRAPH_ZOOM_MIN = 0.4;
export const GRAPH_ZOOM_MAX = 2.2;
export const GRAPH_ZOOM_DEFAULT = 1;

function clampZoomScale(value) {
  const scale = Number(value);
  if (!Number.isFinite(scale)) return GRAPH_ZOOM_DEFAULT;
  return Math.max(GRAPH_ZOOM_MIN, Math.min(GRAPH_ZOOM_MAX, scale));
}

function wrapSvgChildren(svg) {
  const svgNode = svg?.node?.();
  if (!svgNode) return null;

  const zoomLayerNode = document.createElementNS(SVG_NS, "g");
  zoomLayerNode.setAttribute("class", "svgViewZoomLayer");

  const children = Array.from(svgNode.childNodes)
    .filter((node) => node?.nodeType === Node.ELEMENT_NODE);

  svgNode.appendChild(zoomLayerNode);

  for (const child of children) {
    zoomLayerNode.appendChild(child);
  }

  return d3.select(zoomLayerNode);
}

export function installSvgViewZoom(svg) {
  const zoomLayer = wrapSvgChildren(svg);
  if (!zoomLayer) {
    return {
      getZoom: () => GRAPH_ZOOM_DEFAULT,
      setZoom: () => GRAPH_ZOOM_DEFAULT,
      destroy() { }
    };
  }

  svg
    .style("cursor", "grab")
    .style("user-select", "none");

  let currentTransform = d3.zoomIdentity.scale(GRAPH_ZOOM_DEFAULT);

  const zoom = d3.zoom()
    .scaleExtent([GRAPH_ZOOM_MIN, GRAPH_ZOOM_MAX])
    .filter((event) => {
      const type = String(event?.type || "");
      if (type === "wheel" || type === "dblclick") return false;
      if (type.startsWith("touch")) return false;
      return !event?.button;
    })
    .on("start", (event) => {
      if (String(event?.sourceEvent?.type || "") === "mousedown") {
        svg.style("cursor", "grabbing");
      }
    })
    .on("zoom", (event) => {
      currentTransform = event.transform;
      zoomLayer.attr("transform", currentTransform);
    })
    .on("end", () => {
      svg.style("cursor", "grab");
    });

  svg.call(zoom);
  svg.call(zoom.transform, currentTransform);

  function getZoom() {
    const scale = Number(currentTransform?.k);
    return Number.isFinite(scale) ? scale : GRAPH_ZOOM_DEFAULT;
  }

  function setZoom(value) {
    const nextScale = clampZoomScale(value);
    svg.call(zoom.scaleTo, nextScale);
    return nextScale;
  }

  function destroy() {
    try { svg.on(".zoom", null); } catch { }
    try { svg.style("cursor", null).style("user-select", null); } catch { }
  }

  return {
    getZoom,
    setZoom,
    destroy
  };
}
