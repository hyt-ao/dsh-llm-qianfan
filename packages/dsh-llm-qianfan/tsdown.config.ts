// packages/llm/llm-qianfan/tsdown.config.ts
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  dts: true,
  // Keep the historical `lib/index.js` + `lib/index.d.ts` naming the package
  // exposes (tsdown's newer default is `.mjs`/`.d.mts`, which would break
  // `main`/`types`/`exports` — force the legacy extension).
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
