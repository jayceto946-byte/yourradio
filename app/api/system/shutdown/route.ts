import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const POWERSHELL_EXE = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";

export async function POST() {
  const projectRoot = process.cwd();
  const scriptsDir = path.join(projectRoot, "scripts");
  const stopScript = path.join(scriptsDir, "stop-local-radio.ps1");
  const dataDir = path.join(projectRoot, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  const apiLog = path.join(dataDir, "local-shutdown-api.log");
  const outLog = path.join(dataDir, "local-shutdown.out.log");
  const errLog = path.join(dataDir, "local-shutdown.err.log");

  if (!fs.existsSync(stopScript)) {
    appendLog(apiLog, `stop script missing: ${stopScript}`);
    return NextResponse.json({ ok: false, error: "stop_script_missing", stopScript }, { status: 500 });
  }

  const radioPort = Number(process.env.YOURRADIO_PORT ?? 3100);
  const ttsPort = Number(process.env.QWEN3_TTS_PORT ?? 8010);
  const command = [
    "Start-Sleep -Milliseconds 400",
    `& '${escapePs(stopScript)}' -RadioPort ${radioPort} -TtsPort ${ttsPort} -ProjectRoot '${escapePs(projectRoot)}'`
  ].join("; ");

  try {
    appendLog(apiLog, `scheduling shutdown: radio=${radioPort}, tts=${ttsPort}, script=${stopScript}`);
    const out = fs.openSync(outLog, "a");
    const err = fs.openSync(errLog, "a");
    const child = spawn(POWERSHELL_EXE, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command
    ], {
      cwd: projectRoot,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", out, err]
    });

    child.on("error", (error) => appendLog(apiLog, `spawn_error: ${error.message}`));
    child.unref();

    appendLog(apiLog, `spawned shutdown pid=${child.pid ?? "unknown"}`);
    return NextResponse.json({
      ok: true,
      pid: child.pid,
      radioPort,
      ttsPort,
      logs: { apiLog, outLog, errLog },
      message: "Local YourRadio and Qwen3 TTS shutdown has been scheduled."
    });
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    appendLog(apiLog, `shutdown_schedule_failed: ${error}`);
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}

function appendLog(file: string, message: string) {
  fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}
`, "utf8");
}

function escapePs(value: string) {
  return value.replace(/'/g, "''");
}
