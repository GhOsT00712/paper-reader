import { cpSync } from 'node:fs';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    tailwindcss(),
    {
      name: 'pdf-resources',
      writeBundle({ dir }) {
        for (const resource of ['wasm', 'cmaps', 'iccs', 'standard_fonts']) {
          cpSync('node_modules/pdfjs-dist/' + resource, dir + '/pdf-resources/' + resource, { recursive: true });
        }
      }
    }
  ],
  build: { rollupOptions: { input: { library: 'index.html', reader: 'reader.html' } } }
});
