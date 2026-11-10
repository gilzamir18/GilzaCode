import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendTarget = process.env.GILZACODE_BACKEND_URL || 'http://localhost:3100';

// Puts the startup splash (public/splash.html, its single source) inside #root,
// so it stays on screen while the bundle loads and React replaces it on its
// first render. The desktop shell shows the same page before the window has a
// server to load from; see the comment at the top of splash.html.
function inlineSplash() {
  const read = (name) => fs.readFileSync(path.resolve(__dirname, 'public', name));
  const pick = (source, pattern, what) => {
    const match = source.match(pattern);
    if (!match) throw new Error(`public/splash.html: ${what} not found`);
    return match[0];
  };
  return {
    name: 'gilzacode-inline-splash',
    transformIndexHtml(html) {
      const source = read('splash.html').toString('utf8');
      const icon = `data:image/png;base64,${read('splash-icon.png').toString('base64')}`;
      const style = pick(source, /<style id="gilzabots-splash-style">[\s\S]*?<\/style>/, 'splash style');
      const markup = pick(source, /<!-- splash:begin -->[\s\S]*?<!-- splash:end -->/, 'splash markup')
        .replace('src="__SPLASH_ICON__"', `src="${icon}"`)
        .replace('data-status="loading"', 'data-status="opening"');
      if (!html.includes('<div id="root"></div>')) throw new Error('index.html: empty #root not found');
      return html
        .replace('</head>', `${style}\n  </head>`)
        .replace('<div id="root"></div>', `<div id="root">${markup}</div>`);
    },
  };
}

export default defineConfig({
  plugins: [react(), inlineSplash()],
  resolve: {
    alias: [
      {
        find: /^stream$/,
        replacement: path.resolve(__dirname, 'src/shims/nodeStream.js'),
      },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: backendTarget,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq, req) => {
            // Preserve same-origin semantics across the development proxy.
            // A foreign Origin is kept verbatim so the backend refuses it.
            if (req.headers.origin === `http://${req.headers.host}`) {
              proxyReq.setHeader('origin', new URL(backendTarget).origin);
            }
          });
        }
      }
    }
  },
  build: {
    outDir: path.resolve(__dirname, '../gilzacode/static'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react') || id.includes('react-dom')) {
              return 'vendor-react';
            }
            if (id.includes('@monaco-editor')) {
              return 'vendor-monaco';
            }
            if (id.includes('@xterm')) {
              return 'vendor-xterm';
            }
          }
        }
      }
    }
  }
});
