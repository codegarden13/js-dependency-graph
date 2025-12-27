import fs from "node:fs";
import path from "node:path";

const EXTENSIONS = [".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"];

export function resolveImports(fromAbs, spec, projectRoot) {
  if (!spec.startsWith(".")) return null;

  const base = path.resolve(path.dirname(fromAbs), spec);

  if (path.extname(base) && fs.existsSync(base)) {
    return base;
  }

  for (const ext of EXTENSIONS) {
    const cand = base + ext;
    if (fs.existsSync(cand)) return cand;
  }

  for (const ext of EXTENSIONS) {
    const cand = path.join(base, "index" + ext);
    if (fs.existsSync(cand)) return cand;
  }

  return null;
}