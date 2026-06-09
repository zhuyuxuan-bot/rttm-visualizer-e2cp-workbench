import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: process.env.GITHUB_PAGES === 'true' ? '/rttm-visualizer-e2cp-workbench/' : '/',
  plugins: [react()],
})
