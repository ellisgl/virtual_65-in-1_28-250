import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter({
			// GitHub Pages needs a 404 fallback for direct URL navigation.
			fallback: '404.html'
		}),
		// BASE_PATH is set in the GitHub Actions workflow to /repo-name.
		// Leave empty for a username.github.io root deployment.
		paths: {
			base: process.env.BASE_PATH ?? ''
		}
	}
};

export default config;
