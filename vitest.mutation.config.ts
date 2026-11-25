import { defineConfig } from 'vitest/config';

/** Named, because vitest otherwise picks up `vitest.workspace.ts`, live agents included. */
export default defineConfig({ test: { workspace: 'vitest.mutation.workspace.ts' } });
