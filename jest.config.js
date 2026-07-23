module.exports = {
  testEnvironment: 'jsdom',
  setupFiles: ['./tests/setup.js'],
  moduleFileExtensions: ['js'],
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    '*.js',
    '!**/node_modules/**',
    '!**/vendor/**',
    '!**/coverage/**',
    '!**/tests/**',
    '!generate-icons.js',
    '!jest.config.js'
  ],
  coverageReporters: ['html', 'text', 'text-summary', 'lcov'],
  testPathIgnorePatterns: ['/node_modules/'],
  verbose: true,
  transform: {}
};
