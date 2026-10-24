// Used automatically by `web-ext lint|build|sign`.
export default {
  sourceDir: '.',
  artifactsDir: 'web-ext-artifacts',
  ignoreFiles: [
    'test', 'scripts', 'node_modules', 'web-ext-artifacts',
    'package.json', 'package-lock.json', 'README.md', 'web-ext-config.mjs',
  ],
  lint: { selfHosted: true },
  sign: { channel: 'unlisted' },
};
