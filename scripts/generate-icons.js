import sharp from 'sharp';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SVG = readFileSync(resolve(ROOT, 'images/full-logo.svg'));
const OUT = resolve(ROOT, 'public/icons');

const BACKGROUND = '#1a1a2e';

const sizes = [192, 512];

async function generateIcon(size, maskable) {
  const padding = maskable ? Math.round(size * 0.2) : Math.round(size * 0.05);
  const innerSize = size - padding * 2;

  const resized = await sharp(SVG)
    .resize(innerSize, innerSize, { fit: 'contain', background: BACKGROUND })
    .png()
    .toBuffer();

  const suffix = maskable ? '-maskable' : '';
  const outPath = resolve(OUT, `icon-${size}x${size}${suffix}.png`);

  await sharp({
    create: { width: size, height: size, channels: 4, background: BACKGROUND },
  })
    .composite([{ input: resized, gravity: 'centre' }])
    .png()
    .toFile(outPath);

  console.log(`  ${outPath}`);
}

console.log('Generating PWA icons...');

for (const size of sizes) {
  await generateIcon(size, false);
  await generateIcon(size, true);
}

console.log('Done!');
