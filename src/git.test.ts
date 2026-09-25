import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-git-test-")); // ./git pulls in ./db, which opens HOME on import
const { git, gitAsync, remoteRefs, remoteRefsAsync } = await import("./git");

const repo = mkdtempSync(join(tmpdir(), "factory-git-repo-"));
git(repo, "init", "-q");
git(repo, "config", "user.email", "t@t");
git(repo, "config", "user.name", "t");
writeFileSync(join(repo, "a.txt"), "a\n");
git(repo, "add", "a.txt");
git(repo, "commit", "-qm", "init");
writeFileSync(join(repo, "untracked.txt"), "x\n");
git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");

test("gitAsync returns exactly what git() returns", async () => {
  expect(git(repo, "ls-files", "--others", "--exclude-standard").out).toBe("untracked.txt"); // non-vacuous
  expect(git(repo, "rev-parse", "nope").ok).toBe(false);
  expect(remoteRefs(repo)).toContain("refs/remotes/origin/main"); // non-vacuous

  for (const args of [["status", "--porcelain"], ["ls-files", "--others", "--exclude-standard"], ["rev-parse", "nope"]])
    expect(await gitAsync(repo, ...args)).toEqual(git(repo, ...args));
  expect(await remoteRefsAsync(repo)).toBe(remoteRefs(repo));
});

test("gitAsync keeps the event loop free", async () => {
  let ticks = 0;
  const iv = setInterval(() => ticks++, 10);
  try {
    const until = Date.now() + 500;
    while (Date.now() < until) await gitAsync(process.cwd(), "status", "--porcelain");
  } finally {
    clearInterval(iv);
  }
  expect(ticks).toBeGreaterThan(0);
});
