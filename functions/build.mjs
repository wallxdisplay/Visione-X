// Bundles Cloud Functions into lib/index.js. `--watch` rebuilds on change (the Functions
// emulator reloads lib/ automatically).
// Workspace packages (@visione-x/*) are inlined because they are not published to npm, so the
// deploy-time `npm install` only needs the real dependencies listed in package.json.
import { build, context } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const options = {
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: Object.keys(pkg.dependencies ?? {}),
  // ESM output still needs `require` for some transitive CommonJS modules.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
