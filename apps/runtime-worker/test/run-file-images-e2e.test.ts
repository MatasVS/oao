import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createPool, type PgPool } from "@oao/db-postgres";
import type {
  OrganizationId,
  PrincipalId,
  ProjectArtifactStoreResolverPort,
  ProjectId,
  RunId,
  ThreadId,
} from "@oao/domain";
import {
  fauxAssistantMessage,
  type FauxResponseStep,
} from "@oao/models-openrouter";
import { FakeSandboxProvider } from "@oao/sandbox-daytona";
import { createTestPng, pngDimensions } from "@oao/testkit";
import { startRuntimeWorker, type RuntimeWorkerHandle } from "../src/main.js";

const databaseUrl = process.env.DATABASE_URL;
const testAdminDatabaseUrl =
  process.env.OAO_TEST_ADMIN_DATABASE_URL ?? databaseUrl;

function uuid(label: string): string {
  const bytes = createHash("sha256").update(label).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const tenant = {
  organizationId: uuid("run-file-images-e2e-org") as OrganizationId,
  projectId: uuid("run-file-images-e2e-project") as ProjectId,
};
const human = uuid("run-file-images-e2e-human") as PrincipalId;
const service = uuid("run-file-images-e2e-service") as PrincipalId;
const storageProviderId = uuid("run-file-images-e2e-storage");
// A macOS Retina screenshot is larger than the 2000 px model bound.
const screenshot = createTestPng(2880, 1800);
const notes = Buffer.from("Compare the screenshot with the release notes.");
const PNG_BASE64_PREFIX = "iVBORw0KGgo";

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(",")}}`;
}

function runFiles(runId: RunId) {
  return [
    { name: "screen.png", contentType: "image/png", bytes: screenshot },
    { name: "notes.txt", contentType: "text/plain", bytes: notes },
  ].map((file) => {
    const id = uuid(`${runId}:${file.name}`);
    return {
      manifest: {
        id,
        name: file.name,
        contentType: file.contentType,
        sizeBytes: file.bytes.byteLength,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
        storageProviderId,
        objectKey: `run-files/runs/${runId}/${id}/${file.name}`,
      },
      bytes: file.bytes,
    };
  });
}

/** In-memory run attachment storage standing in for S3. */
function memoryRunFileStorage(
  objects: ReadonlyMap<
    string,
    { readonly bytes: Buffer; readonly contentType: string }
  >,
  failures: Map<string, number> = new Map(),
): ProjectArtifactStoreResolverPort {
  return {
    async resolve() {
      return {
        providerId: storageProviderId,
        store: {
          async put() {
            throw new Error("Run file storage is read-only in this test");
          },
          async get(request: {
            readonly tenant: unknown;
            readonly key: string;
          }) {
            for (const [runId, remaining] of failures)
              if (remaining > 0 && request.key.includes(runId)) {
                failures.set(runId, remaining - 1);
                throw new Error("Object storage is temporarily unavailable");
              }
            const object = objects.get(request.key);
            return object
              ? {
                  tenant: request.tenant,
                  key: request.key,
                  bytes: object.bytes,
                  contentType: object.contentType,
                }
              : undefined;
          },
          async head() {
            return undefined;
          },
          async list() {
            return { prefix: "", folders: [], objects: [], truncated: false };
          },
          async delete() {},
        },
      };
    },
  } as unknown as ProjectArtifactStoreResolverPort;
}

async function seedTenant(pool: PgPool): Promise<void> {
  await pool.query(
    "INSERT INTO oao.organizations (id,slug,name) VALUES ($1,'run-file-images','Run file images')",
    [tenant.organizationId],
  );
  await pool.query(
    "INSERT INTO oao.projects (organization_id,id,slug,name) VALUES ($1,$2,'run-file-images','Run file images')",
    [tenant.organizationId, tenant.projectId],
  );
  await pool.query(
    `INSERT INTO oao.principals (organization_id,project_id,id,kind,subject,scopes)
     VALUES ($1,$2,$3,'human','run-file-images-human',ARRAY['*']),
            ($1,$2,$4,'service','run-file-images-service',ARRAY['*'])`,
    [tenant.organizationId, tenant.projectId, human, service],
  );
}

async function seedImageRun(
  pool: PgPool,
  label: string,
  modelPreset: string,
  objects: Map<string, { bytes: Buffer; contentType: string }>,
): Promise<RunId> {
  const agentId = uuid(`${label}-agent`);
  const versionId = uuid(`${label}-version`);
  const threadId = uuid(`${label}-thread`) as ThreadId;
  const sessionId = uuid(`${label}-session`);
  const runId = uuid(`${label}-run`) as RunId;
  const config = {
    systemPrompt: "Describe attached images.",
    modelPreset,
    tools: [],
    sandbox: {
      enabled: true,
      provider: "test-daytona",
      snapshotId: uuid("run-file-images-e2e-snapshot"),
      network: "none",
      capabilities: ["filesystem_read", "shell"],
    },
    limits: { maxTurns: 8, timeoutMs: 20_000 },
  };
  await pool.query(
    `INSERT INTO oao.agent_definitions (organization_id,project_id,id,agent_key,name)
     VALUES ($1,$2,$3,$4,$4)`,
    [tenant.organizationId, tenant.projectId, agentId, label],
  );
  await pool.query(
    `INSERT INTO oao.agent_versions (
       organization_id,project_id,id,agent_definition_id,version,config,content_hash,
       created_by_principal_id
     ) VALUES ($1,$2,$3,$4,1,$5,$6,$7)`,
    [
      tenant.organizationId,
      tenant.projectId,
      versionId,
      agentId,
      config,
      createHash("sha256").update(stableJson(config)).digest(),
      human,
    ],
  );
  await pool.query(
    "INSERT INTO oao.threads (organization_id,project_id,id,title) VALUES ($1,$2,$3,$4)",
    [tenant.organizationId, tenant.projectId, threadId, label],
  );
  await pool.query(
    `INSERT INTO oao.sessions (organization_id,project_id,id,thread_id,agent_version_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [tenant.organizationId, tenant.projectId, sessionId, threadId, versionId],
  );
  const files = runFiles(runId);
  for (const file of files)
    objects.set(file.manifest.objectKey, {
      bytes: file.bytes,
      contentType: file.manifest.contentType,
    });
  const message = "What does the screenshot show?";
  await pool.query(
    `INSERT INTO oao.runs (
       organization_id,project_id,id,thread_id,session_id,agent_version_id,
       created_by_principal_id,idempotency_key,input_public
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      tenant.organizationId,
      tenant.projectId,
      runId,
      threadId,
      sessionId,
      versionId,
      human,
      `run-file-images:${label}`,
      { message, files: files.map((file) => file.manifest) },
    ],
  );
  return runId;
}

async function waitForSettled(
  pool: PgPool,
  runId: RunId,
  expected: "completed" | "failed",
): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const result = await pool.query<{ state: string }>(
      "SELECT state FROM oao.runs WHERE organization_id=$1 AND project_id=$2 AND id=$3",
      [tenant.organizationId, tenant.projectId, runId],
    );
    const state = result.rows[0]?.state;
    if (state === expected) return;
    if (
      state === "completed" ||
      state === "failed" ||
      state === "cancelled" ||
      state === "timed_out"
    )
      throw new Error(`Image run ended in ${state}, expected ${expected}`);
    if (Date.now() >= deadline) throw new Error(`Image run stayed in ${state}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface ObservedInput {
  readonly text: string;
  readonly images: readonly {
    readonly mimeType: string;
    readonly width: number;
    readonly height: number;
  }[];
}

test(
  "image run files reach a vision model natively and a text-only model as a note",
  { skip: databaseUrl ? false : "DATABASE_URL is required", timeout: 60_000 },
  async () => {
    assert.ok(databaseUrl);
    assert.ok(testAdminDatabaseUrl);
    const pool = createPool(testAdminDatabaseUrl);
    const objects = new Map<string, { bytes: Buffer; contentType: string }>();
    const observed = new Map<string, ObservedInput>();
    const respond: FauxResponseStep = (context, _options, _state, model) => {
      const user = context.messages.findLast(
        (message) => message.role === "user",
      );
      assert.ok(user && user.role === "user");
      const content =
        typeof user.content === "string"
          ? [{ type: "text" as const, text: user.content }]
          : user.content;
      observed.set(model.id, {
        text: content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n"),
        images: content.flatMap((block) =>
          block.type === "image"
            ? [
                {
                  mimeType: block.mimeType,
                  ...pngDimensions(Buffer.from(block.data, "base64")),
                },
              ]
            : [],
        ),
      });
      return fauxAssistantMessage(`${model.id}:answered`);
    };
    const storageFailures = new Map<string, number>();
    let worker: RuntimeWorkerHandle | undefined;
    try {
      worker = await startRuntimeWorker({
        databaseUrl,
        listen: false,
        env: { ...process.env, OAO_RUNTIME_SERVICE_PRINCIPAL_ID: service },
        daytonaProvider: new FakeSandboxProvider(),
        fakeResponses: Array.from({ length: 4 }, () => respond),
        runFileStorage: memoryRunFileStorage(objects, storageFailures),
        backgroundWakes: false,
      });
      await seedTenant(pool);
      const visionRunId = await seedImageRun(
        pool,
        "run-file-images-vision",
        "local-vision",
        objects,
      );
      const textRunId = await seedImageRun(
        pool,
        "run-file-images-text",
        "local-default",
        objects,
      );
      const missingRunId = await seedImageRun(
        pool,
        "run-file-images-missing",
        "local-vision",
        objects,
      );
      const outageRunId = await seedImageRun(
        pool,
        "run-file-images-outage",
        "local-vision",
        objects,
      );
      for (const key of objects.keys())
        if (key.includes(missingRunId) && key.endsWith("/screen.png"))
          objects.delete(key);
      // One storage error is retried within the attempt; an outage that
      // outlasts the retries fails the run before anything is sent.
      storageFailures.set(visionRunId, 1);
      storageFailures.set(outageRunId, Number.POSITIVE_INFINITY);
      const admitWake = (runId: RunId) => ({
        ...tenant,
        id: uuid(`run-file-images-wake:${runId}`),
        runId,
        dispatchKey: `admit:${runId}`,
        kind: "admit" as const,
        payload: { reason: "integration_test" },
        attempts: 1,
        fence: 1n,
      });
      for (const [runId, expected] of [
        [visionRunId, "completed"],
        [textRunId, "completed"],
        // A missing object still fails the run when the sandbox copy is made,
        // instead of stalling admission.
        [missingRunId, "failed"],
        [outageRunId, "failed"],
      ] as const) {
        await worker.orchestrator.handleWake(admitWake(runId));
        await waitForSettled(pool, runId, expected);
      }
      const outage = await pool.query<{
        code: string | null;
        reserved: boolean;
      }>(
        `SELECT
           (SELECT public_payload->>'code' FROM oao.product_events
             WHERE organization_id=$1 AND aggregate_id=$2
               AND event_kind='run.state_changed'
               AND public_payload->>'state'='failed') AS code,
           EXISTS (SELECT 1 FROM oao.runtime_dispatches
             WHERE organization_id=$1 AND run_id=$2) AS reserved`,
        [tenant.organizationId, outageRunId],
      );
      assert.deepEqual(outage.rows[0], {
        code: "run_file_storage_unavailable",
        reserved: false,
      });
      await worker.stop();
      worker = undefined;

      const vision = observed.get("deterministic-vision");
      assert.ok(vision);
      assert.deepEqual(vision.images, [
        { mimeType: "image/png", width: 2000, height: 1250 },
      ]);
      assert.match(
        vision.text,
        /image input: attached as image 1, converted to image\/png at 2000x1250 px/u,
      );
      assert.match(vision.text, /\.oao\/attachments\/.+\/notes\.txt/u);

      const textOnly = observed.get("deterministic");
      assert.ok(textOnly);
      assert.deepEqual(textOnly.images, []);
      assert.match(
        textOnly.text,
        /image input: not attached: the agent's model does not accept image input/u,
      );

      const replies = await pool.query<{ run_id: string; reply: string }>(
        `SELECT run_id,redacted_content AS reply FROM oao.messages
          WHERE organization_id=$1 AND project_id=$2 AND role='assistant'
          ORDER BY run_id`,
        [tenant.organizationId, tenant.projectId],
      );
      assert.deepEqual(
        new Map(replies.rows.map((row) => [row.run_id, row.reply])),
        new Map([
          [visionRunId, "deterministic-vision:answered"],
          [textRunId, "deterministic:answered"],
        ]),
      );
      // Image bytes stay in Flue's attachment store; OAO's own rows hold none.
      const leaks = await pool.query<{ source: string }>(
        `SELECT 'product_events' AS source FROM oao.product_events
          WHERE organization_id=$1 AND public_payload::text LIKE $2
         UNION ALL
         SELECT 'sandbox_commands' FROM oao.sandbox_commands
          WHERE organization_id=$1
            AND (safe_command::text LIKE $2 OR safe_result::text LIKE $2)
         UNION ALL
         SELECT 'model_invocations' FROM oao.model_invocations
          WHERE organization_id=$1
            AND (safe_request::text LIKE $2 OR safe_response::text LIKE $2)
         UNION ALL
         SELECT 'messages' FROM oao.messages
          WHERE organization_id=$1 AND redacted_content LIKE $2
         UNION ALL
         SELECT 'runs' FROM oao.runs
          WHERE organization_id=$1 AND input_public::text LIKE $2`,
        [tenant.organizationId, `%${PNG_BASE64_PREFIX}%`],
      );
      assert.deepEqual(leaks.rows, []);
    } finally {
      await worker?.stop();
      await pool.end();
    }
  },
);
