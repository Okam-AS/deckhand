import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const landingDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(landingDir, "..");
const distDir = path.join(projectRoot, "dist");

await mkdir(path.join(distDir, "server"), { recursive: true });
await mkdir(path.join(distDir, ".openai"), { recursive: true });
await copyFile(path.join(landingDir, "worker", "index.js"), path.join(distDir, "server", "index.js"));
await copyFile(path.join(projectRoot, ".openai", "hosting.json"), path.join(distDir, ".openai", "hosting.json"));
