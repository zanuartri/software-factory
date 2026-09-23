import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-test-"));
const { parse } = await import("./models");

test("parses each harness's model listing", () => {
  expect(parse.pi("provider     model              context  max-out\nopencode-go  deepseek-v4-flash  1M       384K\n")).toEqual([{ id: "opencode-go/deepseek-v4-flash", hint: "1M context" }]);
  expect(parse.opencode("opencode/big-pickle\nanthropic/claude-sonnet-5\n\n")).toEqual([{ id: "opencode/big-pickle" }, { id: "anthropic/claude-sonnet-5" }]);
  expect(parse.commandcode("Available models  ·  80 models\n\nOpen Source\n\ndeepseek/deepseek-v4-pro               long-context reasoning\nmoonshotai/kimi-k3                     1M context\nAnthropic\nclaude-sonnet-5                        best combo\nPass the full id, or just the short name:\ncmdc --model kimi-k2.5\n"))
    .toEqual([{ id: "deepseek/deepseek-v4-pro", hint: "long-context reasoning" }, { id: "moonshotai/kimi-k3", hint: "1M context" }, { id: "claude-sonnet-5", hint: "best combo" }]);
});
