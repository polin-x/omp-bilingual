import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";

const GIF_EXT = new Set([".gif"]);
const STATIC_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".heic"]);

export function ornamentDataDir(): string {
  return join(homedir(), ".omp", "agent", "bilingual-ornaments");
}

export function expandUserPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

export async function prepareOrnamentGif(sourcePath: string): Promise<string> {
  const source = expandUserPath(sourcePath);
  if (!source) throw new Error("empty ornament path");
  const info = await stat(source);
  if (!info.isFile()) throw new Error(`not a file: ${source}`);

  const ext = extname(source).toLowerCase();
  const stamp = `${source}\0${info.size}\0${info.mtimeMs}`;
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
  convertStaticToGif(source, dest);
  return dest;
}

function convertStaticToGif(source: string, dest: string): void {
  const attempts: Array<[string, string[]]> = [
    ["sips", ["-s", "format", "gif", source, "--out", dest]],
    ["magick", [source, dest]],
    ["convert", [source, dest]],
    ["ffmpeg", ["-y", "-i", source, dest]],
  ];
  const errors: string[] = [];
  for (const [bin, args] of attempts) {
    const result = spawnSync(bin, args, { encoding: "utf8" });
    if (result.status === 0) return;
    if (result.error && "code" in result.error && result.error.code === "ENOENT") continue;
    const err = (result.stderr || result.error?.message || "").trim();
    if (err) errors.push(`${bin}: ${err}`);
  }
  throw new Error(errors[0] || "need sips, magick, or ffmpeg to convert a still image to gif");
}
