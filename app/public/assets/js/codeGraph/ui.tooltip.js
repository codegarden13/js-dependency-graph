/**
 * Tooltip helpers for the Code Structure D3 renderer.
 *
 * Pure DOM utilities (no Bootstrap dependency).
 * ESM version (no globals).
 */

/**
 * Ensure a tooltip element exists.
 * @returns {HTMLDivElement}
 */
export function ensureTooltip() {
  /** @type {HTMLDivElement|null} */
  let el = /** @type {HTMLDivElement|null} */ (document.getElementById("__codeStructureTooltip"));
  if (el) return el;

  el = document.createElement("div");
  el.id = "__codeStructureTooltip";
  el.style.position = "fixed";
  el.style.zIndex = "9999";
  el.style.maxWidth = "min(520px, 92vw)";
  el.style.background = "rgba(20,20,20,0.92)";
  el.style.color = "#fff";
  el.style.padding = "10px 12px";
  el.style.borderRadius = "10px";
  el.style.boxShadow = "0 10px 24px rgba(0,0,0,0.35)";
  el.style.fontSize = "12px";
  el.style.lineHeight = "1.35";
  el.style.pointerEvents = "none";
  el.style.opacity = "0";
  el.style.transition = "opacity 80ms linear";
  el.style.whiteSpace = "normal";

  document.body.appendChild(el);
  return el;
}

/**
 * Position the tooltip near the pointer while staying inside the viewport.
 * @param {HTMLDivElement} el
 * @param {number} clientX
 * @param {number} clientY
 */
export function positionTooltip(el, clientX, clientY) {
  const pad = 12;
  const offset = 14;

  // Start to the bottom-right of the pointer.
  let x = clientX + offset;
  let y = clientY + offset;

  // Measure current size.
  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // If overflows right edge, flip to left.
  if (x + rect.width + pad > vw) x = Math.max(pad, clientX - rect.width - offset);
  // If overflows bottom edge, flip to top.
  if (y + rect.height + pad > vh) y = Math.max(pad, clientY - rect.height - offset);

  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
}

/**
 * Show tooltip.
 * @param {HTMLDivElement} el
 * @param {MouseEvent|PointerEvent} evt
 * @param {string} html
 */
export function showTooltip(el, evt, html) {
  if (!el) return;

  el.innerHTML = String(html || "");

  // Update position after content is set (so rect is accurate).
  const x = Number(evt?.clientX || 0);
  const y = Number(evt?.clientY || 0);
  positionTooltip(el, x, y);

  el.style.opacity = "1";
}

/**
 * Update tooltip position without changing its content.
 * Useful for `mousemove` handlers.
 * @param {HTMLDivElement} el
 * @param {MouseEvent|PointerEvent} evt
 */
export function moveTooltip(el, evt) {
  if (!el) return;
  if (el.style.opacity === "0") return;

  const x = Number(evt?.clientX || 0);
  const y = Number(evt?.clientY || 0);
  positionTooltip(el, x, y);
}

/**
 * Hide tooltip.
 * @param {HTMLDivElement} el
 */
export function hideTooltip(el) {
  if (!el) return;
  el.style.opacity = "0";
}
