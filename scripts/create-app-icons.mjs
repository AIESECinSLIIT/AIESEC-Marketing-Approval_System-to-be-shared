import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
// Generate the app's existing blue/check brand as installable PNG icons.
function crc(buffer) {
  let c = 0xffffffff;
  for (const b of buffer) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name),
    head = Buffer.alloc(4),
    tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  tail.writeUInt32BE(crc(Buffer.concat([type, data])));
  return Buffer.concat([head, type, data, tail]);
}
function distance(x, y, ax, ay, bx, by) {
  const t = Math.max(
    0,
    Math.min(
      1,
      ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) /
        ((bx - ax) ** 2 + (by - ay) ** 2),
    ),
  );
  return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
}
mkdirSync(new URL("../public/icons/", import.meta.url), { recursive: true });
for (const size of [96, 192, 512]) {
  const data = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const px = x / size,
        py = y / size;
      const check =
        Math.min(
          distance(px, py, 0.28, 0.51, 0.43, 0.66),
          distance(px, py, 0.43, 0.66, 0.73, 0.34),
        ) < 0.045;
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      data.set(
        check
          ? [255, 255, 255, 255]
          : size === 96
            ? [0, 0, 0, 0]
            : [8, 124, 240, 255],
        offset,
      );
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  writeFileSync(
    new URL(
      `../public/icons/${size === 96 ? "badge" : `icon-${size}`}.png`,
      import.meta.url,
    ),
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(data)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}
