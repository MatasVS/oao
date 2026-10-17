import sharp, { type Metadata, type OutputInfo } from "sharp";

/** Longest side, in pixels, of an image OAO sends to a model. */
export const MODEL_IMAGE_MAX_DIMENSION = 2_000;

/**
 * Encoded size limit for one image sent to a model. Base64 adds a third, so
 * the payload stays below the 5 MB per-image limit of the strictest provider.
 */
export const MODEL_IMAGE_MAX_BYTES = 3_500_000;

/**
 * Encoded size limit for all images attached to one message. Images stay in
 * the conversation history, so a long thread can still exceed a provider's
 * request-size limit; this only bounds what one message adds.
 */
export const MODEL_IMAGE_MAX_TOTAL_BYTES = 12_000_000;

/**
 * Identifies the preparation rules above. Change it whenever a change to them
 * would alter the bytes produced for the same input image.
 */
export const MODEL_IMAGE_POLICY_VERSION = 1;

/** Image formats every supported provider accepts as native image input. */
export const MODEL_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export type ModelImageMimeType = (typeof MODEL_IMAGE_MIME_TYPES)[number];

export function isModelImageMimeType(
  value: string,
): value is ModelImageMimeType {
  return (MODEL_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

/** Image formats OAO can decode and convert into a model image. */
export type DecodableImageMimeType = ModelImageMimeType | "image/tiff";

// Below this the image is too small to be useful, so shrinking stops.
const MINIMUM_DIMENSION = 256;
const JPEG_QUALITY = 85;
// Larger than any camera or screenshot; bounds decompression-bomb decodes.
const MAXIMUM_INPUT_PIXELS = 100_000_000;
// NUL bytes this early mark a file as binary, the same heuristic git uses.
const BINARY_SNIFF_BYTES = 8_000;
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);
// Color spaces every provider decodes; CMYK and others are converted to sRGB.
const PASSTHROUGH_COLOR_SPACES = new Set(["srgb", "b-w", "rgb16", "grey16"]);

export class ModelImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelImageError";
  }
}

function startsWith(
  bytes: Uint8Array,
  signature: readonly number[],
  offset = 0,
): boolean {
  if (bytes.byteLength < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(text: string): readonly number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

/** Identifies a decodable image from its leading bytes, never its name. */
export function detectImageMimeType(
  bytes: Uint8Array,
): DecodableImageMimeType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a")))
    return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8))
    return "image/webp";
  if (
    startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])
  )
    return "image/tiff";
  return undefined;
}

const BINARY_SIGNATURES: readonly {
  readonly mimeType: string;
  readonly description: string;
  readonly matches: (bytes: Uint8Array) => boolean;
}[] = [
  {
    mimeType: "application/pdf",
    description: "PDF document",
    matches: (bytes) => startsWith(bytes, ascii("%PDF-")),
  },
  {
    mimeType: "application/zip",
    description: "ZIP archive, also used by .docx, .xlsx, and .pptx files",
    matches: (bytes) =>
      startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
      startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]),
  },
  {
    mimeType: "application/x-ole-storage",
    description: "legacy Microsoft Office document",
    matches: (bytes) =>
      startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  },
  {
    mimeType: "application/gzip",
    description: "gzip archive",
    matches: (bytes) => startsWith(bytes, [0x1f, 0x8b]),
  },
  {
    mimeType: "application/x-xz",
    description: "xz archive",
    matches: (bytes) => startsWith(bytes, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
  },
  {
    mimeType: "application/x-7z-compressed",
    description: "7-Zip archive",
    matches: (bytes) => startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
  },
  {
    mimeType: "application/x-tar",
    description: "tar archive",
    matches: (bytes) => startsWith(bytes, ascii("ustar"), 257),
  },
  {
    mimeType: "application/vnd.sqlite3",
    description: "SQLite database",
    matches: (bytes) => startsWith(bytes, ascii("SQLite format 3\0")),
  },
  {
    mimeType: "application/x-executable",
    description: "ELF executable",
    matches: (bytes) => startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46]),
  },
  {
    mimeType: "application/wasm",
    description: "WebAssembly module",
    matches: (bytes) => startsWith(bytes, [0x00, 0x61, 0x73, 0x6d]),
  },
  {
    mimeType: "image/bmp",
    description: "BMP image",
    // The reserved header bytes are zero, so text starting "BM" never matches.
    matches: (bytes) =>
      startsWith(bytes, ascii("BM")) && startsWith(bytes, [0, 0, 0, 0], 6),
  },
  {
    mimeType: "image/heic",
    description: "HEIC or AVIF image",
    matches: (bytes) =>
      startsWith(bytes, ascii("ftyp"), 4) &&
      ["heic", "heix", "mif1", "msf1", "avif", "avis"].some((brand) =>
        startsWith(bytes, ascii(brand), 8),
      ),
  },
  {
    mimeType: "video/mp4",
    description: "MP4 or QuickTime media",
    matches: (bytes) => startsWith(bytes, ascii("ftyp"), 4),
  },
];

export type FileContentKind =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly mimeType: DecodableImageMimeType }
  | {
      readonly kind: "binary";
      readonly mimeType: string;
      readonly description: string;
    };

/**
 * Classifies file bytes for a model-facing read: a decodable image, text, or
 * other binary data. A known binary signature or a NUL byte in the first
 * 8,000 bytes marks the file as binary, unless it starts with a UTF-16
 * byte-order mark. NUL characters later in a text file become U+FFFD.
 */
export function classifyFileContent(bytes: Uint8Array): FileContentKind {
  const imageType = detectImageMimeType(bytes);
  if (imageType) return { kind: "image", mimeType: imageType };
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (startsWith(buffer, [0xff, 0xfe]) || startsWith(buffer, [0xfe, 0xff])) {
    const text = new TextDecoder(
      buffer[0] === 0xff ? "utf-16le" : "utf-16be",
    ).decode(buffer);
    if (!text.slice(0, BINARY_SNIFF_BYTES).includes("\0"))
      return {
        kind: "text",
        text: text.replaceAll("\0", REPLACEMENT_CHARACTER),
      };
  }
  const signature = BINARY_SIGNATURES.find((candidate) =>
    candidate.matches(buffer),
  );
  if (signature)
    return {
      kind: "binary",
      mimeType: signature.mimeType,
      description: signature.description,
    };
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0))
    return {
      kind: "binary",
      mimeType: "application/octet-stream",
      description: "binary data",
    };
  return {
    kind: "text",
    text: new TextDecoder("utf-8")
      .decode(buffer)
      .replaceAll("\0", REPLACEMENT_CHARACTER),
  };
}

export interface ModelImage {
  /** Base64 image bytes for a model image content block. */
  readonly data: string;
  readonly mimeType: ModelImageMimeType;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly sourceMimeType: DecodableImageMimeType;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** False when the original bytes are sent unchanged. */
  readonly converted: boolean;
}

export interface ModelImageOptions {
  readonly maxDimension?: number;
  readonly maxBytes?: number;
}

function fitWithin(
  width: number,
  height: number,
  maxDimension: number,
): { readonly width: number; readonly height: number } {
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Prepares image bytes for native model input. Every image is first decoded in
 * full, upright and bounded to `maxDimension` on its long side, so a corrupt or
 * truncated file is rejected rather than forwarded. An image that is already
 * a provider-accepted format, upright, single-frame, sRGB, and inside the size
 * bounds is then sent unchanged. Anything else is encoded from those pixels as
 * PNG, or as JPEG for JPEG sources or when PNG would exceed `maxBytes`, and
 * shrunk further while it is still too large. The output is deterministic for
 * the same bytes and sharp build, which keeps retried dispatches identical.
 */
export async function prepareModelImage(
  bytes: Uint8Array,
  options: ModelImageOptions = {},
): Promise<ModelImage> {
  const maxDimension = options.maxDimension ?? MODEL_IMAGE_MAX_DIMENSION;
  const maxBytes = options.maxBytes ?? MODEL_IMAGE_MAX_BYTES;
  const sourceMimeType = detectImageMimeType(bytes);
  if (!sourceMimeType)
    throw new ModelImageError("The file is not a supported image format");
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decode = () =>
    sharp(input, {
      failOn: "error",
      limitInputPixels: MAXIMUM_INPUT_PIXELS,
      sequentialRead: true,
    });
  let metadata: Metadata;
  try {
    metadata = await decode().metadata();
  } catch {
    throw new ModelImageError("The image could not be decoded");
  }
  const { width, height } = metadata;
  if (!width || !height)
    throw new ModelImageError("The image has no readable dimensions");
  // EXIF orientations 5-8 rotate by 90 degrees, so the upright size swaps.
  const rotated = (metadata.orientation ?? 1) >= 5;
  const sourceWidth = rotated ? height : width;
  const sourceHeight = rotated ? width : height;
  const bounded = fitWithin(sourceWidth, sourceHeight, maxDimension);
  let pixels: { readonly data: Buffer; readonly info: OutputInfo };
  try {
    pixels = await decode()
      .rotate()
      .resize({ width: bounded.width, height: bounded.height, fit: "fill" })
      .toColourspace("srgb")
      .raw({ depth: "uchar" })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new ModelImageError("The image could not be decoded");
  }
  if (
    sourceMimeType !== "image/tiff" &&
    (metadata.orientation ?? 1) === 1 &&
    (metadata.pages ?? 1) === 1 &&
    PASSTHROUGH_COLOR_SPACES.has(metadata.space ?? "srgb") &&
    Math.max(width, height) <= maxDimension &&
    input.byteLength <= maxBytes
  )
    return {
      data: input.toString("base64"),
      mimeType: sourceMimeType,
      byteLength: input.byteLength,
      width,
      height,
      sourceMimeType,
      sourceWidth,
      sourceHeight,
      converted: false,
    };
  const raw = {
    width: pixels.info.width,
    height: pixels.info.height,
    channels: pixels.info.channels,
  };
  const encodings: readonly ("png" | "jpeg")[] =
    sourceMimeType === "image/jpeg" ? ["jpeg"] : ["png", "jpeg"];
  let target = bounded;
  for (;;) {
    for (const encoding of encodings) {
      let output: Buffer;
      try {
        let pipeline = sharp(pixels.data, { raw });
        if (target.width !== raw.width || target.height !== raw.height)
          pipeline = pipeline.resize({
            width: target.width,
            height: target.height,
            fit: "fill",
          });
        output =
          encoding === "png"
            ? await pipeline.png().toBuffer()
            : await pipeline
                .flatten({ background: "#ffffff" })
                .jpeg({ quality: JPEG_QUALITY })
                .toBuffer();
      } catch {
        throw new ModelImageError("The image could not be converted");
      }
      if (output.byteLength <= maxBytes)
        return {
          data: output.toString("base64"),
          mimeType: encoding === "png" ? "image/png" : "image/jpeg",
          byteLength: output.byteLength,
          width: target.width,
          height: target.height,
          sourceMimeType,
          sourceWidth,
          sourceHeight,
          converted: true,
        };
    }
    const longSide = Math.max(target.width, target.height);
    if (longSide <= MINIMUM_DIMENSION)
      throw new ModelImageError(
        "The image cannot be reduced below the model image size limit",
      );
    target = fitWithin(
      sourceWidth,
      sourceHeight,
      Math.max(MINIMUM_DIMENSION, Math.floor(longSide * 0.75)),
    );
  }
}
