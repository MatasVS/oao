import { userInfo } from "node:os";
import pg from "pg";
import { updateLocalEnvironment } from "./environment.js";
import type { SetupIo } from "./io.js";

/** Marks a database that setup created, so a later setup can recognise it. */
export const SETUP_DATABASE_COMMENT =
  "Created by pnpm oao setup for OAO local development";

const MINIMUM_SERVER_VERSION = 170_000;
/** Cluster-wide NOLOGIN roles that OAO's migrations create. */
const OAO_ROLES = ["oao_app", "oao_migrator", "oao_recovery", "oao_auth"];
const USE_OWN_CONTAINER =
  "or set OAO_POSTGRES_PORT in .env to a free port so setup runs OAO's own PostgreSQL 17 container";

export interface PostgresClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]>;
  end(): Promise<void>;
}

export type PostgresConnector = (
  connectionString: string,
) => Promise<PostgresClient>;

interface Credentials {
  readonly user: string;
  readonly password?: string;
}

async function connectWithPg(
  connectionString: string,
): Promise<PostgresClient> {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
  });
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  return {
    query: async (text, values) =>
      (await client.query(text, values ? [...values] : undefined)).rows,
    end: () => client.end(),
  };
}

function connectionUrl(
  port: number,
  credentials: Credentials,
  database: string,
): string {
  const password = credentials.password
    ? `:${encodeURIComponent(credentials.password)}`
    : "";
  return `postgresql://${encodeURIComponent(credentials.user)}${password}@127.0.0.1:${port}/${encodeURIComponent(database)}`;
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
}

function isAuthenticationFailure(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === "28P01" ||
    code === "28000" ||
    (error instanceof Error && /password/iu.test(error.message))
  );
}

function databaseName(values: Readonly<Record<string, string>>): string {
  let name = "oao";
  try {
    if (values.DATABASE_URL)
      name =
        decodeURIComponent(new URL(values.DATABASE_URL).pathname.slice(1)) ||
        name;
  } catch {
    // An unparsable DATABASE_URL keeps the default database name.
  }
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(name))
    throw new Error(
      `The database name "${name}" in DATABASE_URL is not supported here; use lowercase letters, digits, and underscores.`,
    );
  return name;
}

function candidateCredentials(
  values: Readonly<Record<string, string>>,
  osUser: string | undefined,
): readonly Credentials[] {
  const candidates: Credentials[] = [];
  try {
    if (values.DATABASE_URL) {
      const url = new URL(values.DATABASE_URL);
      if (url.username)
        candidates.push({
          user: decodeURIComponent(url.username),
          ...(url.password
            ? { password: decodeURIComponent(url.password) }
            : {}),
        });
    }
  } catch {
    // Fall back to password-less local users.
  }
  if (osUser) candidates.push({ user: osUser });
  candidates.push({ user: "postgres" });
  return candidates.filter(
    (candidate, index) =>
      candidates.findIndex(
        (other) =>
          other.user === candidate.user &&
          other.password === candidate.password,
      ) === index,
  );
}

async function tryConnect(
  connect: PostgresConnector,
  port: number,
  credentials: Credentials,
): Promise<PostgresClient | undefined> {
  for (const database of ["postgres", "template1"]) {
    try {
      return await connect(connectionUrl(port, credentials, database));
    } catch (error) {
      if (errorCode(error) === "3D000") continue;
      if (isAuthenticationFailure(error)) return undefined;
      throw error;
    }
  }
  return undefined;
}

async function signIn(
  connect: PostgresConnector,
  port: number,
  candidates: readonly Credentials[],
  io: SetupIo,
): Promise<{ client: PostgresClient; credentials: Credentials }> {
  for (const credentials of candidates) {
    const client = await tryConnect(connect, port, credentials);
    if (client) return { client, credentials };
  }
  io.write(
    "The PostgreSQL user from .env and password-less local users were rejected.\n",
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const user = await io.question(
      "PostgreSQL user that can create databases and roles",
      "postgres",
    );
    const password = await io.secret(
      `Password for ${user} (leave empty for none)`,
    );
    const credentials = { user, ...(password ? { password } : {}) };
    const client = await tryConnect(connect, port, credentials);
    if (client) return { client, credentials };
    io.write("That user and password were rejected.\n");
  }
  throw new Error(
    `Setup could not sign in to the PostgreSQL server on 127.0.0.1:${port}. Set DATABASE_URL in .env to a user that can create databases and roles, ${USE_OWN_CONTAINER}.`,
  );
}

async function confirm(
  io: SetupIo,
  prompt: string,
  defaultYes: boolean,
): Promise<boolean> {
  while (true) {
    const answer = (
      await io.question(`${prompt} ${defaultYes ? "[Y/n]" : "[y/N]"}`)
    ).toLowerCase();
    if (answer === "") return defaultYes;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    io.write("Answer yes or no.\n");
  }
}

/**
 * The rights OAO's migrations need in an existing database that the user
 * lacks: they create the oao schema, the pgcrypto extension, and
 * public.oao_schema_migrations, which another owner's database may not allow.
 */
async function missingDatabaseRights(
  connect: PostgresConnector,
  port: number,
  credentials: Credentials,
  database: string,
): Promise<readonly string[]> {
  let client: PostgresClient;
  try {
    client = await connect(connectionUrl(port, credentials, database));
  } catch (error) {
    if (errorCode(error) === "42501")
      return [`CONNECT on the database "${database}"`];
    throw error;
  }
  try {
    const [rights] = await client.query(
      `SELECT has_database_privilege(current_database(), 'CREATE') AS database,
              COALESCE((SELECT has_schema_privilege(oid, 'CREATE')
                          FROM pg_namespace WHERE nspname = 'public'), false)
                AS public_schema,
              COALESCE((SELECT has_schema_privilege(oid, 'CREATE')
                          FROM pg_namespace WHERE nspname = 'oao'), true)
                AS oao_schema`,
    );
    return [
      ...(rights?.database === true
        ? []
        : [`CREATE on the database "${database}"`]),
      ...(rights?.public_schema === true
        ? []
        : ['CREATE on its "public" schema']),
      ...(rights?.oao_schema === true ? [] : ['CREATE on its "oao" schema']),
    ];
  } finally {
    await client.end().catch(() => undefined);
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Uses a PostgreSQL server that OAO did not start for local development.
 * After the user confirms, creates the OAO database on it (or reuses one an
 * earlier setup created) and records the connection in .env. Returns the
 * updated .env values; throws when the user declines or the server cannot be
 * used, without changing the server.
 */
export async function useExistingPostgres(input: {
  readonly repositoryRoot: string;
  readonly port: number;
  readonly values: Readonly<Record<string, string>>;
  readonly io: SetupIo;
  readonly connect?: PostgresConnector;
  readonly osUser?: string;
}): Promise<Readonly<Record<string, string>>> {
  const { io, port } = input;
  const location = `127.0.0.1:${port}`;
  io.write(
    `\nA PostgreSQL server that OAO did not start is running on ${location}.\n`,
  );
  const database = databaseName(input.values);
  let osUser = input.osUser;
  if (osUser === undefined)
    try {
      osUser = userInfo().username;
    } catch {
      osUser = undefined;
    }
  const connect = input.connect ?? connectWithPg;
  const { client, credentials } = await signIn(
    connect,
    port,
    candidateCredentials(input.values, osUser),
    io,
  );
  try {
    const [server] = await client.query(
      `SELECT current_setting('server_version_num')::int AS version_number,
              current_setting('server_version') AS version,
              rolsuper AS superuser, rolcreatedb AS create_database,
              rolcreaterole AS create_role,
              EXISTS (SELECT 1 FROM pg_available_extensions
                      WHERE name = 'pgcrypto') AS pgcrypto
         FROM pg_roles WHERE rolname = current_user`,
    );
    const [existing] = await client.query(
      `SELECT shobj_description(oid, 'pg_database') AS comment
         FROM pg_database WHERE datname = $1`,
      [database],
    );
    // A migration grants oao_app to the connecting user, which needs ADMIN
    // OPTION on roles that another user created.
    const presentRoles = await client.query(
      `SELECT rolname,
              pg_has_role(current_user, oid, 'USAGE WITH ADMIN OPTION') AS manageable
         FROM pg_roles WHERE rolname = ANY($1)`,
      [OAO_ROLES],
    );
    if (!server) throw new Error("Setup could not read the PostgreSQL role");
    if (Number(server.version_number) < MINIMUM_SERVER_VERSION)
      throw new Error(
        `That server runs PostgreSQL ${String(server.version)}; OAO needs PostgreSQL 17 or newer. Upgrade it, ${USE_OWN_CONTAINER}.`,
      );
    if (server.pgcrypto !== true)
      throw new Error(
        "That server does not have the pgcrypto extension, which OAO's migrations need. Install PostgreSQL's contrib extensions and run setup again.",
      );
    const missingRoles = OAO_ROLES.filter(
      (role) => !presentRoles.some((row) => row.rolname === role),
    );
    const superuser = server.superuser === true;
    if (
      !superuser &&
      ((!existing && server.create_database !== true) ||
        (missingRoles.length > 0 && server.create_role !== true))
    )
      throw new Error(
        `The PostgreSQL user "${credentials.user}" cannot create the database and roles OAO needs. Use a superuser or a user with CREATEDB and CREATEROLE, ${USE_OWN_CONTAINER}.`,
      );

    const foreignRoles = presentRoles
      .filter((row) => row.manageable !== true)
      .map((row) => String(row.rolname));
    if (!superuser && foreignRoles.length > 0)
      throw new Error(
        `The roles ${foreignRoles.join(", ")} already exist on that server and "${credentials.user}" cannot grant them, which OAO's migrations need. Use a superuser or the user that created them, ${USE_OWN_CONTAINER}.`,
      );

    if (existing && !superuser) {
      const missingRights = await missingDatabaseRights(
        connect,
        port,
        credentials,
        database,
      );
      if (missingRights.length > 0)
        throw new Error(
          `The database "${database}" already exists on that server, and "${credentials.user}" lacks ${missingRights.join(", ")}, which OAO's migrations need. Grant them or use the database owner or a superuser; to create a new database instead, set the database name in DATABASE_URL, ${USE_OWN_CONTAINER}.`,
        );
    }

    const roles =
      missingRoles.length > 0
        ? ` OAO's migrations also add the no-login roles ${missingRoles.join(", ")} to that server.`
        : "";
    const accepted = !existing
      ? await confirm(
          io,
          `Create the database "${database}" on PostgreSQL ${String(server.version)} at ${location} as "${credentials.user}" and use it for OAO?${roles}`,
          false,
        )
      : existing.comment === SETUP_DATABASE_COMMENT
        ? await confirm(
            io,
            `The database "${database}" on that server was created by an earlier OAO setup. Use it again?`,
            true,
          )
        : await confirm(
            io,
            `The database "${database}" already exists on that server and was not created by OAO setup. Use it anyway? OAO adds its schema and tables to it.${roles}`,
            false,
          );
    if (!accepted)
      throw new Error(
        `Setup did not change the PostgreSQL server on ${location}. To use a different database there, set the database name in DATABASE_URL; otherwise stop that server, ${USE_OWN_CONTAINER}.`,
      );
    if (!existing) {
      await client.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
      await client.query(
        `COMMENT ON DATABASE ${quoteIdentifier(database)} IS '${SETUP_DATABASE_COMMENT}'`,
      );
      io.write(`✓ Created the database "${database}" on ${location}.\n`);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
  const values = await updateLocalEnvironment(input.repositoryRoot, {
    OAO_POSTGRES_MODE: "existing",
    DATABASE_URL: connectionUrl(port, credentials, database),
  });
  io.write(
    "✓ Saved the PostgreSQL connection to .env; OAO will not start or stop that server.\n",
  );
  return values;
}
