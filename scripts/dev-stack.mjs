#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createDefaultConfig, renderRuntimeEnv } from "../packages/run-spaceapp/src/index.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceComposePath = join(repoRoot, "packages", "run-spaceapp", "templates", "compose.yml");
const stateRoot = resolve(repoRoot, process.env.SPACE_DEV_STACK_STATE_DIR || ".dev-stack");
const stackHash = createHash("sha256").update(JSON.stringify({ repoRoot, stateRoot })).digest("hex").slice(0, 12);
const projectName = `spaceapp-dev-${stackHash}`;
const runtimeRoot = join(tmpdir(), projectName);
const controlSocket = join(runtimeRoot, "control.sock");
const cliHostSocket = join(runtimeRoot, "cli-host.sock");
const composePath = join(stateRoot, "compose.yml");
const manifestPath = join(stateRoot, "stack.json");
const stateMarkerPath = join(stateRoot, ".spaceapp-dev-stack.json");
const runtimeMarkerPath = join(runtimeRoot, ".spaceapp-dev-stack.json");
const setupTokenPath = join(stateRoot, "secrets", "setup-token");
const sessionSecretPath = join(stateRoot, "secrets", "session-secret");
const postgresPasswordPath = join(stateRoot, "secrets", "postgres-password");

const ports = {
  api: portFromEnv("SPACE_DEV_STACK_API_PORT", 14910),
  web: portFromEnv("SPACE_DEV_STACK_WEB_PORT", 14911),
  postgres: portFromEnv("SPACE_DEV_STACK_POSTGRES_PORT", 15432),
  temporal: portFromEnv("SPACE_DEV_STACK_TEMPORAL_PORT", 17233)
};

const apiOrigin = `http://127.0.0.1:${ports.api}`;
const webOrigin = `http://127.0.0.1:${ports.web}`;
const namespace = `spaceapp-dev-${stackHash}`;
const taskQueue = `${namespace}-agent-turns`;
const sharedPackages = [
  "@space/contracts",
  "@space/icons",
  "@space/streaming",
  "@space/opencode-control",
  "@space/memory-graph",
  "@space/browser-host",
  "@space/cli-host",
  "@space/codex-app-server",
  "@space/runtime",
  "@space/db",
  "@space/gateway"
];
const activeCommandChildren = new Set();
let renderedComposeEnv;

function portFromEnv(name, fallback) {
  const value = process.env[name] || String(fallback);
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`${name} must be a TCP port between 1 and 65535.`);
  }
  return Number(value);
}

function commandResult(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      detached: true
    });
    activeCommandChildren.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      activeCommandChildren.delete(child);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      activeCommandChildren.delete(child);
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const detail = options.capture && stderr.trim() ? `\n${stderr.trim()}` : "";
      reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal}.${detail}`));
    });
  });
}

async function terminateActiveCommands() {
  const children = [...activeCommandChildren];
  for (const child of children) {
    if (!child.pid) continue;
    try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  for (const child of children) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }
}

function composeArgs(args) {
  return [
    "compose",
    "--project-name", projectName,
    "--file", composePath,
    "--profile", "workflows",
    ...args
  ];
}

async function composeEnvironment() {
  if (renderedComposeEnv) return renderedComposeEnv;
  const { version } = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const config = {
    ...createDefaultConfig({ version, profile: "standard", accessMode: "isolated", companionsEnabled: false }),
    bindHost: "127.0.0.1",
    port: ports.web
  };
  const defaults = Object.fromEntries(
    renderRuntimeEnv(config)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
  renderedComposeEnv = { ...process.env, ...defaults };
  return renderedComposeEnv;
}

async function compose(args, options = {}) {
  return commandResult("docker", composeArgs(args), {
    ...options,
    env: await composeEnvironment()
  });
}

async function redactSecrets(value) {
  let redacted = String(value);
  for (const path of [postgresPasswordPath, sessionSecretPath, setupTokenPath]) {
    try {
      const secret = (await readFile(path, "utf8")).trim();
      if (secret) redacted = redacted.replaceAll(secret, "[REDACTED]");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return redacted;
}

async function printComposeStartupDiagnostics() {
  process.stderr.write("Compose startup diagnostics:\n");
  for (const args of [
    ["ps", "--all"],
    ["logs", "--no-color", "--tail", "200", "postgres", "temporal"]
  ]) {
    try {
      const { stdout, stderr } = await compose(args, { capture: true });
      const output = await redactSecrets(`${stdout}${stderr}`);
      if (output.trim()) process.stderr.write(`${output.trimEnd()}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${await redactSecrets(message)}\n`);
    }
  }
}

async function pathKind(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readManifest() {
  const stat = await pathKind(manifestPath);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing unexpected dev-stack manifest: ${manifestPath}`);
  const manifest = await readJson(manifestPath);
  if (
    manifest?.repoRoot !== repoRoot || manifest?.stateRoot !== stateRoot ||
    manifest?.projectName !== projectName
  ) {
    throw new Error(`Dev-stack manifest does not belong to this checkout and state directory: ${manifestPath}`);
  }
  return manifest;
}

async function writePrivate(path, value) {
  const stat = await pathKind(path);
  if (stat?.isSymbolicLink()) throw new Error(`Refusing to write through a symbolic link: ${path}`);
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writePrivate(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function ownershipMarker() {
  return { version: 1, repoRoot, stateRoot, projectName };
}

function markerMatches(marker) {
  return marker?.version === 1 && marker.repoRoot === repoRoot && marker.stateRoot === stateRoot &&
    marker.projectName === projectName;
}

async function assertNoSymlinkAncestry(path) {
  let current = resolve(path);
  while (true) {
    const stat = await pathKind(current);
    if (stat?.isSymbolicLink()) throw new Error(`Refusing dev-stack path with symbolic-link ancestry: ${path}`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function readOwnedMarker(markerPath) {
  const stat = await pathKind(markerPath);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null;
  const marker = await readJson(markerPath);
  return markerMatches(marker) ? marker : null;
}

async function ensureOwnedDirectory(path, markerPath) {
  await assertNoSymlinkAncestry(path);
  const stat = await pathKind(path);
  if (stat?.isSymbolicLink()) throw new Error(`Refusing to use symbolic-link dev-stack directory: ${path}`);
  if (stat && !stat.isDirectory()) throw new Error(`Dev-stack path is not a directory: ${path}`);
  if (stat) {
    const marker = await readOwnedMarker(markerPath);
    if (!marker) {
      const entries = await readdir(path);
      if (entries.length > 0) throw new Error(`Refusing to adopt nonempty unmarked dev-stack directory: ${path}`);
    }
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  await writeJsonAtomic(markerPath, ownershipMarker());
}

async function validateOwnedDirectory(path, markerPath) {
  await assertNoSymlinkAncestry(path);
  const stat = await pathKind(path);
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing unexpected dev-stack path: ${path}`);
  if (!(await readOwnedMarker(markerPath))) throw new Error(`Refusing unmarked dev-stack directory: ${path}`);
  return true;
}

async function ensurePrivateSubdirectory(path) {
  await assertNoSymlinkAncestry(path);
  const stat = await pathKind(path);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error(`Refusing unexpected dev-stack subdirectory: ${path}`);
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function initializeDirectories() {
  const stateToRepo = relative(stateRoot, repoRoot);
  if (
    dirname(stateRoot) === stateRoot || stateRoot === repoRoot ||
    (stateToRepo !== "" && !stateToRepo.startsWith("..") && !isAbsolute(stateToRepo))
  ) {
    throw new Error("SPACE_DEV_STACK_STATE_DIR must not be a filesystem root, the repository root, or an ancestor of it.");
  }
  await ensureOwnedDirectory(stateRoot, stateMarkerPath);
  await ensureOwnedDirectory(runtimeRoot, runtimeMarkerPath);
  for (const path of [
    join(stateRoot, "secrets"),
    join(stateRoot, "bin"),
    join(stateRoot, "cli", "providers", "opencode"),
    join(stateRoot, "cli", "imported-credentials"),
    join(stateRoot, "workspaces"),
    join(stateRoot, "artifacts"),
    join(stateRoot, "memory"),
    join(stateRoot, "memory-graph"),
    join(stateRoot, "var"),
    join(stateRoot, "host-home"),
    join(stateRoot, "tmp"),
    join(stateRoot, "xdg", "config"),
    join(stateRoot, "xdg", "data"),
    join(stateRoot, "xdg", "cache"),
    join(stateRoot, "xdg", "state")
  ]) {
    await ensurePrivateSubdirectory(path);
  }
}

async function ensureSecret(path, bytes, prefix = "") {
  const stat = await pathKind(path);
  if (!stat) await writePrivate(path, `${prefix}${randomBytes(bytes).toString("base64url")}`);
  else if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Secret path is not a regular file: ${path}`);
  await chmod(path, 0o600);
  const value = (await readFile(path, "utf8")).trim();
  if (!value) throw new Error(`Secret file is empty: ${path}`);
  return value;
}

async function ensureSecrets() {
  const [postgresPassword, sessionSecret, setupToken] = await Promise.all([
    ensureSecret(postgresPasswordPath, 32),
    ensureSecret(sessionSecretPath, 48),
    ensureSecret(setupTokenPath, 32, "space_setup_")
  ]);
  return { postgresPassword, sessionSecret, setupToken };
}

function yamlString(value) {
  return JSON.stringify(value);
}

async function writeComposeFile() {
  const composeFile = `# Generated by scripts/dev-stack.mjs. Do not edit.\nservices:\n  postgres:\n    extends:\n      file: ${yamlString(sourceComposePath)}\n      service: postgres\n    restart: \"no\"\n    environment:\n      POSTGRES_DB: spaceapp_dev\n      POSTGRES_USER: spaceapp\n      POSTGRES_PASSWORD_FILE: /run/secrets/postgres-password\n    ports:\n      - ${yamlString(`127.0.0.1:${ports.postgres}:5432`)}\n    volumes:\n      - dev-postgres:/var/lib/postgresql/data\n    healthcheck:\n      test: [\"CMD-SHELL\", \"pg_isready -U spaceapp -d spaceapp_dev\"]\n    secrets:\n      - postgres-password\n    networks:\n      - spaceapp\n  temporal:\n    extends:\n      file: ${yamlString(sourceComposePath)}\n      service: temporal\n    restart: \"no\"\n    ports:\n      - ${yamlString(`127.0.0.1:${ports.temporal}:7233`)}\n    volumes:\n      - dev-temporal-secrets:/run/dev-secrets\n    command:\n      - export POSTGRES_PWD=\"$$(cat /run/dev-secrets/postgres-password)\"; exec /etc/temporal/entrypoint.sh autosetup\n    secrets:\n      - postgres-password\n    networks:\n      - spaceapp\nnetworks:\n  spaceapp:\nvolumes:\n  dev-postgres:\n  dev-temporal-secrets:\nsecrets:\n  postgres-password:\n    file: ${yamlString(postgresPasswordPath)}\n`;
  await writePrivate(composePath, composeFile);
}

async function stageTemporalSecret() {
  await compose([
    "run", "--rm", "--no-deps", "-T", "--user", "0:0", "--entrypoint", "/bin/sh", "temporal", "-ec",
    "umask 077; cat /run/secrets/postgres-password > /run/dev-secrets/postgres-password.tmp; " +
      "chown 1000:1000 /run/dev-secrets/postgres-password.tmp; " +
      "chmod 0400 /run/dev-secrets/postgres-password.tmp; " +
      "mv -f /run/dev-secrets/postgres-password.tmp /run/dev-secrets/postgres-password"
  ]);
}

async function assertPrerequisites() {
  if (process.platform === "win32") {
    throw new Error("Run the full source stack inside WSL2 on Windows 11.");
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 22 || minor < 12) {
    throw new Error(`Node.js >=22.12 <23 is required; found ${process.version}.`);
  }
  if (!(await pathKind(join(repoRoot, "node_modules")))) {
    throw new Error("node_modules is missing. Run ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci first.");
  }
  await commandResult("docker", ["compose", "version"], { capture: true });
  const uniquePorts = new Set(Object.values(ports));
  if (uniquePorts.size !== Object.keys(ports).length) throw new Error("Dev-stack ports must be distinct.");
  if (Object.values(ports).some((port) => port === 4910 || port === 4911)) {
    throw new Error("Dev-stack ports must not use the installed SpaceApp ports 4910/4911.");
  }
}

async function assertPortAvailable(port, name) {
  await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", () => reject(new Error(`${name} port 127.0.0.1:${port} is already in use.`)));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(resolvePromise));
  });
}

async function runBuilds() {
  for (const workspace of sharedPackages) {
    await commandResult("npm", ["run", "build", "-w", workspace]);
  }
  await commandResult("npm", ["run", "build", "-w", "@space/worker"]);
}

async function installOpenCode() {
  const dockerfile = await readFile(join(repoRoot, "Dockerfile"), "utf8");
  const match = dockerfile.match(/\bopencode-ai@(\d+\.\d+\.\d+)\b/);
  if (!match) throw new Error("Could not find the pinned opencode-ai version in Dockerfile.");
  const version = match[1];
  const vendorRoot = join(stateRoot, "cli", "vendor", "opencode");
  const installedPackage = join(vendorRoot, "node_modules", "opencode-ai", "package.json");
  const installed = await readJson(installedPackage);
  if (installed?.version !== version) {
    await mkdir(vendorRoot, { recursive: true, mode: 0o700 });
    await writePrivate(join(vendorRoot, "package.json"), `${JSON.stringify({ private: true })}\n`);
    process.stdout.write(`Installing state-local OpenCode ${version}...\n`);
    await commandResult("npm", [
      "install", "--prefix", vendorRoot, "--no-save", "--package-lock=false", "--no-audit", "--no-fund",
      `opencode-ai@${version}`
    ]);
  }
  const opencode = join(vendorRoot, "node_modules", ".bin", "opencode");
  if (!(await pathKind(opencode))) throw new Error(`OpenCode ${version} did not install an executable.`);
  const wrapper = join(stateRoot, "bin", "opencode-vscode-parity");
  const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const providerRoot = join(stateRoot, "cli", "providers", "opencode");
  const script = `#!/usr/bin/env bash\nset -euo pipefail\numask 077\nprovider_root=${quote(providerRoot)}\nopencode=${quote(opencode)}\nexport HOME=\"$provider_root\"\nexport TMPDIR=\"$provider_root/tmp\"\nexport XDG_CONFIG_HOME=\"$provider_root/config\"\nexport XDG_DATA_HOME=\"$provider_root/data\"\nexport XDG_CACHE_HOME=\"$provider_root/cache\"\nexport XDG_STATE_HOME=\"$provider_root/state\"\nmkdir -p \"$HOME\" \"$TMPDIR\" \"$XDG_CONFIG_HOME\" \"$XDG_DATA_HOME\" \"$XDG_CACHE_HOME\" \"$XDG_STATE_HOME\"\ncase \"\${1:-}\" in\n  credential-status) printf 'READY\\n'; exit 0 ;;\n  credential-observation) printf 'OBSERVATION:opencode-local\\n'; exit 0 ;;\n  credential-smoke) \"$opencode\" --version >/dev/null; printf 'SPACE_OPENCODE_OK\\n'; exit 0 ;;\n  inspect-env) printf 'runtime=opencode\\nhome=isolated\\ncredential=none\\n'; exit 0 ;;\n  --run-inner) shift ;;\nesac\nexec \"$opencode\" \"$@\"\n`;
  await writeFile(wrapper, script, { mode: 0o700 });
  await chmod(wrapper, 0o700);
}

function runtimeEnvironment(secrets) {
  const databaseUrl = `postgresql://spaceapp:${encodeURIComponent(secrets.postgresPassword)}@127.0.0.1:${ports.postgres}/spaceapp_dev`;
  const state = (...parts) => join(stateRoot, ...parts);
  const platformEnv = {};
  for (const name of [
    "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "SHELL", "USER", "LOGNAME", "TZ",
    "CI", "GITHUB_ACTIONS", "NO_COLOR", "FORCE_COLOR", "SSL_CERT_FILE", "SSL_CERT_DIR"
  ]) {
    if (process.env[name] !== undefined) platformEnv[name] = process.env[name];
  }
  return {
    ...platformEnv,
    HOME: state("host-home"),
    TMPDIR: state("tmp"),
    XDG_CONFIG_HOME: state("xdg", "config"),
    XDG_DATA_HOME: state("xdg", "data"),
    XDG_CACHE_HOME: state("xdg", "cache"),
    XDG_STATE_HOME: state("xdg", "state"),
    NODE_ENV: "development",
    SPACE_INSTANCE: "dev",
    SPACE_DEV_LOGIN: "false",
    SPACE_SESSION_SECRET: secrets.sessionSecret,
    SPACE_SETUP_TOKEN_FILE: setupTokenPath,
    SPACE_RUNTIME_STORE: "postgres",
    SPACE_DATABASE_URL: databaseUrl,
    SPACE_API_HOST: "127.0.0.1",
    SPACE_API_PORT: String(ports.api),
    SPACE_API_ORIGIN: apiOrigin,
    SPACE_WEB_HOST: "127.0.0.1",
    SPACE_WEB_PORT: String(ports.web),
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${ports.temporal}`,
    SPACE_TEMPORAL_NAMESPACE: namespace,
    SPACE_TEMPORAL_TASK_QUEUE: taskQueue,
    SPACEAPP_WORKFLOWS_ENABLED: "true",
    SPACE_PUBLIC_DISTRIBUTION: "true",
    SPACE_OPTIONAL_MODULES: "none",
    SPACE_TELEMETRY_ENABLED: "false",
    SPACE_AGENT_TOOLS_WRITER: "disabled",
    SPACE_INSTALL_ROOT: repoRoot,
    SPACE_GIT_ROOT: repoRoot,
    SPACE_REPO_ROOT: repoRoot,
    SPACE_ARTIFACT_ROOT: state("artifacts"),
    SPACE_MEMORY_ROOT: state("memory"),
    SPACE_STARTER_MEMORY_ROOT: join(repoRoot, "starter-memory"),
    SPACE_MEMORY_GRAPH_ROOT: state("memory-graph"),
    SPACE_GEMINI_MEMORY_INDEX_PATH: state("memory", "gemini_history.md"),
    SPACE_GEMINI_MEMORY_MONTHLY_PATH: state("memory", "gemini_history_monthly.md"),
    SPACE_GEMINI_MEMORY_LOCK_PATH: state("memory", ".memory.lock"),
    SPACE_CODEX_HOME: state("cli", "providers", "codex"),
    SPACE_CODEX_APP_SERVER_HOME: state("cli", "providers", "codex"),
    SPACE_CODEX_GOALS_DB_PATH: state("var", "codex-goals.sqlite"),
    SPACE_CODEX_CLI_MODE_DEFAULTS_PROJECTION_PATH: state("var", "codex-cli-mode-defaults-v1.json"),
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_COMMAND_PATH: state("bin"),
    SPACE_CLI_WORKSPACE_ROOT: state("workspaces"),
    SPACE_CLI_HOST_SOCKET: cliHostSocket,
    SPACE_CLI_ROOT_ENABLED: "false",
    SPACE_CLI_MAX_RUNNING_SESSIONS: "8",
    SPACE_CLI_VPN_ENABLED: "false",
    SPACE_CLI_MAINTENANCE_REPAIR_ENABLED: "false",
    SPACE_BROWSER_SESSIONS_ENABLED: "false",
    SPACE_BROWSER_HOST_TRANSPORT: "in-process",
    SPACE_BROWSER_SESSIONS_PROFILE_ROOT: state("artifacts", "browser-profiles"),
    SPACE_APP_DIAGNOSTICS_ROOT: state("var", "app-diagnostics"),
    SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE: state("var", "maintenance-autopilot", "state.json"),
    SPACE_CLI_ACCOUNT_BALANCER_STATE_FILE: state("var", "cli-account-balancer", "state.json"),
    SPACE_JOB_APPLY_ROOT: state("artifacts", "job-apply"),
    SPACE_TELEGRAM_SECRET_ROOT: state("secrets", "telegram"),
    SPACE_TELEGRAM_OWNERSHIP_MANIFEST: state("var", "integrations", "telegram", "thread-ownership.json"),
    SPACE_STREAMING_SECRET_ROOT: state("var", "streaming-secrets"),
    SPACE_DEMO_PROJECTS_ENABLED: "false",
    SPACE_DEMO_PROJECTS_ROOT: join(repoRoot, "apps", "web", "public", "demos"),
    SPACE_DEMO_PROJECTS_VAR_ROOT: state("var", "demo-projects"),
    SPACE_PROJECTS_ROOT: state("workspaces", "projects"),
    SPACE_FILES_HOST_MODE: "disabled",
    SPACE_T3CODE_ENABLED: "false",
    SPACE_DOT_TOOL_GATEWAY: "disabled",
    SPACE_CHESS_MOVE_SOCKET: "disabled"
  };
}

async function ensureTemporalNamespace() {
  const base = ["exec", "-T", "temporal", "temporal", "operator", "namespace"];
  try {
    await compose([...base, "describe", "--namespace", namespace, "--address", "temporal:7233"], { capture: true });
  } catch {
    await compose([...base, "create", "--namespace", namespace, "--address", "temporal:7233", "--retention", "24h"]);
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function processBelongsToStack(pid) {
  if (!processAlive(pid)) return false;
  try {
    const { stdout } = await commandResult("ps", ["-p", String(pid), "-o", "command="], { capture: true });
    return stdout.includes(repoRoot) || stdout.includes(projectName) || /(?:^|\s)scripts\/dev-stack\.mjs(?:\s|$)/.test(stdout);
  } catch {
    return false;
  }
}

async function killProcessGroup(pid, signal) {
  if (!(await processBelongsToStack(pid))) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch {}
  }
}

async function waitForExit(pid, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return !processAlive(pid);
}

async function requestSupervisorDown(manifest) {
  if (!manifest?.pidSupervisor || !processAlive(manifest.pidSupervisor)) return;
  const socketPath = manifest.controlSocket || controlSocket;
  const acknowledged = await new Promise((resolvePromise) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => { socket.destroy(); settle(false); }, 5_000);
    socket.once("connect", () => socket.end(`${JSON.stringify({ action: "down" })}\n`));
    socket.on("data", () => settle(true));
    socket.once("error", () => settle(false));
    socket.once("close", () => settle(false));
  });
  if (!acknowledged && await processBelongsToStack(manifest.pidSupervisor)) {
    try { process.kill(manifest.pidSupervisor, "SIGTERM"); } catch {}
  }
  if (!(await waitForExit(manifest.pidSupervisor))) {
    throw new Error(`Dev-stack supervisor ${manifest.pidSupervisor} did not stop.`);
  }
}

async function stopRecordedProcesses(manifest) {
  const processes = Array.isArray(manifest?.processes) ? manifest.processes : [];
  for (const item of processes) await killProcessGroup(Number(item.pid), "SIGTERM");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  for (const item of processes) {
    const pid = Number(item.pid);
    if (await processBelongsToStack(pid)) await killProcessGroup(pid, "SIGKILL");
  }
}

async function assertMarkerAndRemove(path, markerPath) {
  if (!(await validateOwnedDirectory(path, markerPath))) return;
  await rm(path, { recursive: true, force: true });
}

async function down() {
  if (!(await validateOwnedDirectory(stateRoot, stateMarkerPath))) {
    process.stdout.write("SpaceApp dev stack has no state to stop.\n");
    return;
  }
  if (await pathKind(runtimeRoot)) await validateOwnedDirectory(runtimeRoot, runtimeMarkerPath);
  const manifest = await readManifest();
  await requestSupervisorDown(manifest);
  await stopRecordedProcesses(manifest);
  if (await pathKind(composePath)) await compose(["down", "--remove-orphans"]);
  process.stdout.write("SpaceApp dev stack is stopped.\n");
}

async function reset() {
  if (!(await validateOwnedDirectory(stateRoot, stateMarkerPath))) {
    process.stdout.write("SpaceApp dev stack has no state to reset.\n");
    return;
  }
  if (await pathKind(runtimeRoot)) await validateOwnedDirectory(runtimeRoot, runtimeMarkerPath);
  const manifest = await readManifest();
  await requestSupervisorDown(manifest);
  await stopRecordedProcesses(manifest);
  if (await pathKind(composePath)) await compose(["down", "--volumes", "--remove-orphans"]);
  await assertMarkerAndRemove(runtimeRoot, runtimeMarkerPath);
  await assertMarkerAndRemove(stateRoot, stateMarkerPath);
  process.stdout.write("SpaceApp dev stack state, containers, and volumes were removed.\n");
}

async function rebuild() {
  await down();
  await up();
}

function childSpecs(env) {
  const tsx = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const vite = join(repoRoot, "node_modules", "vite", "bin", "vite.js");
  return [
    { name: "cli-host", args: [tsx, "watch", join(repoRoot, "packages", "cli-host", "src", "main.ts")] },
    { name: "api", args: [tsx, "watch", join(repoRoot, "apps", "api", "src", "server.ts")] },
    { name: "worker", args: [join(repoRoot, "apps", "worker", "dist", "worker.js")] },
    { name: "web", args: [vite, "--host", "127.0.0.1", "--port", String(ports.web), "--strictPort"], cwd: join(repoRoot, "apps", "web") }
  ].map((spec) => ({ ...spec, env }));
}

async function waitForSocket(path, children, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pathKind(path)) return;
    const failed = [...children.entries()].find(([, child]) => child.exitCode !== null || child.signalCode !== null);
    if (failed) throw new Error(`${failed[0]} exited before its socket became ready.`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

async function readStrictReadiness() {
  try {
    const response = await fetch(`${apiOrigin}/readyz?strict=1`, { signal: AbortSignal.timeout(5_000) });
    const body = await response.json();
    const ready = response.ok && body.ok === true && body.dependencies?.database === "RUNNING" &&
      body.dependencies?.worker === "RUNNING" && body.dependencies?.cliHost === "RUNNING";
    return { ready, body, detail: `HTTP ${response.status}: ${JSON.stringify(body)}` };
  } catch (error) {
    return { ready: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function waitForReadiness(children, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "API did not answer.";
  while (Date.now() < deadline) {
    const failed = [...children.entries()].find(([, child]) => child.exitCode !== null || child.signalCode !== null);
    if (failed) throw new Error(`${failed[0]} exited before the stack became ready.`);
    const status = await readStrictReadiness();
    last = status.detail;
    if (status.ready) return status.body;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`Timed out waiting for /readyz: ${last}`);
}

async function monitorReadiness(isStopping, graceMs = 20_000) {
  let failureStartedAt = 0;
  let lastFailure = "";
  while (!isStopping()) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    if (isStopping()) return;
    const status = await readStrictReadiness();
    if (status.ready) {
      failureStartedAt = 0;
      lastFailure = "";
      continue;
    }
    lastFailure = status.detail;
    failureStartedAt ||= Date.now();
    if (Date.now() - failureStartedAt >= graceMs) {
      throw new Error(`Strict readiness failed for ${Math.round(graceMs / 1_000)} seconds: ${lastFailure}`);
    }
  }
}

async function startSupervisor(env, setupToken, onSignalHandoff) {
  try { await unlink(controlSocket); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const children = new Map();
  let stopping = false;
  let exitCode = 0;
  let controlServer;

  const manifest = () => ({
    version: 1,
    repoRoot,
    stateRoot,
    runtimeRoot,
    projectName,
    pidSupervisor: process.pid,
    processes: [...children].map(([name, child]) => ({ name, pid: child.pid })),
    controlSocket,
    apiOrigin,
    webOrigin,
    ports
  });

  const persistManifest = () => writeJsonAtomic(manifestPath, manifest());

  const terminateChildren = async () => {
    for (const child of children.values()) {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
      }
    }
    const deadline = Date.now() + 8_000;
    while ([...children.values()].some((child) => child.exitCode === null && child.signalCode === null) && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    for (const child of children.values()) {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
      }
    }
  };

  const shutdown = async (reason, requestedExitCode = 0) => {
    if (stopping) return;
    stopping = true;
    exitCode = Math.max(exitCode, requestedExitCode);
    process.stderr.write(`Stopping SpaceApp dev stack (${reason})...\n`);
    await terminateChildren();
    try { await compose(["down", "--remove-orphans"]); } catch (error) {
      exitCode = 1;
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    if (controlServer) await new Promise((resolvePromise) => controlServer.close(resolvePromise));
    try { await unlink(controlSocket); } catch {}
    try { await persistManifest(); } catch (error) {
      exitCode = 1;
      process.stderr.write(`Could not update the stopped-stack manifest: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exit(exitCode);
  };

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => { void shutdown(signal, signal === "SIGINT" ? 130 : 143); });
  }
  onSignalHandoff?.();

  try {
    for (const spec of childSpecs(env)) {
      const child = spawn(process.execPath, spec.args, {
        cwd: spec.cwd || repoRoot,
        env: spec.env,
        stdio: "inherit",
        detached: true
      });
      children.set(spec.name, child);
      child.once("error", (error) => {
        process.stderr.write(`SpaceApp ${spec.name} failed to start: ${error.message}\n`);
        void shutdown(`${spec.name} start failure`, 1);
      });
      child.once("exit", (code, signal) => {
        if (!stopping) {
          process.stderr.write(`SpaceApp ${spec.name} exited unexpectedly (${code ?? signal}).\n`);
          void shutdown(`${spec.name} exited`, code || 1);
        }
      });
    }

    await persistManifest();
    controlServer = createServer((socket) => {
      let input = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => { input += chunk; });
      socket.on("end", () => {
        try {
          const request = JSON.parse(input.trim());
          if (request.action !== "down") throw new Error("Unknown control action.");
          socket.end(`${JSON.stringify({ ok: true })}\n`);
          setImmediate(() => { void shutdown("down command"); });
        } catch (error) {
          socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
        }
      });
    });
    await new Promise((resolvePromise, reject) => {
      controlServer.once("error", reject);
      controlServer.listen(controlSocket, () => resolvePromise());
    });
    await chmod(controlSocket, 0o600);
    await waitForSocket(cliHostSocket, children);
    await waitForReadiness(children);
    process.stdout.write(`\nSpaceApp source stack is ready.\nURL: ${webOrigin}\nOwner setup token: ${setupToken}\n`);
    process.stdout.write(`State: ${stateRoot}\nRebuild shared packages: npm run dev:stack -- rebuild\n`);
    void monitorReadiness(() => stopping).catch((error) => {
      process.stderr.write(`SpaceApp readiness monitor failed: ${error instanceof Error ? error.message : String(error)}\n`);
      void shutdown("persistent readiness failure", 1);
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    await shutdown("supervisor startup failure", 1);
  }
}

async function up() {
  let composeStarted = false;
  let startupSignal = null;
  const startupSignalHandlers = new Map();
  const removeStartupSignalHandlers = () => {
    for (const [signal, handler] of startupSignalHandlers) process.removeListener(signal, handler);
    startupSignalHandlers.clear();
  };
  const throwIfInterrupted = () => {
    if (!startupSignal) return;
    process.exitCode = startupSignal === "SIGINT" ? 130 : 143;
    throw new Error(`Dev-stack startup interrupted by ${startupSignal}.`);
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      startupSignal = signal;
      void terminateActiveCommands();
    };
    startupSignalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  try {
    await assertPrerequisites();
    throwIfInterrupted();
    await initializeDirectories();
    const existing = await readManifest();
    if (existing?.pidSupervisor && await processBelongsToStack(existing.pidSupervisor)) {
      throw new Error(`SpaceApp dev stack is already running as PID ${existing.pidSupervisor}.`);
    }
    await Promise.all(Object.entries(ports).map(([name, port]) => assertPortAvailable(port, name)));
    throwIfInterrupted();
    const secrets = await ensureSecrets();
    await writeComposeFile();
    await writeJsonAtomic(manifestPath, {
      version: 1, repoRoot, stateRoot, runtimeRoot, projectName, pidSupervisor: process.pid,
      processes: [], controlSocket, apiOrigin, webOrigin, ports
    });
    process.stdout.write("Starting PostgreSQL and Temporal...\n");
    composeStarted = true;
    await compose(["up", "--detach", "--wait", "--wait-timeout", "180", "postgres"]);
    await stageTemporalSecret();
    await compose(["up", "--detach", "--wait", "--wait-timeout", "180", "temporal"]);
    throwIfInterrupted();
    await ensureTemporalNamespace();
    throwIfInterrupted();
    process.stdout.write("Building source dependencies...\n");
    await runBuilds();
    throwIfInterrupted();
    const env = runtimeEnvironment(secrets);
    process.stdout.write("Applying database migrations...\n");
    await commandResult("npm", ["run", "db:migrate"], { env });
    throwIfInterrupted();
    await installOpenCode();
    throwIfInterrupted();
    await startSupervisor(env, secrets.setupToken, removeStartupSignalHandlers);
  } catch (error) {
    removeStartupSignalHandlers();
    if (composeStarted && !startupSignal) await printComposeStartupDiagnostics();
    await terminateActiveCommands();
    if (composeStarted) {
      try { await compose(["down", "--remove-orphans"]); } catch (cleanupError) {
        process.stderr.write(`Startup cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
      }
    }
    throw error;
  }
}

function usage() {
  process.stdout.write(`Usage: npm run dev:stack -- [down|reset|rebuild]\n\n`);
  process.stdout.write(`  (no command)  Start the source stack in the foreground.\n`);
  process.stdout.write(`  down          Stop processes and containers, preserving state.\n`);
  process.stdout.write(`  reset         Stop the stack and remove only its state, containers, and volumes.\n`);
  process.stdout.write(`  rebuild       Stop, rebuild, and restart the source stack in the foreground.\n`);
}

const command = process.argv[2] || "up";
try {
  if (command === "up") await up();
  else if (command === "down") await down();
  else if (command === "reset") await reset();
  else if (command === "rebuild") await rebuild();
  else if (command === "help" || command === "--help" || command === "-h") usage();
  else throw new Error(`Unknown dev-stack command: ${command}`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode ||= 1;
}
