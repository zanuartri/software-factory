// Model discovery per harness, parsed from each CLI's own listing. Cached on disk: listing takes seconds.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bin } from "./adapters";
import { HOME, type Harness } from "./db";

export type Model = { id: string; hint?: string };
const CACHE = join(HOME, "models.json");
const TTL = 6 * 3600e3;

const CLAUDE: Model[] = [
  { id: "fable", hint: "alias · latest Fable" }, { id: "opus", hint: "alias · latest Opus" },
  { id: "sonnet", hint: "alias · latest Sonnet" }, { id: "haiku", hint: "alias · latest Haiku" },
  { id: "claude-fable-5-1" }, { id: "claude-opus-5-5" }, { id: "claude-sonnet-5" }, { id: "claude-haiku-4-5-20251001" },
];

async function run(h: Harness, args: string[]) {
  if (!Bun.which(h)) return "";
  const p = Bun.spawn([...bin(h), ...args], { stdout: "pipe", stderr: "ignore", windowsHide: true });
  const t = setTimeout(() => p.kill(), 60e3);
  const out = await new Response(p.stdout).text();
  clearTimeout(t);
  return out;
}

/** Parsers are exported for the test; each takes the CLI's raw stdout. */
export const parse = {
  pi: (out: string): Model[] => out.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 2 && c[0] && c[1])
    .map(([provider, model, ctx]) => ({ id: `${provider}/${model}`, hint: ctx ? `${ctx} context` : undefined })),
  // ids are "vendor/model" or bare "claude-sonnet-5"; headings ("Anthropic") and the banner have no dash/slash id + 2-space gap
  commandcode: (out: string): Model[] => out.split("\n").map((l) => l.trim().match(/^([a-z0-9][\w.:/-]*[-/][\w.:/-]*)\s{2,}(.*)$/)).filter(Boolean)
    .map((m) => ({ id: m![1], hint: m![2].trim() || undefined })),
};

const discover: Record<Harness, () => Promise<Model[]>> = {
  claude: async () => CLAUDE,
  pi: async () => parse.pi(await run("pi", ["--list-models"])),
  commandcode: async () => parse.commandcode(await run("commandcode", ["--list-models"])),
};

let mem: { at: number; models: Record<Harness, Model[]> } | null = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : null;
let inflight: Promise<Record<Harness, Model[]>> | null = null;

export async function listModels(refresh = false) {
  if (!refresh && mem && Date.now() - mem.at < TTL) return mem.models;
  inflight ??= (async () => {
    const hs = Object.keys(discover) as Harness[];
    const lists = await Promise.all(hs.map((h) => discover[h]().catch(() => [] as Model[])));
    const models = Object.fromEntries(hs.map((h, i) => [h, lists[i].length ? lists[i] : mem?.models[h] ?? []])) as Record<Harness, Model[]>;
    mem = { at: Date.now(), models };
    writeFileSync(CACHE, JSON.stringify(mem));
    return models;
  })().finally(() => { inflight = null; });
  return inflight;
}
