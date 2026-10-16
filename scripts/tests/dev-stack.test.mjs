import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const source = new URL("../dev-stack.mjs", import.meta.url);
const unixOnly = { skip: process.platform === "win32" ? "Source stack runs in WSL on Windows" : false };
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return String(port);
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "space-dev-contract-"));
  const cleanups = [];
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const repo = join(directory, "repo");
  const bin = join(directory, "bin");
  await mkdir(join(repo, "scripts"), { recursive: true });
  await mkdir(join(repo, "node_modules"));
  await mkdir(bin);
  const script = join(repo, "scripts/dev-stack.mjs");
  await copyFile(source, script);
  await cp(new URL("../../packages/run-spaceapp/src", import.meta.url), join(repo, "packages/run-spaceapp/src"), { recursive: true });
  await copyFile(new URL("../../packages/run-spaceapp/package.json", import.meta.url), join(repo, "packages/run-spaceapp/package.json"));
  await writeFile(join(repo, "package.json"), JSON.stringify({ version: "0.2.5", type: "module" }));
  // A local stub prevents these lifecycle-contract tests from touching Docker.
  // Failing at compose up leaves enough owned metadata to test reset and secrets.
  await writeFile(join(bin, "docker"), '#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = up ]; then echo fixture-startup-stop >&2; exit 9; fi\ndone\nexit 0\n', { mode: 0o700 });
  const portNames = ["API", "WEB", "POSTGRES", "TEMPORAL"];
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  for (const name of portNames) env[`SPACE_DEV_STACK_${name}_PORT`] = await freePort();
  const run = async (state, command, overrides = {}) => {
    try {
      const result = await execute(process.execPath, [script, ...(command ? [command] : [])], {
        cwd: repo, env: { ...env, ...overrides, SPACE_DEV_STACK_STATE_DIR: state }, timeout: 15_000
      });
      return { ...result, code: 0 };
    } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  return { directory, repo, run, cleanups };
}

test("reset refuses an unmarked directory without changing its files or permissions", unixOnly, async t => {
  const { directory, run } = await fixture(t);
  const state = join(directory, "unowned");
  await mkdir(state, { mode: 0o755 });
  await writeFile(join(state, "keep.txt"), "existing data");
  const beforeMode = (await stat(state)).mode & 0o777;
  const result = await run(state, "reset");
  assert.notEqual(result.code, 0);
  assert.equal(await readFile(join(state, "keep.txt"), "utf8"), "existing data");
  assert.equal((await stat(state)).mode & 0o777, beforeMode);
});

test("every service refuses both reserved installed-app ports before creating state", unixOnly, async t => {
  const { directory, run } = await fixture(t);
  const state = join(directory, "reserved-port");
  for (const service of ["API", "WEB", "POSTGRES", "TEMPORAL"]) {
    for (const port of ["4910", "4911"]) {
      const result = await run(state, undefined, { [`SPACE_DEV_STACK_${service}_PORT`]: port });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /4910.*4911|4911.*4910/);
      assert.doesNotMatch(result.stderr, /fixture-startup-stop/);
      await assert.rejects(stat(state), { code: "ENOENT" });
    }
  }
});

test("startup refuses to adopt an existing unmarked directory or an ancestor of its checkout", unixOnly, async t => {
  const { directory, run } = await fixture(t);
  const state = join(directory, "existing");
  await mkdir(state, { mode: 0o755 });
  await writeFile(join(state, "keep.txt"), "existing data");
  const beforeMode = (await stat(state)).mode & 0o777;
  for (const target of [state, directory]) {
    const result = await run(target);
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(result.stderr, /fixture-startup-stop/, "Unsafe state must be refused before starting services");
    await assert.rejects(readFile(join(target, ".spaceapp-dev-stack.json")), { code: "ENOENT" });
  }
  assert.equal((await stat(state)).mode & 0o777, beforeMode);
  assert.equal(await readFile(join(state, "keep.txt"), "utf8"), "existing data");
});

test("independent state directories get private secrets and separate Docker/socket ownership", unixOnly, async t => {
  const { directory, repo, run, cleanups } = await fixture(t);
  const records = [];
  for (const name of ["first", "second"]) {
    const state = join(directory, name);
    const result = await run(state);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /fixture-startup-stop/);
    const metadata = JSON.parse(await readFile(join(state, "stack.json"), "utf8"));
    assert.equal(metadata.repoRoot, repo);
    assert.equal(metadata.stateRoot, state);
    for (const secret of ["setup-token", "session-secret", "postgres-password"]) {
      assert.equal((await stat(join(state, "secrets", secret))).mode & 0o777, 0o600);
    }
    records.push(metadata);
    cleanups.push(async () => {
      const stopped = await run(state, "reset");
      assert.equal(stopped.code, 0, stopped.stderr);
      await assert.rejects(stat(state), { code: "ENOENT" });
      await assert.rejects(stat(metadata.runtimeRoot), { code: "ENOENT" });
    });
  }
  assert.notEqual(records[0].projectName, records[1].projectName);
  assert.notEqual(records[0].runtimeRoot, records[1].runtimeRoot);
});
