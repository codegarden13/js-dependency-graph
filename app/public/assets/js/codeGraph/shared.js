export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])
  );
}

export function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export function normalizeLinkType(link, fallback = "use") {
  const rawType = firstNonEmptyString(
    link?.type,
    link?.edgeType,
    link?.relation,
    link?.rel,
    link?.kind,
    link?.label
  ).toLowerCase();

  if (!rawType) return fallback;
  if (rawType.includes("include")) return "include";
  if (rawType.includes("call")) return "call";
  if (rawType.includes("extend")) return "extends";
  if (rawType.includes("inherit")) return "extends";
  if (rawType.includes("import")) return "use";
  if (rawType.includes("use")) return "use";
  return rawType;
}

export function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}
