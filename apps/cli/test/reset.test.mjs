import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  DATABASE_VOLUME,
  recordDockerContext,
  resetLocalState,
} from "../bootstrap/reset.mjs";

function stoppedServices() {
  return { api: false, runtime: false, console: false };
}

test("setup records the active Docker context with owner-only permissions", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "oao-cli-context-"));
  try {
    assert.equal(
      await recordDockerContext(directory, () => ({
        ok: true,
        output: "colima",
      })),
      "colima",
    );
    const path = resolve(directory, ".oao/docker-context");
    assert.equal(await readFile(path, "utf8"), "colima\n");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup does not overwrite a Docker context recorded earlier", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "oao-cli-context-guard-"));
  try {
    await mkdir(resolve(directory, ".oao"), { recursive: true });
    const path = resolve(directory, ".oao/docker-context");
    await writeFile(path, "colima\n");
    await assert.rejects(
      recordDockerContext(directory, () => ({
        ok: true,
        output: "desktop-linux",
      })),
      /differs from setup context colima/u,
    );
    assert.equal(await readFile(path, "utf8"), "colima\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reset requires the exact confirmation before changing anything", async () => {
  const commands = [];
  const removed = [];
  const output = [];
  const result = await resetLocalState({
    repositoryRoot: "/tmp/oao-reset-cancelled",
    inspectServices: stoppedServices,
    confirm: async () => "reset",
    write: (message) => output.push(message),
    runCommand: (...args) => {
      commands.push(args);
      return { ok: true, output: "" };
    },
    removePath: (path) => removed.push(path),
  });
  assert.deepEqual(result, { reset: false, removedVolume: false });
  assert.deepEqual(commands, []);
  assert.deepEqual(removed, []);
  assert.match(output.join(""), /nothing was deleted/u);
});

test("reset refuses to delete data while any OAO service is running", async () => {
  await assert.rejects(
    resetLocalState({
      repositoryRoot: "/tmp/oao-reset-running",
      assumeYes: true,
      inspectServices: async () => ({
        api: true,
        runtime: false,
        console: true,
      }),
      write: () => {},
      runCommand: () => {
        throw new Error("Docker must not be called");
      },
    }),
    /api, console are still running/u,
  );
});

test("reset removes the database volume, settings, and state in an isolated workspace", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "oao-cli-reset-"));
  const commands = [];
  try {
    await mkdir(resolve(directory, ".oao/logs"), { recursive: true });
    await writeFile(resolve(directory, ".env"), "AUTH_PROVIDER=development\n");
    await writeFile(resolve(directory, ".oao/setup-state.json"), "{}\n");
    const result = await resetLocalState({
      repositoryRoot: directory,
      assumeYes: true,
      inspectServices: stoppedServices,
      write: () => {},
      runCommand: (executable, args) => {
        commands.push([executable, args]);
        if (executable === "docker" && args[0] === "context")
          return { ok: true, output: "default" };
        if (executable === "docker" && args[0] === "volume" && args[1] === "ls")
          return { ok: true, output: DATABASE_VOLUME };
        return { ok: true, output: "" };
      },
    });
    assert.deepEqual(result, { reset: true, removedVolume: true });
    assert.equal(existsSync(resolve(directory, ".env")), false);
    assert.equal(existsSync(resolve(directory, ".oao")), false);
    assert.equal(
      commands.some(
        ([executable, args]) =>
          executable === "docker" &&
          args[0] === "volume" &&
          args[1] === "rm" &&
          args[2] === DATABASE_VOLUME,
      ),
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reset refuses a different Docker context without deleting anything", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "oao-cli-reset-context-"));
  try {
    await mkdir(resolve(directory, ".oao"), { recursive: true });
    await writeFile(resolve(directory, ".oao/docker-context"), "colima\n");
    await assert.rejects(
      resetLocalState({
        repositoryRoot: directory,
        assumeYes: true,
        inspectServices: stoppedServices,
        write: () => {},
        runCommand: (executable, args) => {
          if (executable === "docker" && args[0] === "context")
            return { ok: true, output: "desktop-linux" };
          throw new Error("No command after context comparison may run");
        },
      }),
      /differs from setup context colima/u,
    );
    assert.equal(existsSync(resolve(directory, ".oao/docker-context")), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reset keeps the database on an existing PostgreSQL server and skips Docker", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "oao-cli-reset-existing-"));
  const output = [];
  try {
    await mkdir(resolve(directory, ".oao/logs"), { recursive: true });
    await writeFile(
      resolve(directory, ".env"),
      "OAO_POSTGRES_MODE=existing\nDATABASE_URL=postgresql://Jane%20Doe:secret@127.0.0.1:5433/oao\nOAO_CREDENTIAL_ENCRYPTION_KEY=a2V5LWZvci1yZXRhaW5lZC1jcmVkZW50aWFscw==\nOAO_API_PORT=3100\n",
    );
    const result = await resetLocalState({
      repositoryRoot: directory,
      assumeYes: true,
      inspectServices: stoppedServices,
      write: (message) => output.push(message),
      runCommand: () => {
        throw new Error("Docker must not be called");
      },
    });
    assert.deepEqual(result, { reset: true, removedVolume: false });
    // The kept database's credentials need the encryption key; nothing else
    // in .env survives.
    const env = await readFile(resolve(directory, ".env"), "utf8");
    assert.match(
      env,
      /^OAO_CREDENTIAL_ENCRYPTION_KEY=a2V5LWZvci1yZXRhaW5lZC1jcmVkZW50aWFscw==$/mu,
    );
    assert.doesNotMatch(env, /DATABASE_URL|OAO_POSTGRES_MODE|OAO_API_PORT/u);
    assert.equal((await stat(resolve(directory, ".env"))).mode & 0o777, 0o600);
    assert.equal(existsSync(resolve(directory, ".oao")), false);
    const text = output.join("");
    assert.match(
      text,
      /dropdb --host 127\.0\.0\.1 --port 5433 --username 'Jane Doe' oao/u,
    );
    assert.match(text, /credential-encryption key stays in \.env/u);
    assert.doesNotMatch(text, /secret/u);
    assert.doesNotMatch(text, new RegExp(DATABASE_VOLUME, "u"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("later resets keep the key that an earlier reset kept for an existing server", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "oao-cli-reset-again-"));
  const key = "a2V5LWZvci1yZXRhaW5lZC1jcmVkZW50aWFscw==";
  const removed = [];
  const reset = (runCommand) =>
    resetLocalState({
      repositoryRoot: directory,
      assumeYes: true,
      inspectServices: stoppedServices,
      write: () => {},
      runCommand,
      removePath: (path) => {
        removed.push(path);
        rmSync(path, { recursive: true, force: true });
      },
    });
  const noDocker = () => {
    throw new Error("Docker must not be called");
  };
  const docker = (executable, args) => {
    if (executable === "docker" && args[0] === "context")
      return { ok: true, output: "default" };
    if (executable === "docker" && args[0] === "volume" && args[1] === "ls")
      return { ok: true, output: DATABASE_VOLUME };
    return { ok: true, output: "" };
  };
  const kept = new RegExp(
    `^OAO_KEPT_DATABASE=postgresql://Jane%20Doe@127\\.0\\.0\\.1:5433/oao\\nOAO_CREDENTIAL_ENCRYPTION_KEY=${key}$`,
    "mu",
  );
  try {
    await writeFile(
      resolve(directory, ".env"),
      `OAO_POSTGRES_MODE=existing\nDATABASE_URL=postgresql://Jane%20Doe:secret@127.0.0.1:5433/oao\nOAO_CREDENTIAL_ENCRYPTION_KEY=${key}\n`,
    );
    await reset(noDocker);
    const first = await readFile(resolve(directory, ".env"), "utf8");
    assert.match(first, kept);
    assert.doesNotMatch(first, /secret/u);

    // Nothing but the kept key is left, so Docker is not needed.
    await reset(noDocker);
    assert.equal(await readFile(resolve(directory, ".env"), "utf8"), first);

    // After a setup with OAO's own container, reset removes that volume and
    // still keeps the key the other server's database needs.
    await writeFile(
      resolve(directory, ".env"),
      `${first}DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/oao\nOAO_API_PORT=3100\n`,
    );
    assert.deepEqual(await reset(docker), {
      reset: true,
      removedVolume: true,
    });
    assert.equal(await readFile(resolve(directory, ".env"), "utf8"), first);
    // The key's .env is replaced in place, never deleted first.
    assert.ok(removed.length > 0);
    assert.ok(!removed.includes(resolve(directory, ".env")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
