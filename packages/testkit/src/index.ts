import type {
  Brand,
  ClockPort,
  IdPort,
  ModelPort,
  ModelRequest,
  ModelResponse,
  OrganizationId,
  Principal,
  PrincipalId,
  ProjectId,
  SandboxPort,
} from "@oao/domain";
import { brandedId } from "@oao/domain";
import { crc32, deflateSync } from "node:zlib";

export class DeterministicClock implements ClockPort {
  #current: Date;
  constructor(start = new Date("2026-01-01T00:00:00.000Z")) {
    this.#current = new Date(start);
  }
  now(): Date {
    return new Date(this.#current);
  }
  advance(milliseconds: number): void {
    this.#current = new Date(this.#current.getTime() + milliseconds);
  }
}

export class DeterministicIds implements IdPort {
  #next = 1;
  next<T extends Brand<string, string>>(): T {
    const suffix = this.#next.toString(16).padStart(12, "0");
    this.#next += 1;
    return brandedId<T>(`00000000-0000-4000-8000-${suffix}`);
  }
}

export function deterministicPrincipal(
  overrides: Partial<Principal> = {},
): Principal {
  return {
    id: brandedId<PrincipalId>("00000000-0000-4000-8000-000000000003"),
    organizationId: brandedId<OrganizationId>(
      "00000000-0000-4000-8000-000000000001",
    ),
    projectId: brandedId<ProjectId>("00000000-0000-4000-8000-000000000002"),
    kind: "human",
    subject: "development-user",
    scopes: new Set(["*"]),
    ...overrides,
  };
}

export class FakeModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  #responses: ModelResponse[];
  constructor(responses: readonly ModelResponse[] = []) {
    this.#responses = [...responses];
  }
  async invoke(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return (
      this.#responses.shift() ?? {
        redactedText: "deterministic response",
        finishReason: "stop",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      }
    );
  }
}

export class FakeSandbox implements SandboxPort {
  readonly calls: string[] = [];
  async create(): Promise<{ readonly sandboxRef: string }> {
    this.calls.push("create");
    return { sandboxRef: "sandbox_test" };
  }
  async execute(input: {
    readonly command: string;
  }): Promise<{ readonly exitCode: number; readonly redactedOutput: string }> {
    this.calls.push(`execute:${input.command}`);
    return { exitCode: 0, redactedOutput: "ok" };
  }
  async stop(sandboxRef: string): Promise<void> {
    this.calls.push(`stop:${sandboxRef}`);
  }
}

export type CrashPoint =
  | "before_obligation"
  | "after_obligation"
  | "after_provider"
  | "before_commit"
  | "after_commit";
export class CrashBarrier extends Error {
  readonly reached: CrashPoint[] = [];
  #armed: CrashPoint | undefined;
  arm(point: CrashPoint): void {
    this.#armed = point;
  }
  async reach(point: CrashPoint): Promise<void> {
    this.reached.push(point);
    if (this.#armed === point) {
      this.#armed = undefined;
      throw new SimulatedCrash(point);
    }
  }
}

export class SimulatedCrash extends Error {
  constructor(readonly point: CrashPoint) {
    super(`Simulated crash at ${point}`);
    this.name = "SimulatedCrash";
  }
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

/**
 * A real single-colour 8-bit RGB PNG. Like every PNG, its header and
 * compressed data contain NUL bytes, so it exercises binary handling.
 */
export function createTestPng(
  width: number,
  height: number,
  rgb: readonly [number, number, number] = [32, 96, 160],
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set(rgb, 1 + x * 3);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A real 8-bit RGB PNG of seeded pseudo-random pixels. Noise does not
 * compress, so the file stays about 3 bytes per pixel.
 */
export function createNoisePng(
  width: number,
  height: number,
  seed = 1,
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(height * (1 + width * 3));
  let state = seed >>> 0 || 1;
  for (let index = 0; index < pixels.length; index += 1) {
    if (index % (1 + width * 3) === 0) continue;
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels[index] = state & 0xff;
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Reads the pixel size from a PNG header. */
export function pngDimensions(bytes: Uint8Array): {
  readonly width: number;
  readonly height: number;
} {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE))
    throw new TypeError("Not a PNG");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
