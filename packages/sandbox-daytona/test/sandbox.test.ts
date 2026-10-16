import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type {
  OrganizationId,
  ProjectId,
  RunId,
  SessionId,
  ThreadId,
} from "@oao/domain";
import { OMITTED_IMAGE_DATA } from "@oao/domain";
import { createTestPng, pngDimensions } from "@oao/testkit";
import { createReadTool, type Sandbox } from "@flue/runtime";
import type { CommandRecord, SandboxRepository } from "../src/index.js";
import {
  DAYTONA_TARGET_POSTURE,
  DaytonaManagedProvider,
  FakeSandboxProvider,
  ManagedSandboxLifecycle,
  createFakeFlueSandbox,
  daytonaSandboxRecoveryAction,
  safeSandboxToolCommand,
  sandboxWorkspaceLifecycleIdentity,
  withDurableToolAudit,
  workspaceBackupIdentityForRun,
} from "../src/index.js";
import { isReservedWorkspaceSkillPath } from "../src/flue-daytona-blueprint.js";

const tenant = {
  organizationId: "00000000-0000-4000-8000-000000000001" as OrganizationId,
  projectId: "00000000-0000-4000-8000-000000000002" as ProjectId,
} as const;

test("project Daytona credentials use the encrypted provider schema", async () => {
  const source = await readFile(
    new URL("../src/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /SELECT id,provider_type,encrypted_api_key,encryption_nonce,\s+encryption_tag,encryption_key_version,target,restricted_egress/u,
  );
  assert.doesNotMatch(
    source,
    /credential_(?:ciphertext|nonce|tag|key_version)/u,
  );
  assert.doesNotMatch(source, /DEFAULT_DAYTONA_IMAGE/u);
  assert.doesNotMatch(source, /flue-daytona:2\.0\.3/u);
});

test("dead Daytona builds are never reused during recovery", () => {
  assert.equal(daytonaSandboxRecoveryAction("build_failed"), "skip");
  assert.equal(daytonaSandboxRecoveryAction("destroyed"), "skip");
  assert.equal(daytonaSandboxRecoveryAction("error"), "recover");
  assert.equal(daytonaSandboxRecoveryAction("stopped"), "start");
  assert.equal(daytonaSandboxRecoveryAction("started"), "reuse");
});

test("coordinator and child threads derive one sandbox lifecycle from the workspace owner", () => {
  const root = sandboxWorkspaceLifecycleIdentity({
    organizationId: tenant.organizationId,
    projectId: tenant.projectId,
    ownerThreadId: "00000000-0000-4000-8000-000000000010",
  });
  const childUsingRoot = sandboxWorkspaceLifecycleIdentity({
    organizationId: tenant.organizationId,
    projectId: tenant.projectId,
    ownerThreadId: "00000000-0000-4000-8000-000000000010",
  });
  const isolatedChild = sandboxWorkspaceLifecycleIdentity({
    organizationId: tenant.organizationId,
    projectId: tenant.projectId,
    ownerThreadId: "00000000-0000-4000-8000-000000000011",
  });
  assert.equal(root, childUsingRoot);
  assert.notEqual(root, isolatedChild);
});

test("workspace backups record the current owning run and preserve shared-owner identity", () => {
  const current = workspaceBackupIdentityForRun({
    ...tenant,
    runId: "00000000-0000-4000-8000-000000000021" as RunId,
    threadId: "00000000-0000-4000-8000-000000000022" as ThreadId,
    sessionId: "00000000-0000-4000-8000-000000000023" as SessionId,
    workspaceOwnerRunId: "00000000-0000-4000-8000-000000000020" as RunId,
    workspaceOwnerThreadId: "00000000-0000-4000-8000-000000000022" as ThreadId,
    workspaceOwnerSessionId:
      "00000000-0000-4000-8000-000000000023" as SessionId,
  });
  assert.equal(current.runId, "00000000-0000-4000-8000-000000000021");

  const shared = workspaceBackupIdentityForRun({
    ...tenant,
    runId: "00000000-0000-4000-8000-000000000031" as RunId,
    threadId: "00000000-0000-4000-8000-000000000032" as ThreadId,
    sessionId: "00000000-0000-4000-8000-000000000033" as SessionId,
    workspaceOwnerRunId: "00000000-0000-4000-8000-000000000020" as RunId,
    workspaceOwnerThreadId: "00000000-0000-4000-8000-000000000022" as ThreadId,
    workspaceOwnerSessionId:
      "00000000-0000-4000-8000-000000000023" as SessionId,
  });
  assert.equal(shared.runId, "00000000-0000-4000-8000-000000000020");
  assert.equal(shared.threadId, "00000000-0000-4000-8000-000000000022");
  assert.equal(shared.sessionId, "00000000-0000-4000-8000-000000000023");
});

test("mutable workspace Skills are hidden from Flue discovery", () => {
  assert.equal(isReservedWorkspaceSkillPath(".agents/skills"), true);
  assert.equal(
    isReservedWorkspaceSkillPath("/workspace/.agents/skills/local/SKILL.md"),
    true,
  );
  assert.equal(
    isReservedWorkspaceSkillPath("/workspace/.agents/skills-archive/readme.md"),
    false,
  );
  assert.equal(isReservedWorkspaceSkillPath("/workspace/src/index.ts"), false);
});

test("sandbox tool transcript keeps content while masking credentials", () => {
  const write = safeSandboxToolCommand("write", {
    path: "/root/test.csv",
    content: "customer,secret\nAlice,do-not-store",
  });
  assert.deepEqual(write, {
    toolName: "write",
    arguments: {
      path: "/root/test.csv",
      content: "customer,secret\nAlice,do-not-store",
    },
  });

  const edit = safeSandboxToolCommand("edit", {
    path: "/root/test.csv",
    oldText: "Alice",
    newText: "Bob",
  });
  assert.deepEqual(edit, {
    toolName: "edit",
    arguments: {
      path: "/root/test.csv",
      oldText: "Alice",
      newText: "Bob",
    },
  });

  assert.deepEqual(
    safeSandboxToolCommand("bash", { command: "/usr/bin/python report.py" }),
    {
      toolName: "bash",
      arguments: { command: "/usr/bin/python report.py" },
    },
  );
  const secretCommand = safeSandboxToolCommand("bash", {
    command: "API_KEY=do-not-store curl https://example.test/private",
  });
  assert.deepEqual(secretCommand, {
    toolName: "bash",
    arguments: {
      command: "API_KEY=[REDACTED] curl https://example.test/private",
    },
  });
  assert.doesNotMatch(JSON.stringify(secretCommand), /do-not-store/u);

  const navigation = safeSandboxToolCommand("browser_navigate", {
    url: "https://user:password@example.test/private?token=do-not-store",
  });
  assert.deepEqual(navigation, {
    toolName: "browser_navigate",
    arguments: {
      url: "https://[REDACTED]@example.test/private?token=[REDACTED]",
    },
  });
  assert.doesNotMatch(JSON.stringify(navigation), /password|do-not-store/u);
});

test("workspace backup and restore use Daytona's model-facing workdir", async () => {
  const commands: { readonly command: string; readonly cwd?: string }[] = [];
  const uploads: { readonly path: string; readonly bytes: Buffer }[] = [];
  const native = {
    getWorkDir: async () => "/root",
    process: {
      executeCommand: async (command: string, cwd?: string) => {
        commands.push({ command, ...(cwd ? { cwd } : {}) });
        return { exitCode: 0, result: "" };
      },
    },
    fs: {
      downloadFile: async () => Buffer.from([31, 139, 8, 0]),
      listFiles: async () => [
        ...[
          ".bash_logout",
          ".bashrc",
          ".face",
          ".face.icon",
          ".profile",
          ".zshrc",
        ].map((name) => ({
          name,
          path: `/root/${name}`,
          isDir: false,
          size: 10,
        })),
        {
          name: "output.log",
          path: "/root/.daytona/sessions/entrypoint/output.log",
          isDir: false,
          size: 12,
        },
        {
          name: ".oao",
          path: "/root/.oao",
          isDir: true,
          size: 0,
        },
        {
          name: "input.xlsx",
          path: "/root/.oao/attachments/run/input.xlsx",
          isDir: false,
          size: 10858,
        },
        {
          name: "result.csv",
          path: "/root/output/result.csv",
          isDir: false,
          size: 42,
        },
      ],
      uploadFile: async (bytes: Buffer, path: string) => {
        uploads.push({ path, bytes: Buffer.from(bytes) });
      },
    },
  };
  const handle = {
    providerRef: "sandbox-workdir-test",
    target: "test",
    native,
  };
  const provider = new DaytonaManagedProvider({ apiKey: "test-key" });

  assert.deepEqual(
    await provider.captureWorkspace(handle),
    new Uint8Array([31, 139, 8, 0]),
  );
  const capture = commands.find((entry) =>
    entry.command.startsWith("tar --exclude="),
  );
  assert.equal(capture?.cwd, "/root");
  assert.doesNotMatch(capture?.command ?? "", /home\/daytona/u);
  for (const path of [
    ".daytona",
    ".bash_logout",
    ".bashrc",
    ".face",
    ".face.icon",
    ".profile",
    ".zshrc",
  ])
    assert.ok(capture?.command.includes(`--exclude='./${path}'`));
  assert.deepEqual(await provider.listWorkspaceFiles(handle), [
    {
      name: "input.xlsx",
      path: ".oao/attachments/run/input.xlsx",
      sizeBytes: 10858,
    },
    { name: "result.csv", path: "output/result.csv", sizeBytes: 42 },
  ]);

  commands.length = 0;
  await provider.restoreWorkspace(handle, new Uint8Array([31, 139, 8, 0]));
  const restore = commands.find((entry) =>
    entry.command.includes("--no-same-owner --no-same-permissions -xzf"),
  );
  assert.equal(restore?.cwd, "/root");
  assert.doesNotMatch(restore?.command ?? "", /home\/daytona/u);
  assert.match(restore?.command ?? "", /--exclude='\.\/\.daytona'/u);
  assert.deepEqual(uploads, [
    {
      path: "/tmp/oao-workspace-restore.tar.gz",
      bytes: Buffer.from([31, 139, 8, 0]),
    },
  ]);
});

test("fake sandbox creation, recovery and command results are fenced", async () => {
  let instanceState: "creating" | "running" | "stopped" = "creating";
  let commandResult:
    { readonly exitCode: number; readonly redactedOutput: string } | undefined;
  const repository: SandboxRepository = {
    async reserveInstance(input) {
      return {
        ...tenant,
        id: input.id,
        runId: input.runId,
        creatorRunId: input.runId,
        threadId: input.threadId,
        sessionId: input.sessionId,
        creationKey: input.creationKey,
        fence: 1n,
        state: instanceState,
        target: "provider-default",
      };
    },
    async markRunning(record, handle) {
      instanceState = "running";
      return { ...record, state: "running", providerRef: handle.providerRef };
    },
    async markFailed() {
      instanceState = "stopped";
    },
    async markStopped() {
      instanceState = "stopped";
    },
    async reserveCommand(input) {
      return {
        id: input.commandId,
        fence: 1n,
        state: commandResult ? "completed" : "reserved",
        ...(commandResult ? { result: commandResult } : {}),
      };
    },
    async markCommandRunning(_input, command) {
      return { ...command, fence: command.fence + 1n, state: "running" };
    },
    async completeCommand(_input, command, result) {
      commandResult = result;
      return { ...command, state: "completed", result };
    },
    async failCommand(_input, command) {
      return {
        ...command,
        state: "failed",
        result: { exitCode: -1, redactedOutput: "Sandbox command failed" },
      };
    },
    async recordArtifact(input) {
      assert.equal(input.artifactRef, "s3://artifacts/result.txt");
    },
  };
  const provider = new FakeSandboxProvider();
  const manager = new ManagedSandboxLifecycle(repository, provider);
  const input = {
    ...tenant,
    sandboxId: "00000000-0000-4000-8000-000000000020",
    runId: "00000000-0000-4000-8000-000000000010" as RunId,
    threadId: "00000000-0000-4000-8000-000000000011" as ThreadId,
    sessionId: "00000000-0000-4000-8000-000000000012" as SessionId,
    creationKey: "sandbox:run-10",
    snapshotId: "00000000-0000-4000-8000-000000000099",
    egress: { mode: "none" as const },
  };
  const first = await manager.ensure(input);
  const recovered = await manager.ensure(input);
  assert.equal(first.handle.providerRef, recovered.handle.providerRef);
  assert.equal(
    provider.calls.filter((call) => call.startsWith("create:")).length,
    1,
  );
  const command = {
    commandId: "00000000-0000-4000-8000-000000000030",
    commandKey: "command:run-10:1",
    command: "printf safe",
    timeoutMs: 1_000,
  };
  assert.deepEqual(await manager.execute(first, command), {
    exitCode: 0,
    redactedOutput: "deterministic sandbox output",
  });
  assert.deepEqual(await manager.execute(first, command), commandResult);
  assert.equal(
    provider.calls.filter((call) => call.startsWith("execute:")).length,
    1,
  );
  await manager.recordArtifact(first, {
    artifactId: "00000000-0000-4000-8000-000000000031",
    commandId: command.commandId,
    artifactKey: "result.txt",
    artifactRef: "s3://artifacts/result.txt",
    contentType: "text/plain",
    sizeBytes: 4,
    sha256: createHash("sha256").update("safe").digest(),
  });
  assert.equal(DAYTONA_TARGET_POSTURE.strictResidencyEnforced, false);
});

test("sandbox capabilities map to the exact model-facing tool set", async () => {
  const fileFactory = createFakeFlueSandbox([
    "filesystem_read",
    "filesystem_write",
  ]);
  const fileSandbox = await fileFactory.createSandbox({ id: "files" });
  assert.deepEqual(
    fileFactory
      .tools?.(fileSandbox, { subagents: {} })
      .map((tool) => tool.name),
    ["read", "write", "edit"],
  );

  const browserFactory = createFakeFlueSandbox(["browser"]);
  const browserSandbox = await browserFactory.createSandbox({ id: "browser" });
  const browserTools = browserFactory.tools?.(browserSandbox, {
    subagents: {},
  });
  assert.deepEqual(
    browserTools?.map((tool) => tool.name),
    ["browser_navigate", "browser_snapshot", "browser_interact"],
  );
  const navigate = browserTools?.find(
    (tool) => tool.name === "browser_navigate",
  );
  const snapshot = browserTools?.find(
    (tool) => tool.name === "browser_snapshot",
  );
  assert.ok(navigate && snapshot);
  await navigate.execute("call-1", { url: "https://example.test/path" });
  const result = await snapshot.execute("call-2", {});
  assert.match(
    result.content.find((entry) => entry.type === "text")?.text ?? "",
    /https:\/\/example\.test\/path/u,
  );
});

async function readTool(
  capabilities: Parameters<typeof createFakeFlueSandbox>[0] = [
    "filesystem_read",
    "shell",
  ],
) {
  const factory = createFakeFlueSandbox(capabilities);
  const sandbox = await factory.createSandbox({ id: "read" });
  const read = factory
    .tools?.(sandbox, { subagents: {} })
    .find((tool) => tool.name === "read");
  assert.ok(read);
  return { sandbox, read };
}

function textOf(result: { readonly content: readonly unknown[] }): string {
  return result.content
    .flatMap((entry) =>
      (entry as { type: string }).type === "text"
        ? [(entry as { text: string }).text]
        : [],
    )
    .join("\n");
}

test("read returns a PNG containing NUL bytes as image content", async () => {
  const { sandbox, read } = await readTool();
  const png = createTestPng(640, 400);
  assert.ok(png.includes(0));
  // Same bytes as the incident: a macOS screenshot copied to an ASCII path.
  await sandbox.writeFile("/tmp/screen0.png", png);
  const result = await read.execute("read-png", { path: "/tmp/screen0.png" });
  const image = result.content.find((entry) => entry.type === "image");
  assert.ok(image && image.type === "image");
  assert.equal(image.mimeType, "image/png");
  assert.deepEqual(Buffer.from(image.data, "base64"), png);
  assert.match(textOf(result), /is an image \(image\/png, 640x400 px\)/u);
  assert.ok(!textOf(result).includes("\0"));
  assert.equal(result.details.mimeType, "image/png");
});

test("read downscales large images to the model image bound", async () => {
  const { sandbox, read } = await readTool();
  await sandbox.writeFile("screenshot.png", createTestPng(2880, 1800));
  const result = await read.execute("read-large", { path: "screenshot.png" });
  const image = result.content.find((entry) => entry.type === "image");
  assert.ok(image && image.type === "image");
  assert.deepEqual(pngDimensions(Buffer.from(image.data, "base64")), {
    width: 2000,
    height: 1250,
  });
  assert.match(
    textOf(result),
    /2880x1800 px\), shown below as image\/png at 2000x1250 px/u,
  );
});

test("read names other binary files instead of returning garbled text", async () => {
  const { sandbox, read } = await readTool();
  await sandbox.writeFile(
    "scan.pdf",
    Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from([0, 1, 2, 255])]),
  );
  const pdf = await read.execute("read-pdf", { path: "scan.pdf" });
  assert.match(
    textOf(pdf),
    /^"scan\.pdf" is a binary file \(application\/pdf, PDF document, 13 bytes\)\. The read tool returns only text and images\. Inspect or convert it with the bash tool instead\.$/u,
  );
  assert.equal(pdf.content.length, 1);

  await sandbox.writeFile("broken.png", createTestPng(64, 64).subarray(0, 40));
  assert.match(
    textOf(await read.execute("read-broken", { path: "broken.png" })),
    /is a binary file \(image\/png, an image that cannot be shown: The image could not be decoded/u,
  );

  const readOnly = await readTool(["filesystem_read"]);
  await readOnly.sandbox.writeFile("blob.bin", Buffer.from([1, 0, 2]));
  assert.match(
    textOf(await readOnly.read.execute("read-blob", { path: "blob.bin" })),
    /application\/octet-stream, binary data, 3 bytes\).*no shell tool/u,
  );
});

test("read keeps Flue text formatting, offsets, and packaged Skills", async () => {
  const { sandbox, read } = await readTool();
  await sandbox.writeFile(
    "notes.txt",
    Array.from({ length: 2_500 }, (_, line) => `line ${line + 1}`).join("\n"),
  );
  const fluesRead = createReadTool(sandbox);
  for (const params of [
    { path: "notes.txt" },
    { path: "notes.txt", offset: 2, limit: 1 },
  ]) {
    const result = await read.execute("read-text", params);
    assert.deepEqual(result, await fluesRead.execute("flue-read", params));
  }
  assert.match(
    textOf(await read.execute("read-text", { path: "notes.txt" })),
    /\[Showing lines 1-2000 of 2500\. Use offset=2001 to continue\.\]$/u,
  );
  const overlay: Sandbox = {
    ...sandbox,
    readFile: async (path) =>
      path.startsWith("/.flue/packaged-skills/")
        ? "packaged resource"
        : sandbox.readFile(path),
  };
  const packagedRead = createFakeFlueSandbox(["filesystem_read"])
    .tools?.(overlay, { subagents: {} })
    .find((tool) => tool.name === "read");
  assert.ok(packagedRead);
  assert.equal(
    textOf(
      await packagedRead.execute("read-skill", {
        path: "/.flue/packaged-skills/skill/references/codes.md",
      }),
    ),
    "packaged resource",
  );
});

test("sandbox tool log omits image bytes and NUL text", () => {
  const command = safeSandboxToolCommand("write", {
    path: "data.bin",
    content: "head\u0000tail\ud800",
  });
  assert.deepEqual(command.arguments, {
    path: "data.bin",
    content: "head\uFFFDtail\uFFFD",
  });
});

class RecordingRepository {
  readonly completed: unknown[] = [];
  failed = 0;
  completeFailures = 0;

  async reserveCommand(): Promise<CommandRecord> {
    return { id: "command", fence: 1n, state: "reserved" };
  }
  async markCommandRunning(): Promise<CommandRecord> {
    return { id: "command", fence: 2n, state: "running" };
  }
  async completeCommand(
    _instance: unknown,
    command: CommandRecord,
    result: unknown,
  ): Promise<CommandRecord> {
    if (this.completeFailures > 0) {
      this.completeFailures -= 1;
      throw new Error("unsupported Unicode escape sequence");
    }
    this.completed.push(result);
    return { ...command, state: "completed" };
  }
  async failCommand(
    _instance: unknown,
    command: CommandRecord,
  ): Promise<CommandRecord> {
    this.failed += 1;
    return { ...command, state: "failed" };
  }
}

test("a failed tool log write never turns a successful tool call into an error", async () => {
  const { sandbox, read } = await readTool();
  await sandbox.writeFile("chart.png", createTestPng(32, 32));
  const repository = new RecordingRepository();
  const [audited] = withDurableToolAudit(
    [read],
    repository as unknown as SandboxRepository,
    {
      record: {
        ...tenant,
        id: "sandbox",
        runId: "00000000-0000-4000-8000-000000000010" as RunId,
        creatorRunId: "00000000-0000-4000-8000-000000000010" as RunId,
        threadId: "00000000-0000-4000-8000-000000000011" as ThreadId,
        sessionId: "00000000-0000-4000-8000-000000000012" as SessionId,
        creationKey: "sandbox",
        fence: 1n,
        state: "running",
        target: "provider-default",
      },
    },
  );
  assert.ok(audited);

  const stored = await audited.execute("audit-image", { path: "chart.png" });
  assert.equal(
    stored.content.find((entry) => entry.type === "image")?.type,
    "image",
  );
  const output = JSON.stringify(repository.completed[0]);
  assert.match(
    output,
    new RegExp(OMITTED_IMAGE_DATA.replace(/[[\]]/gu, "\\$&"), "u"),
  );
  assert.doesNotMatch(output, /iVBORw0KGgo/u);

  repository.completeFailures = 1;
  const result = await audited.execute("audit-retry", { path: "chart.png" });
  assert.equal(result.content.length, 2);
  assert.equal(repository.failed, 0);
  assert.deepEqual(repository.completed[1], {
    exitCode: 0,
    redactedOutput: "Sandbox tool completed; its output could not be recorded",
  });

  await assert.rejects(
    audited.execute("audit-missing", { path: "missing.png" }),
    /File not found/u,
  );
  assert.equal(repository.failed, 1);
});
