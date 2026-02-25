import { resolve, dirname } from 'path';
import { cpSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import netlify from '@netlify/vite-plugin';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Plugin: copies non-module scripts and static assets to dist/ so classic
// <script> tags and AJAX-loaded partials resolve correctly.
// Non-module scripts will be converted to ES modules in Phase 4, at which
// point most of these entries can be removed.
function copyStaticAssets() {
  const dirs = [
    // Non-module (classic) scripts
    'assets/js',
    'sync-system',
    'apps/mario-kart/js',
    'apps/football-h2h/js',
    'apps/gym-tracker/js',
    'apps/gym-tracker/data',
    // Shared utilities - imported by gym-tracker ES modules
    'shared',
    // Images - needed un-hashed for AJAX-loaded partials (/images/logo-top.png)
    'images',
  ];

  return {
    name: 'copy-static-assets',
    closeBundle() {
      for (const dir of dirs) {
        const src = resolve(__dirname, dir);
        const dest = resolve(__dirname, 'dist', dir);
        if (existsSync(src)) {
          cpSync(src, dest, { recursive: true });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [netlify(), copyStaticAssets()],

  root: '.',
  publicDir: 'public',

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        home: resolve(__dirname, 'home.html'),
        product: resolve(__dirname, 'product.html'),
        apps: resolve(__dirname, 'apps.html'),
        moadonAlef: resolve(__dirname, 'moadon-alef.html'),
        notFound: resolve(__dirname, '404.html'),
        marioKart: resolve(__dirname, 'apps/mario-kart/tracker.html'),
        gymTracker: resolve(__dirname, 'apps/gym-tracker/index.html'),
        gymTrackerOld: resolve(__dirname, 'apps/gym-tracker/index-old.html'),
        footballH2h: resolve(__dirname, 'apps/football-h2h/index.html'),
      },
    },
  },

  server: {
    open: '/home.html',
  },
});
