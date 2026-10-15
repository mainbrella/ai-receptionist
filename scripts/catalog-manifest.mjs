import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({ options: { ref: { type: "string" }, out: { type: "string" } } });
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

try {
  let sha;
  try { sha = git("rev-parse", "--verify", "HEAD"); }
  catch { throw new Error("Commit the extracted app before generating a catalog pin. No source commit exists yet."); }
  if (git("status", "--porcelain", "--untracked-files=all")) {
    throw new Error("Commit all source changes first. A catalog pin must describe the exact code being packaged.");
  }
  const ref = values.ref ?? git("symbolic-ref", "--short", "HEAD");
  if (!ref || ref.startsWith("-") || !/^[\w./+-]+$/.test(ref)) throw new Error("Use a branch or tag name for --ref.");
  if (git("rev-parse", "--verify", `${ref}^{commit}`) !== sha) throw new Error("The requested ref must point to HEAD.");
  const template = await readFile(resolve(root, "appflare.jsonc"), "utf8");
  const sentinel = '"source": { "ref": "main", "sha": "0000000000000000000000000000000000000000" }';
  if (!template.includes(sentinel)) throw new Error("The catalog template's source marker has changed.");
  const output = template.replace(/  \/\/ Packaging template\.[\s\S]*?unpinned template to the catalog\.\n/, "")
    .replace(sentinel, `"source": ${JSON.stringify({ ref, sha })}`);
  const target = resolve(root, values.out ?? "dist/catalog/apps/mainbrella-voice/appflare.jsonc");
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(target, output);
  process.stdout.write(`Pinned ${ref} at ${sha}\nManifest: ${target}\nPublish this source commit in the public repository before opening the catalog PR.\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
