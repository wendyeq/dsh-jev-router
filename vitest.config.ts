import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../deepseek-harness/vitest.shared.ts'

const harness = fileURLToPath(new URL('../deepseek-harness/', import.meta.url))
const here = fileURLToPath(new URL('./', import.meta.url))

export default defineConfig({
  plugins: [
    standardDecoratorPlugin(),
    tsconfigPaths({ projects: [new URL('./tsconfig.json', import.meta.url).pathname, new URL('../deepseek-harness/tsconfig.base.json', import.meta.url).pathname] }),
  ],

  server: { fs: { allow: [harness, here] } },
  test: { environment: 'node', include: ['tests/**/*.spec.ts'] },
})
