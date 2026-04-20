/**
 * Generates PWA icon PNGs from the favicon.svg source.
 *
 * Produces:
 *   - public/icons/icon-192.png   (192x192, standard icon)
 *   - public/icons/icon-512.png   (512x512, standard icon)
 *   - public/icons/icon-maskable-512.png (512x512 with safe-zone padding)
 *
 * Usage: npx tsx scripts/generate-icons.ts
 *
 * Requires `sharp` as a dev dependency.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SVG_PATH = path.join(ROOT, 'public', 'favicon.svg');
const ICONS_DIR = path.join(ROOT, 'public', 'icons');

async function main(): Promise<void> {
  // Dynamic import — sharp is optional; fail with a helpful message
  let sharp: typeof import('sharp');
  try {
    sharp = await import('sharp');
  } catch {
    console.error(
      'sharp is not installed. Run: npm install --save-dev sharp\nThen re-run this script.',
    );
    process.exit(1);
  }

  fs.mkdirSync(ICONS_DIR, { recursive: true });

  const svgBuffer = fs.readFileSync(SVG_PATH);

  // Standard icons — render SVG at target resolution
  for (const size of [192, 512] as const) {
    await sharp
      .default(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(path.join(ICONS_DIR, `icon-${size}.png`));
    console.log(`  created icon-${size}.png`);
  }

  // Maskable icon — 512x512 with 20% safe-zone padding (icon content at 80%)
  const maskableInner = Math.round(512 * 0.8);
  const maskableOffset = Math.round((512 - maskableInner) / 2);
  const innerPng = await sharp
    .default(svgBuffer)
    .resize(maskableInner, maskableInner)
    .png()
    .toBuffer();

  await sharp
    .default({
      create: {
        width: 512,
        height: 512,
        channels: 4,
        background: { r: 15, g: 23, b: 42, alpha: 1 }, // #0f172a
      },
    })
    .composite([{ input: innerPng, left: maskableOffset, top: maskableOffset }])
    .png()
    .toFile(path.join(ICONS_DIR, 'icon-maskable-512.png'));
  console.log('  created icon-maskable-512.png');

  console.log('Done.');
}

main();
