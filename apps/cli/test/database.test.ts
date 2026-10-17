import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  SETUP_DATABASE_COMMENT,
  useExistingPostgres,
} from "../src/database.js";
import type { PostgresClient, PostgresConnector } from "../src/database.js";
import type { SetupIo } from "../src/io.js";

const ENV = [
  "DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/oao",
  "OAO_POSTGRES_PORT=5432",
  "OAO_API_PORT=3000",
  "",
].join("\n");

class FakeIo implements SetupIo {
  readonly output: string[] = [];
  readonly questions: string[] = [];

  constructor(
    private readonly answers: string[] = [],
    private readonly secrets: string[] = [],
  ) {}

  write(message: string): void {
    this.output.push(message);
  }

  async question(prompt: string, defaultValue?: string): Promise<string> {
    this.questions.push(prompt);
    return this.answers.shift() ?? defaultValue ?? "";
  }

  async secret(): Promise<string> {
    return this.secrets.shift() ?? "";
  }

  async select(): Promise<string> {
    throw new Error("Not used");
  }

  async search(): Promise<string> {
    throw new Error("Not used");
  }
}

interface FakeServerOptions {
  readonly accepts: readonly { user: string; password?: string }[];
  readonly versionNumber?: number;
  readonly superuser?: boolean;
  readonly createDatabase?: boolean;
  readonly createRole?: boolean;
  readonly pgcrypto?: boolean;
  readonly databases?: Readonly<Record<string, string | null>>;
  readonly roles?: readonly string[];
  /** Existing roles the connecting user cannot grant. */
  readonly foreignRoles?: readonly string[];
  /** CREATE rights inside an existing database; all granted by default. */
  readonly rights?: {
    readonly database?: boolean;
    readonly publicSchema?: boolean;
    readonly oaoSchema?: boolean;
  };
}

class FakeServer {
  readonly statements: string[] = [];
  readonly connections: string[] = [];
  open = 0;

  constructor(private readonly options: FakeServerOptions) {}

  readonly connect: PostgresConnector = async (connectionString) => {
    this.connections.push(connectionString);
    const url = new URL(connectionString);
    const user = decodeURIComponent(url.username);
    const password = url.password
      ? decodeURIComponent(url.password)
      : undefined;
    if (
      !this.options.accepts.some(
        (entry) => entry.user === user && entry.password === password,
      )
    )
      throw Object.assign(new Error(`password authentication failed`), {
        code: "28P01",
      });
    this.open += 1;
    const client: PostgresClient = {
      query: async (text, values) => {
        this.statements.push(text);
        if (text.includes("current_setting('server_version_num')"))
          return [
            {
              version_number: this.options.versionNumber ?? 170_002,
              version: "17.2",
              superuser: this.options.superuser ?? true,
              create_database: this.options.createDatabase ?? false,
              create_role: this.options.createRole ?? false,
              pgcrypto: this.options.pgcrypto ?? true,
            },
          ];
        if (text.includes("FROM pg_database")) {
          const name = String(values?.[0]);
          const databases = this.options.databases ?? {};
          return name in databases ? [{ comment: databases[name] }] : [];
        }
        if (text.includes("has_database_privilege")) {
          const rights = this.options.rights ?? {};
          return [
            {
              database: rights.database ?? true,
              public_schema: rights.publicSchema ?? true,
              oao_schema: rights.oaoSchema ?? true,
            },
          ];
        }
        if (text.includes("FROM pg_roles WHERE rolname = ANY"))
          return (this.options.roles ?? []).map((rolname) => ({
            rolname,
            manageable: !(this.options.foreignRoles ?? []).includes(rolname),
          }));
        return [];
      },
      end: async () => {
        this.open -= 1;
      },
    };
    return client;
  };
}

async function withEnv<T>(
  run: (directory: string) => Promise<T>,
): Promise<{ result: T; env: string }> {
  const directory = await mkdtemp(resolve(tmpdir(), "oao-cli-database-"));
  try {
    await writeFile(resolve(directory, ".env"), ENV);
    const result = await run(directory);
    return { result, env: await readFile(resolve(directory, ".env"), "utf8") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("setup creates the OAO database after confirmation and records it in .env", async () => {
  // A Homebrew-style server: the OS user signs in without a password.
  const server = new FakeServer({ accepts: [{ user: "ben" }] });
  const io = new FakeIo(["y"]);
  const { result, env } = await withEnv((repositoryRoot) =>
    useExistingPostgres({
      repositoryRoot,
      port: 5432,
      values: { DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1/oao" },
      io,
      connect: server.connect,
      osUser: "ben",
    }),
  );

  assert.deepEqual(
    server.statements.filter((statement) =>
      /^(CREATE|COMMENT)/u.test(statement),
    ),
    [
      'CREATE DATABASE "oao"',
      `COMMENT ON DATABASE "oao" IS '${SETUP_DATABASE_COMMENT}'`,
    ],
  );
  assert.equal(server.open, 0);
  assert.match(
    io.questions[0] ?? "",
    /Create the database "oao" on PostgreSQL 17\.2 at 127\.0\.0\.1:5432 as "ben".*oao_app, oao_migrator, oao_recovery, oao_auth.*\[y\/N\]$/u,
  );
  assert.equal(result.OAO_POSTGRES_MODE, "existing");
  assert.equal(result.DATABASE_URL, "postgresql://ben@127.0.0.1:5432/oao");
  assert.equal(
    env,
    [
      "DATABASE_URL=postgresql://ben@127.0.0.1:5432/oao",
      "OAO_POSTGRES_PORT=5432",
      "OAO_API_PORT=3000",
      "OAO_POSTGRES_MODE=existing",
      "",
    ].join("\n"),
  );
});

test("declining leaves the server and .env unchanged", async () => {
  const server = new FakeServer({
    accepts: [{ user: "postgres", password: "postgres" }],
  });
  const { result, env } = await withEnv((repositoryRoot) =>
    useExistingPostgres({
      repositoryRoot,
      port: 5432,
      values: { DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1/oao" },
      io: new FakeIo([""]),
      connect: server.connect,
      osUser: "ben",
    }).then(
      () => "accepted",
      (error: Error) => error.message,
    ),
  );
  assert.match(result, /did not change the PostgreSQL server/u);
  assert.ok(
    !server.statements.some((statement) => statement.startsWith("CREATE")),
  );
  assert.equal(server.open, 0);
  assert.equal(env, ENV);
});

test("an older server or a user without privileges is refused before asking", async () => {
  for (const [options, message] of [
    [{ versionNumber: 160_004 }, /needs PostgreSQL 17 or newer/u],
    [{ superuser: false, createRole: true }, /CREATEDB and CREATEROLE/u],
    [{ pgcrypto: false }, /pgcrypto/u],
    [
      {
        superuser: false,
        createDatabase: true,
        createRole: true,
        roles: ["oao_app", "oao_migrator"],
        foreignRoles: ["oao_app"],
      },
      /roles oao_app already exist on that server and "ben" cannot grant them/u,
    ],
    // PostgreSQL 15 and newer let only the owner create in "public".
    [
      {
        superuser: false,
        createDatabase: true,
        createRole: true,
        databases: { oao: null },
        rights: { publicSchema: false },
      },
      /"ben" lacks CREATE on its "public" schema, which OAO's migrations need/u,
    ],
  ] as const) {
    const server = new FakeServer({ accepts: [{ user: "ben" }], ...options });
    const io = new FakeIo(["y"]);
    const { result, env } = await withEnv((repositoryRoot) =>
      useExistingPostgres({
        repositoryRoot,
        port: 5432,
        values: {},
        io,
        connect: server.connect,
        osUser: "ben",
      }).then(
        () => "accepted",
        (error: Error) => error.message,
      ),
    );
    assert.match(result, message);
    assert.deepEqual(io.questions, []);
    assert.equal(env, ENV);
  }
});

test("a database from an earlier setup is reused by default, an unknown one is not", async () => {
  const reused = new FakeServer({
    accepts: [{ user: "ben" }],
    superuser: false,
    databases: { oao: SETUP_DATABASE_COMMENT },
    roles: ["oao_app", "oao_migrator", "oao_recovery", "oao_auth"],
  });
  const io = new FakeIo([""]);
  const { result } = await withEnv((repositoryRoot) =>
    useExistingPostgres({
      repositoryRoot,
      port: 5432,
      values: {},
      io,
      connect: reused.connect,
      osUser: "ben",
    }),
  );
  assert.equal(result.DATABASE_URL, "postgresql://ben@127.0.0.1:5432/oao");
  assert.match(
    io.questions[0] ?? "",
    /earlier OAO setup\. Use it again\? \[Y\/n\]$/u,
  );
  assert.ok(
    !reused.statements.some((statement) => statement.startsWith("CREATE")),
  );
  // Its rights are checked in the database itself.
  assert.ok(
    reused.connections.some((url) => url.endsWith("/oao")),
    reused.connections.join(" "),
  );
  assert.equal(reused.open, 0);

  const unknown = new FakeServer({
    accepts: [{ user: "ben" }],
    databases: { oao: null },
  });
  const declined = await withEnv((repositoryRoot) =>
    useExistingPostgres({
      repositoryRoot,
      port: 5432,
      values: {},
      io: new FakeIo([""]),
      connect: unknown.connect,
      osUser: "ben",
    }).then(
      () => "accepted",
      (error: Error) => error.message,
    ),
  );
  assert.match(declined.result, /did not change/u);
  assert.equal(declined.env, ENV);
});

test("setup asks for a PostgreSQL user when none of the defaults sign in", async () => {
  const server = new FakeServer({
    accepts: [{ user: "admin", password: "s3cret$&:@" }],
  });
  const io = new FakeIo(["admin", "y"], ["s3cret$&:@"]);
  const { result, env } = await withEnv((repositoryRoot) =>
    useExistingPostgres({
      repositoryRoot,
      port: 55432,
      values: {},
      io,
      connect: server.connect,
      osUser: "ben",
    }),
  );
  assert.equal(
    result.DATABASE_URL,
    "postgresql://admin:s3cret%24%26%3A%40@127.0.0.1:55432/oao",
  );
  assert.match(
    env,
    /^DATABASE_URL=postgresql:\/\/admin:s3cret%24%26%3A%40@127\.0\.0\.1:55432\/oao$/mu,
  );
  assert.deepEqual(
    server.connections.map((url) => new URL(url).username),
    ["ben", "postgres", "admin"],
  );
});
