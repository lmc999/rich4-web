import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'extract', environment: 'node', include: ['test/**/*.test.ts'] } });
