import { killTree } from "./adapters";

/** The web console can't learn an absolute path from a browser file input, so the daemon (bound to 127.0.0.1) opens the OS
 *  folder dialog on its own machine and returns the chosen path. */
export function pickFolderCmd(platform: string): string[] {
  if (platform === "win32")
    // -STA is required by the dialog; a hidden TopMost owner keeps it in front of the browser window.
    return ["powershell.exe", "-NoProfile", "-STA", "-WindowStyle", "Hidden", "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; $f.ShowInTaskbar = $false; $f.Opacity = 0; $f.StartPosition = 'CenterScreen'; $f.Activate(); " +
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog; " +
      "if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }; $f.Dispose()"];
  if (platform === "darwin") return ["osascript", "-e", "POSIX path of (choose folder)"];
  return ["zenity", "--file-selection", "--directory"];
}

export type FolderPickRunner = (cmd: string[]) => Promise<{ stdout: string; exitCode: number }>;

export function pickSpawnOpts(platform: string) {
  return { stdout: "pipe" as const, stderr: "pipe" as const, ...(platform === "win32" ? {} : { windowsHide: true }) };
}

export async function spawnOnce(cmd: string[], timeoutMs = 5 * 60 * 1000): Promise<{ stdout: string; exitCode: number }> {
  const p = Bun.spawn(cmd, pickSpawnOpts(process.platform));
  const output = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const { promise: timedOut, resolve: markTimedOut } = Promise.withResolvers<null>();
  const timer = setTimeout(() => { killTree(p.pid); markTimedOut(null); }, timeoutMs);
  const result = await Promise.race([output, timedOut]);
  clearTimeout(timer);
  if (result) return { stdout: result[0], exitCode: result[2] };
  await Promise.race([output.catch(() => {}), Bun.sleep(2000)]);
  return { stdout: "", exitCode: 1 };
}

const missingBinary = (e: unknown) => (e as any)?.code === "ENOENT";

/** Resolves the picked path, or null when the user cancels (no output / non-zero exit). A machine without a dialog binary is an error. */
export async function pickFolder(run: FolderPickRunner = spawnOnce): Promise<string | null> {
  let r: { stdout: string; exitCode: number };
  try {
    r = await run(pickFolderCmd(process.platform));
  } catch (e) {
    if (missingBinary(e)) throw new Error("no folder dialog available (install zenity)");
    throw e;
  }
  const path = r.stdout.trim();
  return r.exitCode === 0 && path ? path : null;
}
