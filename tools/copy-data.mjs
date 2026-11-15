/**
 * Copy the generated game assets into dist/data so the production build is
 * self-contained (Codex review P2: "生产部署包不自包含").
 *
 * data/ is produced by the Python pipeline in tools/ and is intentionally not
 * bundled by Vite (it is served by a dev/preview middleware in dev). For a real
 * deployment (any static host) the folder must sit next to index.html.
 */
import { cp, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = dirname(decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'));
const src = join(root, '..', 'data');
const dest = join(root, '..', 'dist', 'data');

if (!existsSync(src)) {
  console.error(`[copy-data] missing ${src}`);
  process.exit(1);
}
const st = await stat(src);
if (!st.isDirectory()) {
  console.error(`[copy-data] ${src} is not a directory`);
  process.exit(1);
}
await cp(src, dest, { recursive: true });
console.log(`[copy-data] ${src} -> ${dest}`);
