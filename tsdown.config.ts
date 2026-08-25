import { defineConfig } from 'tsdown'

const PLUGIN_ID = '@lansi-ai/dsh-fetch-url'

/**
 * Single-artifact host plugin: lib/index.mjs (ESM, node) registers the
 * `fetch_url` tool on ctx.tools. No browser half needed.
 */
export default defineConfig({
  name: `${PLUGIN_ID}/host`,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  dts: true,
  clean: false,
  deps: {
    neverBundle: (id) =>
      id === '@deepseek-ai/cordis' ||
      id === '@deepseek-ai/dsh-tools' ||
      id.startsWith('@deepseek-ai/dsh-'),
  },
})