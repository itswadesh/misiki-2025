import adapter from '@sveltejs/adapter-auto'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		adapter: adapter(),
     alias: {
      '@/*': './src/*',
    },
	},
	vitePlugin: {
		inspector: true
	},
  compilerOptions: {
    runes: true,
    enableSourcemap: true,
  },
  extensions: ['.svelte', '.svx'],
}

export default config
