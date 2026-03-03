import fs from "fs/promises";
import path from "path";
import { glob } from "glob";

export async function detectCommonJs(projectRoot) {
  const pkgPath = path.join(projectRoot, "package.json");

  let pkg = null;
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  } catch {}

  const hasTypeModule = pkg?.type === "module";

  const files = await glob("**/*.js", {
    cwd: projectRoot,
    ignore: ["**/node_modules/**", "**/dist/**"]
  });

  let requireCount = 0;
  let moduleExportsCount = 0;

  for (const rel of files) {
    const abs = path.join(projectRoot, rel);
    const src = await fs.readFile(abs, "utf8").catch(() => "");
    if (!src) continue;

    if (/\brequire\s*\(/.test(src)) requireCount++;
    if (/\bmodule\.exports\b/.test(src)) moduleExportsCount++;
  }

  const isLikelyCommonJs =
    !hasTypeModule &&
    (requireCount > 0 || moduleExportsCount > 0);

  return {
    isCommonJs: isLikelyCommonJs,
    signals: {
      hasTypeModule,
      requireCount,
      moduleExportsCount
    }
  };
}