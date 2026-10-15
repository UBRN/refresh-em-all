module.exports = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/tests'],
  setupFiles: ['./tests/setup.js'],
  moduleFileExtensions: ['js'],
  testMatch: ['**/tests/**/*.test.js'],
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
