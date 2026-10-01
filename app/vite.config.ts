import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base + hash routing: the same build works at / and at /vetowall/ on Pages.
export default defineConfig({
  base: './',
  plugins: [react()],
});
