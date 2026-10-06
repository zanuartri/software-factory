import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCommandCache, noteSent, slashCommands } from "./herdr";

const tmp = () => mkdtempSync(join(tmpdir(), "herdr-cmd-"));
/** A command file Claude Code would find under <cwd>/.claude/commands. */
function addCommand(cwd: string, name: string) {
  const dir = join(cwd, ".claude", "commands");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\ndescription: probe ${name}\n---\n\nbody\n`);
}

test("slashCommands lists the built-ins the menu was missing", () => {
  const missing = new Set(["reload-plugins", "goal", "remote-control", "fast", "loop", "usage"]);
  expect(slashCommands(tmp()).filter((c) => missing.has(c.name))).toEqual([
    { name: "fast", desc: "Toggle fast mode" },
    { name: "goal", desc: "Keep working until a condition is met" },
    { name: "loop", desc: "Run a prompt repeatedly on an interval" },
    { name: "reload-plugins", desc: "Reload plugins to apply pending changes" },
    { name: "remote-control", desc: "Control this session from another device" },
    { name: "usage", desc: "Show cost, plan limits and activity" },
  ]);
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
