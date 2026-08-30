import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The compose regen/upgrade suites (compose-upgrader, install-regenerate) do
    // real filesystem work — backup dirs, full docker-compose.yml + .env + init-db
    // generation — and the first test in each file also pays a cold-start import
    // cost. That can exceed vitest's 5s default on a cold or contended CI runner,
    // producing flaky timeouts (green locally, red in CI). Give them headroom.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
})
