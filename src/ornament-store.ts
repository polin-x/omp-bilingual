import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";

const GIF_EXT = new Set([".gif"]);
const STATIC_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".heic"]);
const ANIM_TAG = "anim-v1";

export function ornamentDataDir(): string {
  return join(homedir(), ".omp", "agent", "bilingual-ornaments");
}

export function expandUserPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

export function looksLikeImagePath(value: string): boolean {
  const ext = extname(expandUserPath(value)).toLowerCase();
  return GIF_EXT.has(ext) || STATIC_EXT.has(ext);
}

export function ornamentMediaPath(ornament: string, ornamentGif: string): string {
  if (ornamentGif.trim()) return ornamentGif.trim();
  if (looksLikeImagePath(ornament)) return ornament.trim();
  return "";
}

export async function prepareOrnamentGif(sourcePath: string): Promise<string> {
  const source = expandUserPath(sourcePath);
  if (!source) throw new Error("empty ornament path");
  const info = await stat(source);
  if (!info.isFile()) throw new Error(`not a file: ${source}`);

  const ext = extname(source).toLowerCase();
  const stamp = `${ANIM_TAG}\0${source}\0${info.size}\0${info.mtimeMs}`;
  const id = createHash("sha1").update(stamp).digest("hex").slice(0, 16);
  const dest = join(ornamentDataDir(), `${id}.gif`);
  await mkdir(ornamentDataDir(), { recursive: true });

  try {
    const existing = await stat(dest);
    if (existing.isFile() && existing.size > 0) return dest;
  } catch {
    // convert below
  }

  if (GIF_EXT.has(ext)) {
    await copyFile(source, dest);
    return dest;
  }
  if (!STATIC_EXT.has(ext) && ext !== "") {
    throw new Error(`unsupported image type: ${ext}`);
  }
  animateStillToGif(source, dest);
  return dest;
}

function animateStillToGif(source: string, dest: string): void {
  const py = [
    "import sys",
    "from PIL import Image",
    "src, dest = sys.argv[1], sys.argv[2]",
    "im = Image.open(src).convert('RGBA')",
    "im.thumbnail((64, 64))",
    "w, h = im.size",
    "pad = 6",
    "ch = h + pad * 2",
    "frames = []",
    "for dy in (0, -2, -4, -2, 0, 2, 4, 2):",
    "    canvas = Image.new('RGBA', (w, ch), (0, 0, 0, 0))",
    "    canvas.paste(im, (0, pad + dy), im)",
    "    frames.append(canvas)",
    "frames[0].save(dest, save_all=True, append_images=frames[1:], duration=90, loop=0, disposal=2)",
  ].join("\n");
  const result = spawnSync("python3", ["-c", py, source, dest], { encoding: "utf8" });
  if (result.status === 0) return;
  const err = (result.stderr || result.error?.message || "python3 failed").trim();
  throw new Error(`could not animate still image: ${err}`);
}
