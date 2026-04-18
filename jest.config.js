/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/e2e/**/*.spec.ts',
    '<rootDir>/apps/**/*.spec.ts',
  ],
  testTimeout: 120_000,
  maxWorkers: 1,
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  collectCoverageFrom: [
    'apps/cliproxy/ui/**/*.ts',
    '!**/*.d.ts',
  ],
  coverageThreshold: {
    global: {
      lines: 70,
    },
  },
  coverageReporters: ['json', 'text', 'lcov'],
};
