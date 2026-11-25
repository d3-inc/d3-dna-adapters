import { configDefaults, defineConfig } from 'vitest/config';

// The recipes' tests. Each package under packages/ runs its own suite in its own pool (`pnpm -r test`).
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'packages/**'],
  },
});
