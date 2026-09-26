import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'client-unit', environment: 'node', include: ['src/**/*.test.ts'] } });
