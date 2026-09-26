import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'scripts', environment: 'node', include: ['__tests__/**/*.test.ts'] } });
