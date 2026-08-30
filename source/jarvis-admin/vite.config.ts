import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backendPort = env.PORT || '7711'
  const backendUrl = `http://localhost:${backendPort}`

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        { find: '@', replacement: path.resolve(import.meta.dirname, './src') },
        // R3F 9.7 calls THREE.Clock; route that constructor through the
        // Timer-backed compatibility class in src/lib/three-runtime.ts. The
        // anchored match leaves the shim's three/build import untouched.
        { find: /^three$/, replacement: path.resolve(import.meta.dirname, './src/lib/three-runtime.ts') },
      ],
    },
    server: {
      port: 7710,
      proxy: {
        '/api': backendUrl,
        '/health': backendUrl,
      },
    },
  }
})
