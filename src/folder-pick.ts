/** The web console can't learn an absolute path from a browser file input, so the daemon (bound to 127.0.0.1) opens the OS
 *  folder dialog on its own machine and returns the chosen path. */
export function pickFolderCmd(platform: string): string[] {
  if (platform === "win32")
    // -STA is required by the dialog; parenting it to a hidden TopMost form keeps it in front of the browser window
    return ["powershell.exe", "-NoProfile", "-STA", "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; $f.ShowInTaskbar = $false; " +
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog; " +
      "if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }; $f.Dispose()"];
  if (platform === "darwin") return ["osascript", "-e", "POSIX path of (choose folder)"];
  return ["zenity", "--file-selection", "--directory"];
}

export type FolderPickRunner = (cmd: string[]) => Promise<{ stdout: string; exitCode: number }>;

const spawnOnce: FolderPickRunner = async (cmd) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [stdout, , exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, exitCode };
};

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
