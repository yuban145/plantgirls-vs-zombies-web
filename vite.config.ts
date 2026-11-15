import { defineConfig } from 'vite';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serves the generated game assets from <root>/data at /data so the
 * asset pipeline can keep writing into data/ without copying into public/.
 */
function gameDataPlugin(): Plugin {
  const root = fileURLToPath(new URL('./data', import.meta.url));
  return {
    name: 'serve-game-data',
    configureServer(server) {
      server.middlewares.use('/data', (req, res, next) => {
        const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        const filePath = normalize(join(root, urlPath));
        if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) {
          next();
          return;
        }
        res.setHeader('Content-Type', MIME[extname(filePath).toLowerCase()] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(filePath).pipe(res);
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use('/data', (req, res, next) => {
        const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        const filePath = normalize(join(root, urlPath));
        if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) {
          next();
          return;
        }
        res.setHeader('Content-Type', MIME[extname(filePath).toLowerCase()] || 'application/octet-stream');
        createReadStream(filePath).pipe(res);
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [gameDataPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5188,
    strictPort: true,
    watch: {
      // The edit tool writes atomically via temp dirs inside the tree; the
      // native watcher throws EBUSY if it tries to watch those transient files.
      ignored: ['**/*.tmp', '**/*.tmpdir/**', '**/.*.tmpdir/**'],
    },
  },
  build: { outDir: 'dist', assetsInlineLimit: 0 },
});
