import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-test-"));
const { parse } = await import("./models");

test("parses each harness's model listing", () => {
  expect(parse.omp(JSON.stringify({ models: [{ kind: "chat", selector: "openai-codex/gpt-6-luna", contextWindow: 272000 }, { kind: "embedding", selector: "x/e" }] }))).toEqual([{ id: "openai-codex/gpt-6-luna", hint: "272K context" }]);
  expect(parse.omp("not json")).toEqual([]);
  expect(parse.commandcode("Available models  ·  80 models\n\nOpen Source\n\ndeepseek/deepseek-v4-pro               long-context reasoning\nmoonshotai/kimi-k3                     1M context\nAnthropic\nclaude-sonnet-5                        best combo\nPass the full id, or just the short name:\ncmdc --model kimi-k2.5\n"))
    .toEqual([{ id: "deepseek/deepseek-v4-pro", hint: "long-context reasoning" }, { id: "moonshotai/kimi-k3", hint: "1M context" }, { id: "claude-sonnet-5", hint: "best combo" }]);
});
