const { execSync } = require("node:child_process");

const port = process.argv[2];
const currentPid = String(process.pid);

if (!port || !/^\d+$/.test(port)) {
  console.error("Usage: node scripts/kill-port.js <port>");
  process.exit(1);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

try {
  const output = execSync(`netstat -ano | findstr :${port}`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  const pids = unique(
    output
      .split(/\r?\n/)
      .filter((line) => line.includes("LISTENING"))
      .map((line) => line.trim().split(/\s+/).at(-1))
      .filter((pid) => pid !== currentPid)
  );

  if (pids.length === 0) {
    console.log(`[kill-port] Port ${port} is free.`);
    process.exit(0);
  }

  for (const pid of pids) {
    console.log(`[kill-port] Killing PID ${pid} on port ${port}.`);
    execSync(`taskkill /PID ${pid} /F`, { stdio: "inherit" });
  }
} catch {
  console.log(`[kill-port] Port ${port} is free.`);
}
