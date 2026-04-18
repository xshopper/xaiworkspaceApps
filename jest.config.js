/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/e2e/**/*.spec.ts'],
  testTimeout: 120_000,
  maxWorkers: 1,
  collectCoverage: true,
  collectCoverageFrom: [
    'apps/cliproxy/ui/**/*.ts',
    '!**/*.d.ts',
    '!**/node_modules/**',
  ],
  coverageReporters: ['text', 'lcov', 'json'],
  coveragePathIgnorePatterns: ['/node_modules/'],
  coverageThreshold: {
    global: {
      lines: 0,
    },
  },
};
