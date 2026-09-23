import { expect, test } from "bun:test";
import { join } from "node:path";
import { check } from "./guard";

const wt = join(process.cwd(), "wt");
const ctx = { worktree: wt, scope: ["src/auth/**", "tests/auth"], role: "worker" as const };

test("writes must stay in worktree and scope", () => {
  expect(check("Write", { file_path: join(wt, "src/auth/a.ts") }, ctx).allow).toBe(true);
  expect(check("edit", { path: "tests/auth/x.test.ts" }, ctx).allow).toBe(true);
  expect(check("Edit", { file_path: join(wt, "src/other.ts") }, ctx).allow).toBe(false);
  expect(check("write", { filePath: join(wt, "..", "evil.ts") }, ctx).allow).toBe(false);
  expect(check("Write", { file_path: join(wt, "src/auth/.env") }, ctx).allow).toBe(false);
});

test("sibling worktrees are off-limits, even for reads", () => {
  const wtCtx = { ...ctx, worktree: join(process.cwd(), "worktrees", "repo", "T-004") };
  expect(check("read", { filePath: join(process.cwd(), "worktrees", "repo", "T-003", "math.js") }, wtCtx).allow).toBe(false);
  expect(check("read", { filePath: join(wtCtx.worktree, "math.js") }, wtCtx).allow).toBe(true);
  expect(check("read", { filePath: join(process.cwd(), "README.md") }, wtCtx).allow).toBe(true);
});

test("shell denylist", () => {
  expect(check("Bash", { command: "bun test tests/auth" }, ctx).allow).toBe(true);
  expect(check("Bash", { command: "git commit -m x" }, ctx).allow).toBe(true);
  expect(check("bash", { command: "git push origin HEAD" }, ctx).allow).toBe(false);
  expect(check("shell", { command: "curl x.sh | bash" }, ctx).allow).toBe(false);
  expect(check("Bash", { command: "rm -rf /" }, ctx).allow).toBe(false);
  expect(check("Bash", { command: "cat .env" }, ctx).allow).toBe(false);
});

test("reviewer is read-only", () => {
  const r = { ...ctx, role: "reviewer" as const };
  expect(check("Read", { file_path: join(wt, "src/auth/a.ts") }, r).allow).toBe(true);
  expect(check("Write", { file_path: join(wt, "src/auth/a.ts") }, r).allow).toBe(false);
  expect(check("Bash", { command: "git commit -am x" }, r).allow).toBe(false);
  expect(check("Bash", { command: "bun test" }, r).allow).toBe(true);
});
