import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  PostgresFoundationRepository,
  createPool,
  withTenantTransaction,
} from "@oao/db-postgres";
import type {
  OrganizationId,
  PrincipalId,
  ProjectId,
  RunId,
  ToolCallId,
} from "@oao/domain";
import { PostgresToolBroker } from "../../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
// Fresh ids per run, so the test reruns against one database.
const tenant = {
  organizationId: randomUUID() as OrganizationId,
  projectId: randomUUID() as ProjectId,
};
const principal = randomUUID() as PrincipalId;
const servicePrincipal = randomUUID() as PrincipalId;
const agentId = randomUUID();
const agentVersionId = randomUUID();
const threadId = randomUUID();
const sessionId = randomUUID();
const runId = randomUUID() as RunId;
const slug = `approval-text-${tenant.organizationId.slice(0, 8)}`;

test(
  "an approval gate commits the pending assistant text before the gate",
  { skip: databaseUrl ? false : "DATABASE_URL is required" },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl);
    const foundation = new PostgresFoundationRepository();
    const broker = new PostgresToolBroker(pool, {
      servicePrincipalId: servicePrincipal,
      pollMilliseconds: 1,
    });
    try {
      const config = {
        systemPrompt: "Explain changes before requesting approval.",
        modelPreset: "integration-model",
        tools: [],
        sandbox: {
          enabled: false,
          provider: "integration-daytona",
          network: "none",
          capabilities: [],
        },
        limits: { maxTurns: 32, timeoutMs: 60_000 },
      };
      await pool.query(
        `INSERT INTO oao.organizations (id,slug,name)
         VALUES ($1,$2,'Approval text integration')`,
        [tenant.organizationId, slug],
      );
      await pool.query(
        `INSERT INTO oao.projects (organization_id,id,slug,name)
         VALUES ($1,$2,$3,'Approval text integration')`,
        [tenant.organizationId, tenant.projectId, slug],
      );
      await pool.query(
        `INSERT INTO oao.principals (
           organization_id,project_id,id,kind,subject,scopes
         ) VALUES ($1,$2,$3,'human','approval-text-human',ARRAY['*'])`,
        [tenant.organizationId, tenant.projectId, principal],
      );
      await pool.query(
        `INSERT INTO oao.agent_definitions (
           organization_id,project_id,id,agent_key,name
         ) VALUES ($1,$2,$3,'approval-text-agent','Approval text agent')`,
        [tenant.organizationId, tenant.projectId, agentId],
      );
      await pool.query(
        `INSERT INTO oao.agent_versions (
           organization_id,project_id,id,agent_definition_id,version,config,
           content_hash,created_by_principal_id
         ) VALUES ($1,$2,$3,$4,1,$5,$6,$7)`,
        [
          tenant.organizationId,
          tenant.projectId,
          agentVersionId,
          agentId,
          config,
          createHash("sha256").update(JSON.stringify(config)).digest(),
          principal,
        ],
      );
      await pool.query(
        `INSERT INTO oao.threads (organization_id,project_id,id,title)
         VALUES ($1,$2,$3,'Approval text thread')`,
        [tenant.organizationId, tenant.projectId, threadId],
      );
      await pool.query(
        `INSERT INTO oao.sessions (
           organization_id,project_id,id,thread_id,agent_version_id
         ) VALUES ($1,$2,$3,$4,$5)`,
        [
          tenant.organizationId,
          tenant.projectId,
          sessionId,
          threadId,
          agentVersionId,
        ],
      );
      await withTenantTransaction(pool, tenant, (transaction) =>
        transaction.query(
          `INSERT INTO oao.runs (
            organization_id,project_id,id,thread_id,session_id,agent_version_id,
            created_by_principal_id,idempotency_key
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,'approval-text-integration')`,
          [
            tenant.organizationId,
            tenant.projectId,
            runId,
            threadId,
            sessionId,
            agentVersionId,
            principal,
          ],
        ),
      );
      await pool.query(
        "UPDATE oao.runs SET state='running' WHERE organization_id=$1 AND project_id=$2 AND id=$3",
        [tenant.organizationId, tenant.projectId, runId],
      );

      const gate = {
        ...tenant,
        runId,
        flueToolCallId: "explained-gate",
        toolName: "caller.update_rule",
        safeArguments: { rule: "RULE-7" },
        approval: "always" as const,
        pendingAssistantText: "\nNow: EUR → After: CHF for Example Corp.\n",
      };
      assert.equal(await broker.hasPendingAssistantText(gate), false);
      const gateId = await broker.publishCaller(gate);
      assert.equal(await broker.hasPendingAssistantText(gate), true);
      // A replayed publish keeps one message and one event.
      assert.equal(await broker.publishCaller(gate), gateId);

      const transcript = await pool.query<{ kind: string; content: string }>(
        `SELECT kind,content FROM (
           SELECT 'message' AS kind,redacted_content AS content,created_at,role
             FROM oao.messages
            WHERE organization_id=$1 AND project_id=$2 AND run_id=$3
           UNION ALL
           SELECT 'approval',summary,created_at,NULL
             FROM oao.approvals
            WHERE organization_id=$1 AND project_id=$2 AND tool_call_id=$4
         ) entries ORDER BY created_at`,
        [tenant.organizationId, tenant.projectId, runId, gateId],
      );
      assert.deepEqual(transcript.rows, [
        { kind: "message", content: "Now: EUR → After: CHF for Example Corp." },
        { kind: "approval", content: "Approve caller.update_rule" },
      ]);
      // The event names its message so webhooks attach the right text.
      const events = await pool.query<{ matches: boolean }>(
        `SELECT event.public_payload->>'messageId' = message.id::text AS matches
           FROM oao.product_events event JOIN oao.messages message
             ON message.organization_id=event.organization_id
            AND message.project_id=event.project_id AND message.run_id=event.aggregate_id
          WHERE event.organization_id=$1 AND event.project_id=$2
            AND event.aggregate_id=$3 AND event.event_kind='message.created'`,
        [tenant.organizationId, tenant.projectId, runId],
      );
      assert.deepEqual(events.rows, [{ matches: true }]);

      await withTenantTransaction(pool, tenant, (transaction) =>
        transaction.query(
          "SELECT oao.resolve_approval($1,$2,id,'denied',$4,'not now') FROM oao.approvals WHERE organization_id=$1 AND project_id=$2 AND tool_call_id=$3",
          [tenant.organizationId, tenant.projectId, gateId, principal],
        ),
      );
      const denied = await broker.waitForCaller(gate);
      assert.equal(denied.status, "failure");

      // Calls without a gate never publish text; it stays in the settled reply.
      const ungated = {
        ...gate,
        flueToolCallId: "ungated-call",
        toolName: "caller.lookup",
        approval: "never" as const,
        pendingAssistantText: "Looking it up.",
      };
      const ungatedId = await broker.publishCaller(ungated);
      const waiting = broker.waitForCaller(ungated);
      const fence = await withTenantTransaction(pool, tenant, (transaction) =>
        foundation.claimToolCall(transaction, {
          ...tenant,
          toolCallId: ungatedId as ToolCallId,
          principalId: principal,
          leaseMilliseconds: 60_000,
        }),
      );
      await withTenantTransaction(pool, tenant, (transaction) =>
        foundation.submitResult(transaction, {
          ...tenant,
          toolCallId: ungatedId as ToolCallId,
          principalId: principal,
          fence,
          idempotencyKey: "ungated-result",
          requestHash: createHash("sha256").update("ungated-result").digest(),
          safeResult: { version: 1, status: "success", value: { found: true } },
        }),
      );
      assert.equal((await waiting).status, "success");
      const messages = await pool.query<{ count: string }>(
        "SELECT count(*) FROM oao.messages WHERE organization_id=$1 AND project_id=$2 AND run_id=$3",
        [tenant.organizationId, tenant.projectId, runId],
      );
      assert.equal(messages.rows[0]?.count, "1");
    } finally {
      await pool.end();
    }
  },
);
