import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const stateDir = resolve(process.env.SPACE_DEV_STACK_STATE_DIR ?? join(tmpdir(), `space-dev-smoke-${randomBytes(5).toString("hex")}`));
const apiOrigin = `http://127.0.0.1:${process.env.SPACE_DEV_STACK_API_PORT ?? "14910"}`;
const webOrigin = `http://127.0.0.1:${process.env.SPACE_DEV_STACK_WEB_PORT ?? "14911"}`;
const env = { ...process.env, SPACE_DEV_STACK_STATE_DIR: stateDir,
  OPENAI_API_KEY: "dev-stack-smoke-must-not-inherit-this-key",
  SPACE_INSTANCE_ENABLED_JOBS: "telegram-bridge,streaming-bot" };
const runnerFile = join(root, "scripts/dev-stack.mjs");
const exists = async path => access(path).then(() => true, () => false);
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
async function ownedProcesses(runtimeRoot) {
  if (process.platform !== "linux") return [];
  const owned = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const environment = (await readFile(`/proc/${entry}/environ`, "utf8")).split("\0");
      if (!environment.some(item => {
        const value = item.slice(item.indexOf("=") + 1);
        return value === stateDir || value.startsWith(`${stateDir}/`) || (runtimeRoot && value.startsWith(`${runtimeRoot}/`));
      })) continue;
      const command = await readFile(`/proc/${entry}/cmdline`, "utf8");
      owned.push({ pid: Number(entry), openCode: command.includes(`${stateDir}/cli/vendor/opencode/`) });
    } catch (error) {
      if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) throw error;
    }
  }
  return owned;
}
async function until(predicate, message, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await predicate()) return;
    await delay(500);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${message}`);
}
async function request(path, { cookie, csrfToken, body } = {}) {
  const response = await fetch(new URL(path, webOrigin), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: webOrigin,
      "Sec-Fetch-Site": "same-origin",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrfToken ? { "x-space-csrf-token": csrfToken } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000)
  });
  assert.ok(response.ok, `${path.split("?")[0]} returned ${response.status}`);
  return { response, data: await response.json() };
}

assert.equal(await exists(stateDir), false, "Smoke state directory must not already exist");
const runner = spawn(process.execPath, [runnerFile], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
let tail = "";
let runnerError;
for (const stream of [runner.stdout, runner.stderr]) stream.on("data", data => { tail = (tail + data).slice(-64_000); });
runner.on("error", error => { runnerError = error; });
let metadata;
let runningProcesses = [];
let socket;
let hmrSocket;
let failure;
let diagnostics = "";
try {
  process.stdout.write("dev-stack smoke: starting isolated source stack without a TTY\n");
  let readiness;
  await until(async () => {
    if (runnerError) throw runnerError;
    if (runner.exitCode !== null || runner.signalCode !== null) throw new Error("Dev stack exited before readiness; run dev:stack directly for diagnostics");
    try {
      const response = await fetch(`${webOrigin}/readyz?strict=1`, { signal: AbortSignal.timeout(5_000) });
      readiness = await response.json();
      return response.ok && readiness.ok === true;
    } catch { return false; }
  }, "full stack readiness", 12 * 60_000);
  for (const dependency of ["database", "worker", "cliHost"]) {
    assert.equal(readiness.dependencies[dependency], "RUNNING", `${dependency} must be running`);
  }
  metadata = JSON.parse(await readFile(join(stateDir, "stack.json"), "utf8"));
  assert.equal(metadata.apiOrigin, apiOrigin);
  assert.equal(metadata.webOrigin, webOrigin);
  const webPage = await fetch(webOrigin, { signal: AbortSignal.timeout(5_000) });
  assert.ok(webPage.ok);
  assert.match(await webPage.text(), /@vite\/client/, "The browser entry must be served by Vite with HMR");
  assert.ok(metadata.projectName && metadata.runtimeRoot);
  if (process.platform === "linux") {
    for (const child of metadata.processes) {
      const inherited = (await readFile(`/proc/${child.pid}/environ`, "utf8")).split("\0");
      assert.equal(inherited.some(value => value.startsWith("OPENAI_API_KEY=")), false, `${child.name} inherited a provider key`);
      assert.equal(inherited.some(value => value.startsWith("SPACE_INSTANCE_ENABLED_JOBS=")), false, `${child.name} inherited operator background jobs`);
    }
  }
  const tokenFile = join(stateDir, "secrets/setup-token");
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600, "Setup token must have mode 0600");
  const token = (await readFile(tokenFile, "utf8")).trim();
  const { response: claimed, data: owner } = await request("/api/setup/claim", { body: {
    token, email: "dev-stack-smoke@example.invalid", password: randomBytes(20).toString("hex")
  } });
  assert.equal(owner.isAuthenticated, true);
  assert.ok(owner.starterRoomId, "Owner setup must create the starter room");
  const cookie = claimed.headers.getSetCookie().find(value => value.startsWith("space_session_dev="))?.split(";")[0];
  assert.ok(cookie, "Normal owner setup must create the isolated dev session cookie");
  const { data: csrf } = await request("/api/auth/csrf", { cookie });
  const { data: panes } = await request(`/api/panes?roomId=${encodeURIComponent(owner.starterRoomId)}`, { cookie });
  const pane = panes.data.find(value => value.mode === "TERMINAL" && value.terminalRuntimeId === "cli:opencode");
  assert.ok(pane, "Getting Started must contain an OpenCode pane");
  const sessionPath = `/api/panes/${encodeURIComponent(pane.id)}/cli/session`;
  const { data: started } = await request(sessionPath, { cookie, csrfToken: csrf.csrfToken,
    body: { runtimeId: "cli:opencode", includeTranscript: false } });
  assert.ok(started.websocket?.token && started.session?.sessionId, "Pane start must return a terminal ticket");
  const terminalUrl = new URL(`/api/panes/${encodeURIComponent(pane.id)}/cli/terminal`, webOrigin.replace(/^http/, "ws"));
  terminalUrl.searchParams.set("sessionId", started.session.sessionId);
  terminalUrl.searchParams.set("token", started.websocket.token);
  socket = new WebSocket(terminalUrl, { headers: { Cookie: cookie, Origin: webOrigin } });
  let terminalOutput = "";
  let terminalError;
  socket.on("error", error => { terminalError = error; });
  socket.on("message", bytes => {
    try {
      const message = JSON.parse(bytes.toString());
      if (message.type === "output") terminalOutput = (terminalOutput + message.data).slice(-64_000);
      if (message.type === "error") terminalError = new Error(`Terminal error: ${message.code}`);
    } catch { terminalError = new Error("Terminal returned malformed protocol data"); }
  });
  await until(async () => {
    if (terminalError) throw terminalError;
    const { data: current } = await request(`${sessionPath}?includeTranscript=false`, { cookie });
    return current.session.status === "RUNNING" && /opencode|Ask anything|ctrl|connect|Build/i.test(terminalOutput);
  }, "running OpenCode terminal with native UI text after terminal negotiation");
  runningProcesses = await ownedProcesses(metadata.runtimeRoot);
  if (process.platform === "linux") assert.ok(runningProcesses.some(child => child.openCode), "Capture the real OpenCode process for cleanup verification");
  process.stdout.write("dev-stack smoke: owner setup, authenticated terminal attach, and native CLI output passed\n");
  socket.close();
  await until(() => socket.readyState === WebSocket.CLOSED, "terminal socket close", 10_000);

  const viteClient = await fetch(`${webOrigin}/@vite/client`).then(response => response.text());
  const hmrToken = viteClient.match(/const wsToken = ("[^"]+");/);
  assert.ok(hmrToken, "Vite must provide its browser HMR connection token");
  const hmrUrl = new URL(webOrigin.replace(/^http/, "ws"));
  hmrUrl.searchParams.set("token", JSON.parse(hmrToken[1]));
  hmrSocket = new WebSocket(hmrUrl, "vite-hmr", { headers: { Origin: webOrigin } });
  let hmrConnected = false;
  let hmrUpdated = false;
  let hmrError;
  hmrSocket.on("error", error => { hmrError = error; });
  hmrSocket.on("message", bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.type === "connected") hmrConnected = true;
    if (message.type === "update" && message.updates.some(update => update.path === "/src/styles.css")) hmrUpdated = true;
  });
  await until(() => { if (hmrError) throw hmrError; return hmrConnected; }, "Vite HMR connection", 10_000);
  const cssResponse = await fetch(`${webOrigin}/src/styles.css`);
  assert.ok(cssResponse.ok);
  await cssResponse.text();
  const cssFile = join(root, "apps/web/src/styles.css");
  const css = await readFile(cssFile);
  const cssTime = await stat(cssFile);
  try {
    await writeFile(cssFile, Buffer.concat([css, Buffer.from("\n/* dev-stack HMR acceptance */\n")]));
    await until(() => { if (hmrError) throw hmrError; return hmrUpdated; }, "web source hot reload", 20_000);
  } finally {
    await writeFile(cssFile, css);
    await utimes(cssFile, cssTime.atime, cssTime.mtime);
  }
  hmrSocket.close();
  process.stdout.write("dev-stack smoke: web source HMR update passed\n");

  const apiFile = join(root, "apps/api/src/server.ts");
  const previousTime = await stat(apiFile);
  try {
    const before = (await request("/readyz?strict=1")).data.apiStartedAt;
    await utimes(apiFile, new Date(), new Date());
    await until(async () => {
      try { const { data } = await request("/readyz?strict=1"); return data.ok && data.apiStartedAt !== before; }
      catch { return false; }
    }, "API watch restart after source edit");
  } finally { await utimes(apiFile, previousTime.atime, previousTime.mtime); }
  process.stdout.write("dev-stack smoke: API watch restart passed\n");

  metadata = JSON.parse(await readFile(join(stateDir, "stack.json"), "utf8"));
  const worker = metadata.processes.find(value => value.name === "worker");
  assert.ok(worker?.pid, "Supervisor must record the worker it owns");
  process.kill(worker.pid, "SIGTERM");
  await until(() => runner.exitCode !== null || runner.signalCode !== null, "supervisor fail-fast after worker exit", 30_000);
  assert.notEqual(runner.exitCode, 0, "Unexpected worker exit must fail the stack");
  assert.match(tail, /worker[^\n]*(exit|fail|stop)|(exit|fail|stop)[^\n]*worker/i, "Failure must identify the stopped worker");
} catch (error) {
  failure = error;
  diagnostics = tail;
  const redactions = Object.entries(env).filter(([key]) => /KEY|TOKEN|PASS|SECRET|DATABASE_URL|AUTH/i.test(key)).map(([, value]) => value);
  for (const name of ["setup-token", "session-secret", "postgres-password"]) {
    try { redactions.push((await readFile(join(stateDir, "secrets", name), "utf8")).trim()); }
    catch { /* Startup may fail before secrets are created. */ }
  }
  for (const value of redactions) if (value) diagnostics = diagnostics.split(value).join("[redacted]");
}
finally {
  socket?.terminate();
  hmrSocket?.terminate();
  try {
    // Startup can fail before readiness; still verify every resource recorded
    // by the supervisor rather than treating a successful reset as proof alone.
    if (!metadata && await exists(join(stateDir, "stack.json"))) {
      metadata = JSON.parse(await readFile(join(stateDir, "stack.json"), "utf8"));
    }
    await execute(process.execPath, [runnerFile, "reset"], { cwd: root, env, timeout: 90_000 });
    await until(() => !alive(runner.pid), "supervisor cleanup", 15_000);
    assert.equal(await exists(stateDir), false, "Reset must remove its state directory");
    if (metadata) {
      assert.equal(await exists(metadata.runtimeRoot), false, "Reset must remove its runtime sockets");
      for (const child of metadata.processes) assert.equal(alive(child.pid), false, `${child.name} process survived reset`);
      await until(async () => (await ownedProcesses(metadata.runtimeRoot)).length === 0, "all owned service and PTY descendants removed", 15_000);
      for (const child of runningProcesses) assert.equal(alive(child.pid), false, `Owned child ${child.pid} survived reset`);
      for (const command of [["ps", "-aq"], ["volume", "ls", "-q"], ["network", "ls", "-q"]]) {
        const { stdout } = await execute("docker", [...command, "--filter", `label=com.docker.compose.project=${metadata.projectName}`]);
        assert.equal(stdout.trim(), "", "Reset must not leave owned Docker resources");
      }
    }
  } catch (error) {
    if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGTERM");
    failure = failure ? new AggregateError([failure, error], "Dev-stack smoke and cleanup failed") : error;
  }
}
if (failure) {
  if (diagnostics) process.stderr.write(`Dev-stack diagnostics (secrets redacted):\n${diagnostics}\n`);
  throw failure;
}
process.stdout.write(`${JSON.stringify({ mode: "FULL_DEV_STACK", passed: true, ownerSetup: true, cliRunning: true,
  webHotReload: true, apiWatchRestart: true, workerFailureReported: true, cleaned: true })}\n`);
