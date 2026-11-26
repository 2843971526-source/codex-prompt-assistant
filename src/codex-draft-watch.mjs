import {execFile, spawn} from "node:child_process";
import {setTimeout as delay} from "node:timers/promises";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";

const bridge = fileURLToPath(new URL("./codex-draft-button.mjs", import.meta.url));
const findPort = "Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe'\" | Where-Object { $_.ExecutablePath -like '*\\WindowsApps\\OpenAI.Codex_*\\app\\ChatGPT.exe' -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -match '--remote-debugging-port=(\\d+)' } | ForEach-Object { if ($Matches[1]) { $Matches[1] } } | Select-Object -First 1";
let child;
let attachedPort;

while (true) {
  let port;
  try {
    const {stdout} = await promisify(execFile)("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", findPort],
      {windowsHide: true, timeout: 5000});
    if (/^\d+$/.test(stdout.trim())) port = Number(stdout.trim());
  } catch {
    await delay(4000);
    continue;
  }
  if (child && port !== attachedPort) {
    child.kill();
    child = undefined;
  }
  if (port && !child) {
    const next = spawn(process.execPath, [bridge, String(port)], {windowsHide: true, stdio: "ignore"});
    child = next;
    attachedPort = port;
    const clear = () => { if (child === next) child = undefined; };
    next.once("exit", clear);
    next.once("error", clear);
  }
  await delay(4000);
}

