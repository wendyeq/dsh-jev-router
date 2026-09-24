import { defineConfig } from 'tsdown'

/** Bundle the profile plugin. Harness packages stay external and resolve in the host. */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  external: [/^@deepseek-ai\//, 'zod'],
  outputOptions: { entryFileNames: '[name].js' },
  dts: false,
  clean: true,
})
