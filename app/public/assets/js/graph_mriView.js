"use strict";

import { installSvgViewZoom } from "./svgViewZoom.js";

const CODE_FILE_EXT_RE = /\.(js|mjs|cjs|ts|tsx|jsx)$/i;

function coerceNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizePath(value) {
  return normalizeText(value).replace(/^\.\//, "");
}

function basename(value) {
  const file = normalizePath(value);
  if (!file) return "(unknown)";
  const parts = file.split("/");
  return parts[parts.length - 1] || file;
}

function hasCoordinateSpread(nodes) {
  if (!nodes.length) return false;

  const xExtent = d3.extent(nodes, (d) => d.rawX);
  const yExtent = d3.extent(nodes, (d) => d.rawY);

  const xSpread = Math.abs((xExtent[1] ?? 0) - (xExtent[0] ?? 0));
  const ySpread = Math.abs((yExtent[1] ?? 0) - (yExtent[0] ?? 0));

  return xSpread > 1 || ySpread > 1;
}

function renderEmpty(svg, width, height, message) {
  svg.selectAll("*").remove();
  svg
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", width)
    .attr("height", height);

  svg.append("text")
    .attr("x", width / 2)
    .attr("y", height / 2)
    .attr("text-anchor", "middle")
    .attr("fill", "#6c757d")
    .style("font-size", "14px")
    .text(message || "No MRI data found");
}

function getSvgSize(svg) {
  return {
    width: svg.node()?.clientWidth || 1000,
    height: 700,
  };
}

function isLinkRow(row) {
  return normalizeText(row?.source) && normalizeText(row?.target);
}

function isCodeFileNodeRow(row) {
  const file = normalizePath(row?.file || row?.id || row?.label);
  return Boolean(file && CODE_FILE_EXT_RE.test(file));
}

function buildGraph(rows) {
  const rawNodes = rows.filter((row) => !isLinkRow(row) && isCodeFileNodeRow(row));

  const nodes = rawNodes.map((row) => {
    const id = normalizeText(row?.id || row?.file || row?.label);
    const file = normalizePath(row?.file || row?.id || row?.label);

    return {
      id,
      file,
      label: basename(file),
      lines: coerceNumber(row?.lines, 0),
      complexity: coerceNumber(row?.complexity, 0),
      hotspotScore: coerceNumber(row?.hotspotScore, 0),
      changeFreq: coerceNumber(row?.changeFreq, 0),
      layer: normalizeText(row?.layer),
      rawX: coerceNumber(row?.x, NaN),
      rawY: coerceNumber(row?.y, NaN),
      fanOut: 0,
    };
  });

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));

  const links = rows
    .filter(isLinkRow)
    .map((row) => ({
      source: normalizeText(row?.source),
      target: normalizeText(row?.target),
      value: Math.max(1, coerceNumber(row?.value, 1)),
    }))
    .filter((link) => nodeMap.has(link.source) && nodeMap.has(link.target));

  for (const link of links) {
    const sourceNode = nodeMap.get(link.source);
    if (sourceNode) sourceNode.fanOut += 1;
  }

  return { nodes, links };
}

function positionNodes(graph, width, height) {
  let layoutName = "Force layout";
  let layerLabels = [];
  // -------------------------------------------------------
  // 1) Prefer explicit coordinates if present
  // -------------------------------------------------------
  const nodesWithCoords = graph.nodes.filter(
    (node) => Number.isFinite(node.rawX) && Number.isFinite(node.rawY)
  );

  if (nodesWithCoords.length >= 3 && hasCoordinateSpread(nodesWithCoords)) {
    const xExtent = d3.extent(nodesWithCoords, (d) => d.rawX);
    const yExtent = d3.extent(nodesWithCoords, (d) => d.rawY);

    const x = d3.scaleLinear()
      .domain(xExtent)
      .range([60, width - 60]);

    const y = d3.scaleLinear()
      .domain(yExtent)
      .range([70, height - 50]);

    for (const node of graph.nodes) {
      node.x = Number.isFinite(node.rawX) ? x(node.rawX) : width / 2;
      node.y = Number.isFinite(node.rawY) ? y(node.rawY) : height / 2;
    }

    layoutName = "CSV coordinates";
    return { layoutName, layerLabels };
  }

  // -------------------------------------------------------
  // 2) Layer layout (if layers exist)
  // -------------------------------------------------------

  const layerGroups = d3.group(
    graph.nodes.filter((n) => n.layer),
    (n) => n.layer
  );

  if (layerGroups.size >= 2) {
    const layerOrder = ["config", "helper", "helpers", "service", "services", "core", "route", "routes", "controller", "controllers"];
    const layers = Array.from(layerGroups.keys()).sort((a, b) => {
      const aIndex = layerOrder.findIndex((name) => a.toLowerCase().includes(name));
      const bIndex = layerOrder.findIndex((name) => b.toLowerCase().includes(name));
      const safeA = aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex;
      const safeB = bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex;
      return safeA - safeB || a.localeCompare(b);
    });

    const yScale = d3.scalePoint()
      .domain(layers)
      .range([80, height - 80])
      .padding(0.5);

    layerLabels = layers.map((layer) => ({
      name: layer,
      y: yScale(layer),
    }));

    for (const layer of layers) {
      const nodes = (layerGroups.get(layer) || [])
        .slice()
        .sort((a, b) => d3.descending(importanceScore(a), importanceScore(b)));

      const xScale = d3.scalePoint()
        .domain(nodes.map((n) => n.id))
        .range([90, width - 90])
        .padding(0.9);

      for (const node of nodes) {
        node.x = xScale(node.id);
        node.y = yScale(layer);
      }
    }

    // nodes without layer go to bottom row
    const unlayered = graph.nodes.filter((n) => !n.layer);
    if (unlayered.length) {
      const xScale = d3.scalePoint()
        .domain(unlayered.map((n) => n.id))
        .range([90, width - 90])
        .padding(0.6);

      const y = height - 60;

      for (const node of unlayered) {
        node.x = xScale(node.id);
        node.y = y;
      }
    }

    layoutName = "Layer layout";
    return { layoutName, layerLabels };
  }

  // -------------------------------------------------------
  // 3) Force layout fallback
  // -------------------------------------------------------

  const simulation = d3.forceSimulation(graph.nodes)
    .force("link", d3.forceLink(graph.links).id((d) => d.id).distance(140))
    .force("charge", d3.forceManyBody().strength(-320))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collision", d3.forceCollide((d) => sizeScale(graph.nodes)(d.lines) + 12))
    .stop();

  for (let i = 0; i < 300; i += 1) simulation.tick();

  layoutName = "Force layout";
  return { layoutName, layerLabels };
}

function sizeScale(nodes) {
  return d3.scaleSqrt()
    .domain([0, d3.max(nodes, (d) => d.lines) || 1])
    .range([5, 30]);
}

function hotspotScale(nodes) {
  return d3.scaleSequential(d3.interpolateYlOrRd)
    .domain([0, d3.max(nodes, (d) => d.hotspotScore) || 1]);
}

function fanOutScale(nodes) {
  return d3.scaleLinear()
    .domain([0, d3.max(nodes, (d) => d.fanOut || 0) || 1])
    .range([1, 6]);
}

function haloScale(nodes) {
  return d3.scaleLinear()
    .domain([0, d3.max(nodes, (d) => d.changeFreq || 0) || 1])
    .range([0, 15]);
}

function importanceScore(node) {
  return (
    node.hotspotScore * 5
    + node.changeFreq * 2
    + node.complexity * 1.5
    + node.lines * 0.03
  );
}

function renderGraph(svg, graph, width, height, file) {
  svg.selectAll("*").remove();
  svg
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width", width)
    .attr("height", height);

  const layoutInfo = positionNodes(graph, width, height) || {};
  const layoutName = layoutInfo.layoutName || "unknown";
  const layerLabels = layoutInfo.layerLabels || [];

  const size = sizeScale(graph.nodes);
  const hotspotColor = hotspotScale(graph.nodes);
  const strokeWidth = fanOutScale(graph.nodes);
  const halo = haloScale(graph.nodes);
  const topLabelNodes = graph.nodes
    .slice()
    .sort((a, b) => d3.descending(importanceScore(a), importanceScore(b)))
    .slice(0, 20);

  // -------------------------------------------------
  // Star-label layout
  // All leader lines point roughly in one direction
  // (default: upper-left). Labels are stacked on the
  // left side of the SVG.
  // Change STAR_ANGLE_DEG to rotate the star rays.
  // -------------------------------------------------
  const centerX = width / 2;
  const centerY = height / 2;

  const STAR_ANGLE_DEG = 150; // <-- adjust this to rotate the star direction
  const STAR_ANGLE = (STAR_ANGLE_DEG * Math.PI) / 180;

  const LABEL_LEFT_MARGIN = 22;
  const LABEL_PADDING_Y = 16;

  const radialLabels = topLabelNodes.map((node) => {
    const text = node.label;
    const projectedY = node.y + Math.sin(STAR_ANGLE) * 60;

    return {
      node,
      w: text.length * 6.5,
      h: 14,
      targetY: Math.max(28, Math.min(height - 24, projectedY)),
    };
  });

  // Keep labels vertically ordered by their source-module position.
  // Then relax overlaps while staying close to the targetY, so the left label
  // column still semantically matches the graph structure.
  radialLabels.sort((a, b) => d3.ascending(a.targetY, b.targetY));

  for (const label of radialLabels) {
    label.x = LABEL_LEFT_MARGIN;
    label.y = label.targetY;
    label.anchor = "start";
  }

  // forward pass: enforce minimum spacing top -> bottom
  for (let i = 0; i < radialLabels.length; i += 1) {
    const prev = radialLabels[i - 1];
    const current = radialLabels[i];

    if (!prev) {
      current.y = Math.max(28, current.y);
      continue;
    }

    current.y = Math.max(current.y, prev.y + LABEL_PADDING_Y);
  }

  // backward pass: enforce minimum spacing bottom -> top
  for (let i = radialLabels.length - 1; i >= 0; i -= 1) {
    const next = radialLabels[i + 1];
    const current = radialLabels[i];

    if (!next) {
      current.y = Math.min(height - 24, current.y);
      continue;
    }

    current.y = Math.min(current.y, next.y - LABEL_PADDING_Y);
  }

  // final clamp and light attraction back toward targetY so the ordering stays
  // readable but visually closer to the corresponding node cluster.
  for (const label of radialLabels) {
    label.y = Math.max(28, Math.min(height - 24, (label.y + label.targetY) / 2));
  }

  const gLinks = svg.append("g");
  const gHalos = svg.append("g");
  const gNodes = svg.append("g");
  const gLeaderLines = svg.append("g");
  const gLabels = svg.append("g");

  // -------------------------------------------------
  // Layer labels (if layer layout used)
  // -------------------------------------------------

  if (layerLabels.length) {
    const gLayers = svg.append("g");

    gLayers.selectAll("text")
      .data(layerLabels)
      .enter()
      .append("text")
      .attr("x", 8)
      .attr("y", (d) => d.y)
      .style("font-size", "11px")
      .style("font-weight", "700")
      .style("fill", "#475569")
      .style("dominant-baseline", "middle")
      .text((d) => d.name);
  }

  gLinks
    .attr("stroke", "#94a3b8")
    .attr("stroke-opacity", 0.3)
    .selectAll("line")
    .data(graph.links)
    .enter()
    .append("line")
    .attr("x1", (d) => d.source.x)
    .attr("y1", (d) => d.source.y)
    .attr("x2", (d) => d.target.x)
    .attr("y2", (d) => d.target.y)
    .attr("stroke-width", (d) => Math.sqrt(d.value));

  gHalos
    .selectAll("circle")
    .data(graph.nodes)
    .enter()
    .append("circle")
    .attr("class", "halo")
    .attr("cx", (d) => d.x)
    .attr("cy", (d) => d.y)
    .attr("r", (d) => size(d.lines) + halo(d.changeFreq))
    .attr("fill", "none")
    .attr("stroke", "#ef4444")
    .attr("stroke-opacity", 0.15)
    .attr("stroke-width", 8);

  const node = gNodes
    .selectAll("circle")
    .data(graph.nodes)
    .enter()
    .append("circle")
    .attr("cx", (d) => d.x)
    .attr("cy", (d) => d.y)
    .attr("r", (d) => size(d.lines))
    .attr("fill", (d) => hotspotColor(d.hotspotScore))
    .attr("stroke", "#1f2937")
    .attr("stroke-width", (d) => strokeWidth(d.fanOut || 0));

  node.append("title").text((d) => [
    d.file,
    `lines: ${d.lines}`,
    `complexity: ${d.complexity}`,
    `hotspotScore: ${d.hotspotScore}`,
    `changeFreq: ${d.changeFreq}`,
    `fanOut: ${d.fanOut}`,
  ].join("\n"));

  gLeaderLines
    .attr("stroke", "rgba(31, 41, 55, 0.35)")
    .attr("stroke-width", 1)
    .selectAll("line")
    .data(radialLabels)
    .enter()
    .append("line")
    .attr("x1", (d) => d.node.x)
    .attr("y1", (d) => d.node.y)
    .attr("x2", (d) => d.x - 6)
    .attr("y2", (d) => d.y);

  gLabels
    .selectAll("text")
    .data(radialLabels)
    .enter()
    .append("text")
    .attr("x", (d) => d.x)
    .attr("y", (d) => d.y)
    .attr("text-anchor", (d) => d.anchor)
    .style("font-size", "10px")
    .style("font-weight", "600")
    .style("paint-order", "stroke")
    .style("stroke", "rgba(255,255,255,0.95)")
    .style("stroke-width", "3px")
    .style("stroke-linejoin", "round")
    .style("pointer-events", "none")
    .style("dominant-baseline", "middle")
    .text((d) => d.node.label);

  svg.append("text")
    .attr("x", 24)
    .attr("y", 24)
    .style("font-size", "14px")
    .style("font-weight", "700")
    .text("Architecture MRI");

  svg.append("text")
    .attr("x", 24)
    .attr("y", 42)
    .style("font-size", "11px")
    .style("fill", "#6c757d")
    .text(file);

  // -------------------------------------------------
  // Info box (layout indicator)
  // -------------------------------------------------

  const infoX = width - 220;
  const infoY = 20;

  const gInfo = svg.append("g");

  gInfo.append("rect")
    .attr("x", infoX)
    .attr("y", infoY)
    .attr("width", 200)
    .attr("height", 46)
    .attr("rx", 8)
    .attr("fill", "rgba(255,255,255,0.9)")
    .attr("stroke", "rgba(31,41,55,0.15)");

  gInfo.append("text")
    .attr("x", infoX + 12)
    .attr("y", infoY + 18)
    .style("font-size", "10px")
    .style("fill", "#64748b")
    .text("layout");

  gInfo.append("text")
    .attr("x", infoX + 12)
    .attr("y", infoY + 34)
    .style("font-size", "12px")
    .style("font-weight", "700")
    .text(layoutName);

  return installSvgViewZoom(svg);
}

export async function initGraphMriView(svgId, { appId } = {}) {
  const svg = d3.select(`#${svgId}`);
  if (svg.empty()) {
    console.warn("MRI svg not found", svgId);
    return;
  }

  const { width, height } = getSvgSize(svg);

  let files;
  try {
    files = await fetch(`/api/output-files?appId=${appId}&type=code-metrics`).then((r) => r.json());
  } catch (err) {
    console.warn("MRI file list failed", err);
    renderEmpty(svg, width, height, "Could not load MRI file list");
    return null;
  }

  const file = (files || [])
    .filter((f) => f.endsWith("-code-metrics.csv"))
    .sort()
    .reverse()[0];

  if (!file) {
    renderEmpty(svg, width, height, "No MRI data found");
    return null;
  }

  let rows;
  try {
    rows = await d3.csv(`/output/${file}`);
  } catch (err) {
    console.warn("MRI CSV load failed", err);
    renderEmpty(svg, width, height, "Could not load MRI CSV");
    return null;
  }

  const graph = buildGraph(rows || []);
  if (!graph.nodes.length) {
    renderEmpty(svg, width, height, "No code module nodes found");
    return null;
  }

  return renderGraph(svg, graph, width, height, file);
}
