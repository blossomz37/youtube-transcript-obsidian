import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
const out = new URL('./dist/youtube-transcript-notes/', import.meta.url);
await mkdir(out, { recursive: true });
await build({ entryPoints: [new URL('./src/main.js', import.meta.url).pathname],
  outfile: new URL('./main.js', import.meta.url).pathname, bundle: true, platform: 'node',
  format: 'cjs', target: 'es2022', external: ['obsidian'], loader: { '.md': 'text' },
  logLevel: 'info' });
for (const name of ['main.js', 'manifest.json', 'styles.css']) await copyFile(new URL(name, import.meta.url), new URL(name, out));
