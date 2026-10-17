import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import {
  MODEL_IMAGE_MAX_DIMENSION,
  ModelImageError,
  classifyFileContent,
  detectImageMimeType,
  prepareModelImage,
} from "../src/index.js";

function solid(width: number, height: number) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 32, g: 96, b: 160 },
    },
  });
}

// A macOS-style Retina screenshot: large PNG with an alpha channel.
async function screenshotPng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 2880,
      height: 1800,
      channels: 4,
      background: { r: 240, g: 240, b: 240, alpha: 1 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="200"><text x="20" y="120" font-size="96">Invoice 4815</text></svg>',
        ),
        top: 200,
        left: 200,
      },
    ])
    .png()
    .toBuffer();
}

async function noise(width: number, height: number): Promise<Buffer> {
  return sharp(randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  })
    .png()
    .toBuffer();
}

test("detects image formats from their leading bytes", async () => {
  assert.equal(
    detectImageMimeType(await solid(4, 4).png().toBuffer()),
    "image/png",
  );
  assert.equal(
    detectImageMimeType(await solid(4, 4).jpeg().toBuffer()),
    "image/jpeg",
  );
  assert.equal(
    detectImageMimeType(await solid(4, 4).gif().toBuffer()),
    "image/gif",
  );
  assert.equal(
    detectImageMimeType(await solid(4, 4).webp().toBuffer()),
    "image/webp",
  );
  assert.equal(
    detectImageMimeType(await solid(4, 4).tiff().toBuffer()),
    "image/tiff",
  );
  assert.equal(detectImageMimeType(Buffer.from("plain text")), undefined);
});

test("classifies text, images, and other binary files", async () => {
  const png = await solid(8, 8).png().toBuffer();
  assert.ok(png.includes(0), "a real PNG contains NUL bytes");
  assert.deepEqual(classifyFileContent(png), {
    kind: "image",
    mimeType: "image/png",
  });
  assert.deepEqual(classifyFileContent(Buffer.from("héllo\nworld")), {
    kind: "text",
    text: "héllo\nworld",
  });
  assert.deepEqual(classifyFileContent(Buffer.from("BMW fleet report")), {
    kind: "text",
    text: "BMW fleet report",
  });
  assert.deepEqual(
    classifyFileContent(
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi", "utf16le")]),
    ),
    { kind: "text", text: "hi" },
  );
  assert.deepEqual(classifyFileContent(Buffer.from("%PDF-1.7\n%âãÏÓ\n")), {
    kind: "binary",
    mimeType: "application/pdf",
    description: "PDF document",
  });
  assert.equal(
    classifyFileContent(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])).kind,
    "binary",
  );
  assert.deepEqual(classifyFileContent(Buffer.from("text\0with nul")), {
    kind: "binary",
    mimeType: "application/octet-stream",
    description: "binary data",
  });
});

test("small upright images pass through unchanged", async () => {
  const png = await solid(640, 480).png().toBuffer();
  const image = await prepareModelImage(png);
  assert.equal(image.converted, false);
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.data, png.toString("base64"));
  assert.equal(image.width, 640);
  assert.equal(image.height, 480);
});

test("large screenshots are downscaled deterministically", async () => {
  const png = await screenshotPng();
  const first = await prepareModelImage(png);
  const second = await prepareModelImage(png);
  assert.equal(first.converted, true);
  assert.equal(first.mimeType, "image/png");
  assert.equal(first.sourceWidth, 2880);
  assert.equal(first.sourceHeight, 1800);
  assert.equal(first.width, MODEL_IMAGE_MAX_DIMENSION);
  assert.equal(first.height, 1250);
  const metadata = await sharp(Buffer.from(first.data, "base64")).metadata();
  assert.equal(metadata.width, 2000);
  assert.equal(metadata.height, 1250);
  assert.equal(second.data, first.data, "normalization is deterministic");
});

test("rotated photos are auto-oriented before sending", async () => {
  const jpeg = await solid(300, 100)
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const image = await prepareModelImage(jpeg);
  assert.equal(image.converted, true);
  assert.equal(image.mimeType, "image/jpeg");
  assert.equal(image.width, 100);
  assert.equal(image.height, 300);
});

test("animated GIFs and TIFFs become single-frame PNGs", async () => {
  const first = await solid(20, 20).png().toBuffer();
  const second = await sharp({
    create: { width: 20, height: 20, channels: 3, background: "#ff0000" },
  })
    .png()
    .toBuffer();
  const animated = await sharp([first, second], {
    join: { animated: true },
  })
    .gif()
    .toBuffer();
  assert.equal((await sharp(animated).metadata()).pages, 2);
  const gif = await prepareModelImage(animated);
  assert.equal(gif.converted, true);
  assert.equal(gif.mimeType, "image/png");
  assert.equal(gif.height, 20);

  const tiff = await prepareModelImage(await solid(30, 10).tiff().toBuffer());
  assert.equal(tiff.converted, true);
  assert.equal(tiff.mimeType, "image/png");
  assert.equal(tiff.sourceMimeType, "image/tiff");
});

test("CMYK JPEGs are converted to sRGB", async () => {
  const cmyk = await solid(50, 50).toColourspace("cmyk").jpeg().toBuffer();
  assert.equal((await sharp(cmyk).metadata()).space, "cmyk");
  const image = await prepareModelImage(cmyk);
  assert.equal(image.converted, true);
  assert.equal(
    (await sharp(Buffer.from(image.data, "base64")).metadata()).space,
    "srgb",
  );
});

test("images over the byte limit fall back to JPEG and then shrink", async () => {
  const png = await noise(400, 400);
  const jpeg = await prepareModelImage(png, { maxBytes: 200_000 });
  assert.equal(jpeg.mimeType, "image/jpeg");
  assert.ok(jpeg.byteLength <= 200_000);
  assert.equal(jpeg.width, 400);

  const shrunk = await prepareModelImage(png, { maxBytes: 40_000 });
  assert.ok(shrunk.byteLength <= 40_000);
  assert.ok(shrunk.width < 400);
  assert.equal(shrunk.width, shrunk.height);
});

test("undecodable input fails with a model image error", async () => {
  await assert.rejects(
    prepareModelImage(Buffer.from("not an image")),
    ModelImageError,
  );
  const png = await solid(64, 64).png().toBuffer();
  await assert.rejects(prepareModelImage(png.subarray(0, 40)), ModelImageError);
  // A valid header with truncated pixel data must not be forwarded unchanged.
  const noisy = await noise(64, 64);
  const truncated = noisy.subarray(0, noisy.byteLength - 2_000);
  assert.equal((await sharp(truncated).metadata()).width, 64);
  await assert.rejects(prepareModelImage(truncated), ModelImageError);
});

test("text with a NUL byte past the sniff window stays readable", () => {
  const late = Buffer.concat([
    Buffer.from("x".repeat(9_000)),
    Buffer.from([0]),
    Buffer.from("tail"),
  ]);
  const content = classifyFileContent(late);
  assert.equal(content.kind, "text");
  if (content.kind === "text") {
    assert.ok(!content.text.includes(String.fromCodePoint(0)));
    assert.ok(content.text.endsWith(`${String.fromCodePoint(0xfffd)}tail`));
  }
});
