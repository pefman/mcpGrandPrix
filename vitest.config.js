import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // The client's vendored three build (the browser resolves it via the
      // importmap in client/index.html); lets unit tests import the
      // client's scene/prop modules directly under Node.
      three: fileURLToPath(new URL('./client/vendor/three.module.js', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.js'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
