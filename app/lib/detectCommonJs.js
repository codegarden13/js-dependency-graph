import fs from "fs/promises";
import path from "path";
import { glob } from "glob";

async function readPackageJsonSafe(pkgPath) {
  try {
    const txt = await fs.readFile(pkgPath, "utf8");
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

async function findJsFiles(projectRoot) {
  return glob("**/*.js", {
    cwd: projectRoot,
    ignore: ["**/node_modules/**", "**/dist/**"]
  });
}

async function readFileSafe(absPath) {
  try {
    return await fs.readFile(absPath, "utf8");
  } catch {
    return "";
  }
}

function detectCommonJsSignals(src) {
  return {
    require: /\brequire\s*\(/.test(src),
    moduleExports: /\bmodule\.exports\b/.test(src)
  };
}

export async function detectCommonJs(projectRoot) {
  const pkgPath = path.join(projectRoot, "package.json");
  const pkg = await readPackageJsonSafe(pkgPath);

  const hasTypeModule = pkg?.type === "module";

  const files = await findJsFiles(projectRoot);

  let requireCount = 0;
  let moduleExportsCount = 0;

  for (const rel of files) {
    const abs = path.join(projectRoot, rel);
    const src = await readFileSafe(abs);
    if (!src) continue;

    const sig = detectCommonJsSignals(src);

    if (sig.require) requireCount++;
    if (sig.moduleExports) moduleExportsCount++;
  }

  const isLikelyCommonJs = !hasTypeModule && (requireCount > 0 || moduleExportsCount > 0);

  return {
    isCommonJs: isLikelyCommonJs,
    signals: {
      hasTypeModule,
      requireCount,
      moduleExportsCount
    }
  };
}