import { mdsvex } from 'mdsvex'
import adapter from '@sveltejs/adapter-static'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

const config = {
  preprocess: [vitePreprocess(), mdsvex()],
  kit: {
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      fallback: 'index.html',
      precompress: false,
      strict: false
    }),
    alias: {
      '@/*': './src/*',
    },
  },
  vitePlugin: {
    inspector: true,
  },
  compilerOptions: {
    runes: true,
    enableSourcemap: true,
  },
  extensions: ['.svelte', '.svx'],
}

export default config
