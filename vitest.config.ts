import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': path.resolve(__dirname, 'src/shared'), '@ops': path.resolve(__dirname, 'src/main/operations') } },
  test: {
    environment: 'node',
    include: ['src/main/**/*.test.ts', 'src/core/**/*.test.ts', 'src/shared/**/*.test.ts', 'src/renderer/src/**/*.test.{ts,tsx}', 'src/web/**/*.test.{ts,tsx}']
  }
})
