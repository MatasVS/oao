/* global Buffer, URL */

import { connect } from "node:net";

// SSLRequest: length 8, then the request code 1234.5679 (80877103).
const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);

/**
 * Whether a PostgreSQL server answers on the address. Uses the protocol's
 * SSLRequest, which every server answers with a single `S` or `N` byte before
 * authentication, so no credentials or client library are needed.
 */
export async function probePostgres(
  port,
  host = "127.0.0.1",
  timeoutMs = 1_000,
) {
  return await new Promise((resolvePromise) => {
    const socket = connect({ host, port: Number(port) });
    let settled = false;
    const finish = (answered) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(answered);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
    socket.once("connect", () => socket.write(SSL_REQUEST));
    socket.once("data", (chunk) =>
      finish(chunk.length === 1 && (chunk[0] === 0x53 || chunk[0] === 0x4e)),
    );
  });
}

/** Host and port of a PostgreSQL connection URL, or undefined if it is not one. */
export function postgresAddress(databaseUrl) {
  try {
    const url = new URL(databaseUrl);
    if (url.protocol !== "postgresql:" && url.protocol !== "postgres:")
      return undefined;
    return {
      host: url.hostname.replace(/^\[(.*)\]$/u, "$1") || "127.0.0.1",
      port: Number(url.port || 5432),
    };
  } catch {
    return undefined;
  }
}
