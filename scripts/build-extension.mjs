#!/usr/bin/env node
/**
 * Builds the Kinetic Companion browser extension into extension/dist with Vite:
 * the service worker as an ES module, content scripts and pages as single IIFE files
 * (MV3 content scripts can't be modules), plus manifest, pages, CSS and generated icons.
 * Load extension/dist as an unpacked extension, or let Kinetic serve it at /companion/extension.zip.
 */
import { build } from 'vite';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const SRC = join(EXT, 'src');
const OUT = join(EXT, 'dist');

const entries = [
  { entry: 'background.ts', out: 'background.js', format: 'es' },
  { entry: 'capture.ts', out: 'capture.js', format: 'iife' },
  { entry: 'sites/linkedin.ts', out: 'sites/linkedin.js', format: 'iife' },
  { entry: 'sites/instagram.ts', out: 'sites/instagram.js', format: 'iife' },
  { entry: 'sites/x.ts', out: 'sites/x.js', format: 'iife' },
  { entry: 'sites/facebook.ts', out: 'sites/facebook.js', format: 'iife' },
  { entry: 'options.ts', out: 'options.js', format: 'iife' },
  { entry: 'popup.ts', out: 'popup.js', format: 'iife' },
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const e of entries) {
  await build({
    configFile: false,
    root: EXT,
    logLevel: 'warn',
    publicDir: false,
    build: {
      outDir: OUT,
      emptyOutDir: false,
      minify: false,
      sourcemap: false,
      target: 'chrome111',
      reportCompressedSize: false,
      lib: {
        entry: join(SRC, e.entry),
        formats: [e.format],
        name: 'KineticCompanion',
        fileName: () => e.out,
      },
    },
  });
}

const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
for (const f of ['options.html', 'popup.html', 'ui.css']) copyFileSync(join(SRC, f), join(OUT, f));
writeFileSync(join(OUT, 'version.json'), JSON.stringify({ version: manifest.version, built_at: new Date().toISOString() }, null, 2));

// ---- icons: the Kinetic mark (rounded square of four stripes), drawn as PNGs ----
mkdirSync(join(OUT, 'icons'), { recursive: true });
const STRIPES = [[0x3b, 0x5b, 0xfd], [0x14, 0xb8, 0xa6], [0xfb, 0xbf, 0x24], [0xf9, 0x73, 0x16]];
for (const size of [16, 32, 48, 128]) writeFileSync(join(OUT, 'icons', `${size}.png`), icon(size));

function icon(size) {
  const r = size * (6.5 / 24);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    const [cr, cg, cb] = STRIPES[Math.min(3, Math.floor((y / size) * 4))];
    for (let x = 0; x < size; x++) {
      // Coverage of a rounded rectangle, 4x4 supersampled for smooth corners.
      let inside = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const px = x + (sx + 0.5) / 4;
        const py = y + (sy + 0.5) / 4;
        const dx = Math.max(r - px, 0, px - (size - r));
        const dy = Math.max(r - py, 0, py - (size - r));
        if (dx * dx + dy * dy <= r * r) inside++;
      }
      const i = row + 1 + x * 4;
      raw[i] = cr; raw[i + 1] = cg; raw[i + 2] = cb; raw[i + 3] = Math.round((inside / 16) * 255);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

console.log(`Kinetic Companion ${manifest.version} built → ${OUT}`);
