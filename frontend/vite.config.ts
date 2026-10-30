import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'

// The WebAssembly decoders of pdf.js (JBIG2 and CCITT images of scans, JPEG 2000, colour profiles), loaded by its worker
// from the directory given as `wasmUrl` (extraction/navigateur.ts); without them, the image of a scan is left out of
// its rendering. Served from node_modules in development, copied into the build; the version of pdf.js is in the path,
// as the server keeps assets a year. Not the JavaScript interpreter (quickjs): the scripts of a PDF are never run.
const PDFJS = fileURLToPath(new URL('./node_modules/pdfjs-dist/', import.meta.url))
const PDFJS_WASM = `assets/pdfjs-${JSON.parse(readFileSync(`${PDFJS}package.json`, 'utf8')).version}/`
const PDFJS_FICHIERS = readdirSync(`${PDFJS}wasm`).filter((f) => !f.startsWith('quickjs'))

function pdfjsWasm(): Plugin {
  return {
    name: 'pdfjs-wasm',
    config: () => ({ define: { __PDFJS_WASM__: JSON.stringify(`/${PDFJS_WASM}`) } }),
    configureServer(server) {
      server.middlewares.use(`/${PDFJS_WASM}`, (req, res, next) => {
        const fichier = req.url?.slice(1).split('?')[0]
        if (!fichier || !PDFJS_FICHIERS.includes(fichier)) {
          return next()
        }
        res.setHeader('content-type', fichier.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        res.end(readFileSync(`${PDFJS}wasm/${fichier}`))
      })
    },
    generateBundle() {
      for (const fichier of PDFJS_FICHIERS) {
        this.emitFile({ type: 'asset', fileName: `${PDFJS_WASM}${fichier}`, source: readFileSync(`${PDFJS}wasm/${fichier}`) })
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), pdfjsWasm()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: true,
    // Same origin as in production, where Nginx serves /api (ADR 0002): no CORS to configure.
    // API_URL points to another backend (another port, a test database).
    proxy: {
      '/api': process.env.API_URL ?? 'http://127.0.0.1:3000',
    },
  },
})
