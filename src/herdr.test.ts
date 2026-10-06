import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledSkillsRoot, clearCommandCache, discoverBundled, noteSent, prompt, slashCommands, suggestionFrom } from "./herdr";

setDefaultTimeout(20000);

const tmp = () => mkdtempSync(join(tmpdir(), "herdr-cmd-"));
/** A command file Claude Code would find under <cwd>/.claude/commands. */
function addCommand(cwd: string, name: string) {
  const dir = join(cwd, ".claude", "commands");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\ndescription: probe ${name}\n---\n\nbody\n`);
}

function pluginFixture(home: string, marketplace: string, source: unknown, live = true) {
  const claude = join(home, ".claude");
  const install = join(claude, "plugins", "cache", "factory");
  const livePlugin = join(home, "plugin");
  mkdirSync(join(install, "commands"), { recursive: true });
  writeFileSync(join(install, "commands", "cache-only.md"), "---\ndescription: from cache\n---\n");
  writeFileSync(join(install, "commands", "clash.md"), "---\ndescription: cache description\n---\n");
  writeFileSync(join(claude, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "factory@market": [{ installPath: install }] } }));
  mkdirSync(join(claude, "plugins"), { recursive: true });
  writeFileSync(join(claude, "plugins", "known_marketplaces.json"), JSON.stringify({ market: { source: { source: marketplace, path: home }, installLocation: home } }));
  mkdirSync(join(home, ".claude-plugin"), { recursive: true });
  writeFileSync(join(home, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: [{ name: "factory", source }] }));
  if (live) {
    mkdirSync(join(livePlugin, "commands"), { recursive: true });
    writeFileSync(join(livePlugin, "commands", "new.md"), "---\ndescription: live new command\n---\n");
    writeFileSync(join(livePlugin, "commands", "clash.md"), "---\ndescription: live description\n---\n");
  }
  return { claude, install, livePlugin };
}

test("slashCommands scans live directory-marketplace plugins before cache", () => {
  const home = tmp();
  pluginFixture(home, "directory", "./plugin");
  const commands = slashCommands(tmp(), null, join(home, ".claude"));
  expect(commands.find((c) => c.name === "factory:new")).toEqual({ name: "factory:new", desc: "live new command" });
  expect(commands.find((c) => c.name === "factory:clash")).toEqual({ name: "factory:clash", desc: "live description" });
  expect(commands.find((c) => c.name === "factory:cache-only")).toEqual({ name: "factory:cache-only", desc: "from cache" });
});

test("slashCommands keeps cache discovery for non-directory and missing live plugins", () => {
  for (const [marketplace, live] of [["github", true], ["directory", false]] as const) {
    const home = tmp();
    pluginFixture(home, marketplace, "./plugin", live);
    const commands = slashCommands(tmp(), null, join(home, ".claude"));
    expect(commands.find((c) => c.name === "factory:cache-only")).toEqual({ name: "factory:cache-only", desc: "from cache" });
    expect(commands.find((c) => c.name === "factory:new")).toBeUndefined();
    expect(commands.find((c) => c.name === "factory:clash")).toEqual({ name: "factory:clash", desc: "cache description" });
  }
});

test("slashCommands lists the built-ins the menu was missing", () => {
  const missing = new Set(["reload-plugins", "goal", "remote-control", "fast", "feedback", "loop", "usage"]);
  expect(slashCommands(tmp()).filter((c) => missing.has(c.name))).toEqual([
    { name: "fast", desc: "Toggle fast mode" },
    { name: "feedback", desc: "Send feedback about Claude Code" },
    { name: "goal", desc: "Keep working until a condition is met" },
    { name: "loop", desc: "Run a prompt repeatedly on an interval" },
    { name: "reload-plugins", desc: "Reload plugins to apply pending changes" },
    { name: "remote-control", desc: "Control this session from another device" },
    { name: "usage", desc: "Show cost, plan limits and activity" },
  ]);
});

test("slashCommands keeps the confirmed built-in commands when no bundled root exists", () => {
  const desc: Record<string, string> = {};
  for (const c of slashCommands(tmp(), null)) desc[c.name] = c.desc;
  expect(desc.verify).toBeUndefined(); // /verify only comes from the bundled-skills dir
  for (const n of ["branch", "btw", "bug", "fork", "workflows"]) expect(desc[n]).toBeDefined();
});

test("slashCommands lists skills from an injected bundled-skills dir", () => {
  const root = join(tmp(), "claude", "bundled-skills", "0123456789abcdef0123456789abcdef");
  mkdirSync(join(root, "verify"), { recursive: true });
  writeFileSync(join(root, "verify", "SKILL.md"), "---\ndescription: Run every Verify command\n---\n\nbody\n");
  expect(slashCommands(tmp(), root).find((c) => c.name === "verify")).toEqual({ name: "verify", desc: "Run every Verify command" });
});

test("bundledSkillsRoot picks the newest hex dir and nulls when absent", () => {
  const base = join(tmp(), "claude", "bundled-skills");
  const oldHex = join(base, "0123456789abcdef0123456789abcdef");
  const newHex = join(base, "fedcba9876543210fedcba9876543210");
  mkdirSync(oldHex, { recursive: true });
  mkdirSync(newHex, { recursive: true });
  mkdirSync(join(base, "not-hex"), { recursive: true });
  const past = new Date(Date.now() - 60_000);
  utimesSync(oldHex, past, past);
  expect(bundledSkillsRoot(base)).toBe(newHex);
  expect(bundledSkillsRoot(join(tmp(), "no-bundled-here"))).toBeNull();
});

test("slashCommands has no duplicate names and stays sorted", () => {
  const names = slashCommands(tmp()).map((c) => c.name);
  expect(names).toEqual([...new Set(names)]);
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
});

test("clearCommandCache makes slashCommands re-read the command dirs", () => {
  const cwd = tmp(); // fresh cwd: the first call populates the 30s cache
  expect(slashCommands(cwd).some((c) => c.name === "t031-fresh")).toBe(false);
  addCommand(cwd, "t031-fresh");
  expect(slashCommands(cwd).some((c) => c.name === "t031-fresh")).toBe(false); // still the cached list
  clearCommandCache();
  expect(slashCommands(cwd).find((c) => c.name === "t031-fresh")).toEqual({ name: "t031-fresh", desc: "probe t031-fresh" });
});

test("a cache hit does not evaluate bundled-skills discovery", () => {
  const cwd = tmp();
  let calls = 0;
  const real = discoverBundled.get;
  discoverBundled.get = () => { calls++; return null; };
  try {
    slashCommands(cwd);
    slashCommands(cwd); // same cwd, inside the 30s window: the cached list must be returned untouched
    expect(calls).toBe(1);
    clearCommandCache();
    slashCommands(cwd);
    expect(calls).toBe(2);
  } finally {
    discoverBundled.get = real;
  }
});

/** Records the argv of every `herdr` invocation and returns a process that prints nothing and exits 0. */
function stubHerdr() {
  const realSpawn = Bun.spawn;
  const seen: string[][] = [];
  (Bun as any).spawn = (args: string[]) => {
    seen.push(args);
    return { pid: 0, exitCode: null, stdout: new Blob([]).stream(), stderr: new Blob([]).stream(), exited: Promise.resolve(0) };
  };
  return { seen, restore: () => { (Bun as any).spawn = realSpawn; } };
}

test("prompt clears the input box before sending, in that order", async () => {
  const { seen, restore } = stubHerdr();
  try {
    await prompt("pane-1", "hello");
    expect(seen).toEqual([
      ["herdr", "agent", "send-keys", "pane-1", "ctrl+u"],
      ["herdr", "agent", "prompt", "pane-1", "hello"],
    ]);
  } finally {
    restore();
  }
});

test("prompt skips ctrl+u when the agent is blocked", async () => {
  const { seen, restore } = stubHerdr();
  try {
    await prompt("pane-1", "hello", false);
    expect(seen).toEqual([["herdr", "agent", "prompt", "pane-1", "hello"]]);
  } finally {
    restore();
  }
});

test("noteSent clears the cache only for /reload-plugins", () => {
  const reload = tmp();
  slashCommands(reload);
  addCommand(reload, "t031-reload");
  noteSent("  /reload-plugins --force  ");
  expect(slashCommands(reload).some((c) => c.name === "t031-reload")).toBe(true);

  for (const text of ["/help", "/reload-pluginsx", "hello /reload-plugins", ""]) {
    const cwd = tmp();
    slashCommands(cwd);
    addCommand(cwd, "t031-other");
    noteSent(text);
    expect({ text, seen: slashCommands(cwd).some((c) => c.name === "t031-other") }).toEqual({ text, seen: false });
  }
});
const suggestionScreen = [
  "────────────────────────────────────────────────────────────────────────",
  "❯ \x1b[0m\x1b[2mName another common fruit.\x1b[0m",
  "────────────────────────────────────────────────────────────────────────",
].join("\n");
const emptyScreen = "────────────────────────────────\n❯ \x1b[0m\n────────────────────────────────";
const typedScreen = "────────────────────────────────\n❯ a real typed draft\n────────────────────────────────";
const workingScreen = "❯ \x1b[0m\x1b[2mName another common fruit.\x1b[0m\n✻ Thinking…";
const blockedScreen = [
  "Accessing workspace:",
  "Quick safety check: Is this a project you created or one you trust?",
  "❯ No, exit",
  "  Yes, I trust this folder",
  "Enter to confirm · Esc to cancel",
].join("\n");

test("suggestionFrom recognizes dim Claude ghost text only on an idle input", () => {
  expect(suggestionFrom(suggestionScreen)).toBe("Name another common fruit.");
  expect(suggestionFrom(emptyScreen)).toBeNull();
  expect(suggestionFrom(typedScreen)).toBeNull();
  expect(suggestionFrom(workingScreen)).toBeNull();
  expect(suggestionFrom(blockedScreen)).toBeNull();
});
test("suggestionFrom ignores extended-colour parameters when detecting dim text", () => {
  expect(suggestionFrom("❯ \x1b[38;2;10;2;30mtyped\x1b[0m")).toBeNull();
  expect(suggestionFrom("❯ \x1b[38;5;2mtyped\x1b[0m")).toBeNull();
  expect(suggestionFrom("❯ \x1b[2mghost\x1b[0m")).toBe("ghost");
  expect(suggestionFrom("❯ \x1b[2;38;2;1;2;3mghost\x1b[0m")).toBe("ghost");
});
