/* global Buffer */

import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

import { postgresPortCheck } from "../bootstrap/preflight.mjs";
import {
  postgresAddress,
  probePostgres,
} from "../bootstrap/postgres-probe.mjs";

const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);

async function listen(onConnection) {
  // Read every socket so the server notices the probe hanging up and close()
  // can finish.
  const server = createServer((socket) => {
    socket.resume();
    onConnection(socket);
  });
  await new Promise((resolvePromise) =>
    server.listen(0, "127.0.0.1", resolvePromise),
  );
  return server;
}

async function close(server) {
  await new Promise((resolvePromise) => server.close(resolvePromise));
}

test("the probe recognises a PostgreSQL server by its SSLRequest answer", async () => {
  const server = await listen((socket) => {
    socket.once("data", (chunk) => {
      assert.deepEqual(chunk, SSL_REQUEST);
      socket.write("N");
    });
  });
  try {
    assert.equal(await probePostgres(server.address().port), true);
  } finally {
    await close(server);
  }
});

test("the probe rejects other services and closed ports", async () => {
  const banner = await listen((socket) => socket.write("SSH-2.0-test\r\n"));
  const silent = await listen(() => {});
  const closed = await listen(() => {});
  const closedPort = closed.address().port;
  await close(closed);
  try {
    assert.equal(await probePostgres(banner.address().port), false);
    assert.equal(
      await probePostgres(silent.address().port, "127.0.0.1", 200),
      false,
    );
    assert.equal(await probePostgres(closedPort), false);
  } finally {
    await close(banner);
    await close(silent);
  }
});

test("PostgreSQL connection URLs resolve to a host and port", () => {
  assert.deepEqual(
    postgresAddress("postgresql://user:secret@127.0.0.1:55432/oao"),
    { host: "127.0.0.1", port: 55432 },
  );
  assert.deepEqual(postgresAddress("postgres://localhost/oao"), {
    host: "localhost",
    port: 5432,
  });
  assert.deepEqual(postgresAddress("postgresql://[::1]:5433/oao"), {
    host: "::1",
    port: 5433,
  });
  assert.equal(postgresAddress("mysql://127.0.0.1/oao"), undefined);
  assert.equal(postgresAddress("not a url"), undefined);
});

test("a PostgreSQL server OAO did not start is a warning, not a failure", () => {
  const base = {
    port: 5432,
    free: false,
    oaoContainer: false,
    answering: false,
    existingMode: false,
    address: undefined,
  };
  assert.equal(postgresPortCheck({ ...base, free: true }).status, "pass");
  assert.equal(
    postgresPortCheck({ ...base, oaoContainer: true }).status,
    "pass",
  );
  const detected = postgresPortCheck({ ...base, answering: true });
  assert.equal(detected.status, "warn");
  assert.match(detected.message, /setup asks before creating/u);
  assert.equal(postgresPortCheck(base).status, "fail");

  const configured = { ...base, existingMode: true };
  assert.equal(postgresPortCheck(configured).status, "fail");
  const address = { host: "127.0.0.1", port: 5432 };
  assert.equal(
    postgresPortCheck({ ...configured, address, answering: true }).status,
    "pass",
  );
  const down = postgresPortCheck({ ...configured, address });
  assert.equal(down.status, "fail");
  assert.match(down.remediation, /remove OAO_POSTGRES_MODE/u);
});
