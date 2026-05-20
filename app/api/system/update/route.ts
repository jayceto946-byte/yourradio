import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

function getPowershellExe() {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export async function POST() {
  const projectRoot = process.cwd();
  const updateScript = path.join(projectRoot, "scripts", "update-yourradio.ps1");
  const dataDir = path.join(projectRoot, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  const apiLog = path.join(dataDir, "yourradio-update-api.log");
  const outLog = path.join(dataDir, "yourradio-update.out.log");
  const errLog = path.join(dataDir, "yourradio-update.err.log");

  if (!fs.existsSync(updateScript)) {
    appendLog(apiLog, `update script missing: ${updateScript}`);
    return NextResponse.json({ ok: false, error: "update_script_missing" }, { status: 500 });
  }

  try {
    appendLog(apiLog, `scheduling update: script=${updateScript}`);
    const out = fs.openSync(outLog, "a");
    const err = fs.openSync(errLog, "a");
    const child = spawn(getPowershellExe(), [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      updateScript,
      "-ProjectRoot",
      projectRoot
    ], {
      cwd: projectRoot,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", out, err]
    });

    child.on("error", (error) => appendLog(apiLog, `spawn_error: ${error.message}`));
    child.unref();

    appendLog(apiLog, `spawned update pid=${child.pid ?? "unknown"}`);
    return NextResponse.json({
      ok: true,
      pid: child.pid,
      logs: { apiLog, outLog, errLog },
      message: "YourRadio update has been scheduled. Restart the app after it finishes."
    });
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    appendLog(apiLog, `update_schedule_failed: ${error}`);
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}

function appendLog(file: string, message: string) {
  fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`, "utf8");
}
