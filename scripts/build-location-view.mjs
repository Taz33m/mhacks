import { build } from 'esbuild';

await build({
  entryPoints: ['scripts/location-engine-entry.js'], outfile: 'public/vendor/location-engine.js',
  bundle: true, format: 'esm', minify: true, target: 'es2022', legalComments: 'eof',
});
