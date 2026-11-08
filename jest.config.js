module.exports = {
  testPathIgnorePatterns: ['/node_modules/', '/.next/', '/e2e/', '<rootDir>/\\.opencode-local/'],
  transform: {
    '^.+\.(js|jsx|ts|tsx)$': ['ts-jest', {
      tsconfig: 'tsconfig.jest.json'
    }],
  },
  transformIgnorePatterns: ['/node_modules/'],
  testEnvironment: 'jsdom',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};