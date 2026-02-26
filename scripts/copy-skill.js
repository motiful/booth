// Post-build: copy skill/ directory into dist/skill/
import { cpSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

cpSync(resolve(root, 'skill'), resolve(root, 'dist', 'skill'), {
  recursive: true,
  filter: (src) => !src.includes('.DS_Store'),
});

console.log('Copied skill/ → dist/skill/');
