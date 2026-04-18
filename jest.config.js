/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/e2e/**/*.spec.ts',
    '<rootDir>/apps/**/__tests__/**/*.test.ts',
  ],
  testTimeout: 120_000,
  maxWorkers: 1,
};
