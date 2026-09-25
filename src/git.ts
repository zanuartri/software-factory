import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./db";

export function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}
/** Same shape as git(), but yields the event loop: spawnSync freezes the daemon for tens to hundreds of ms per call. */
export async function gitAsync(cwd: string, ...args: string[]) {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { ok: code === 0, out: out.trim(), err: err.trim() };
}
const must = (cwd: string, ...args: string[]) => {
  const r = git(cwd, ...args);
  if (!r.ok) throw new Error(`git ${args.join(" ")}: ${r.err || r.out}`);
  return r.out;
};

export const repoRoot = (p: string) => git(p, "rev-parse", "--show-toplevel").out.replace(/\//g, process.platform === "win32" ? "\\" : "/") || null;
export const currentBranch = (cwd: string) => git(cwd, "branch", "--show-current").out;
/** .factory/ is excluded: the daemon rewrites ticket files in the main checkout all the time. */
export const isClean = (cwd: string) => git(cwd, "status", "--porcelain", "--", ".", ":(exclude).factory").out === "";
export const head = (cwd: string, ref = "HEAD") => must(cwd, "rev-parse", ref);
export const worktreePath = (ws: string, ticket: string) => join(HOME, "worktrees", ws, ticket);

export function addWorktree(repo: string, path: string, branch: string, base: string) {
  if (existsSync(path)) return path;
  mkdirSync(join(path, ".."), { recursive: true });
  const exists = git(repo, "rev-parse", "--verify", `refs/heads/${branch}`).ok;
  must(repo, "worktree", "add", ...(exists ? [path, branch] : ["-b", branch, path, base]));
  return path;
}

export function removeWorktree(repo: string, path: string) {
  if (!git(repo, "worktree", "remove", "--force", path).ok && existsSync(path)) rmSync(path, { recursive: true, force: true });
  git(repo, "worktree", "prune");
}

/**
 * Move `base` from `oldSha` to `newSha` without disturbing the user.
 * If the main checkout sits on base it must be clean and is fast-forwarded; otherwise the ref is CAS-updated.
 */
function advanceBase(repo: string, base: string, newSha: string, oldSha: string) {
  if (currentBranch(repo) === base) {
    if (!isClean(repo)) throw new Error(`main checkout on ${base} has uncommitted changes; commit or stash first`);
    must(repo, "merge", "--ff-only", newSha);
  } else must(repo, "update-ref", `refs/heads/${base}`, newSha, oldSha);
}

/** Squash a (rebased) branch into base as one commit. Returns the new commit sha. */
export function squashMerge(repo: string, branch: string, base: string, message: string) {
  const oldSha = head(repo, base);
  if (!git(repo, "merge-base", "--is-ancestor", oldSha, branch).ok) throw new Error(`${branch} is not rebased on ${base}`);
  const tree = head(repo, `${branch}^{tree}`);
  const sha = Bun.spawnSync(["git", "commit-tree", tree, "-p", oldSha, "-F", "-"], { cwd: repo, stdin: Buffer.from(message), windowsHide: true }).stdout.toString().trim();
  if (!sha) throw new Error("commit-tree failed");
  advanceBase(repo, base, sha, oldSha);
  return sha;
}

/** Revert `sha` on base in a scratch worktree, then advance base. */
export function revertOnBase(repo: string, base: string, sha: string, reason: string) {
  const tmp = join(HOME, "worktrees", "_revert-" + sha.slice(0, 8));
  const oldSha = head(repo, base);
  must(repo, "worktree", "add", "--detach", tmp, oldSha);
  try {
    must(tmp, "revert", "--no-edit", sha);
    must(tmp, "commit", "--amend", "-m", `revert: ${git(repo, "log", "-1", "--format=%s", sha).out}\n\n${reason}`);
    const newSha = head(tmp);
    advanceBase(repo, base, newSha, oldSha);
    return newSha;
  } finally {
    removeWorktree(repo, tmp);
  }
}

/** Scratch worktree at a commit, for verifying base after merge. Caller removes it. */
export function scratchWorktree(repo: string, sha: string) {
  const tmp = join(HOME, "worktrees", "_verify-" + sha.slice(0, 8));
  if (existsSync(tmp)) removeWorktree(repo, tmp);
  must(repo, "worktree", "add", "--detach", tmp, sha);
  return tmp;
}

export const deleteBranch = (repo: string, branch: string) => git(repo, "branch", "-D", branch);
/** A push updates refs/remotes/*, so a changed snapshot means a worker pushed. */
export const remoteRefs = (repo: string) => git(repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes").out;
export const remoteRefsAsync = async (repo: string) => (await gitAsync(repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes")).out;
