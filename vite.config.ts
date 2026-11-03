import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-static';

export default defineConfig({
	plugins: [
        sveltekit({
            compilerOptions: {
                // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
                runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
            },
            adapter: adapter({
                // GitHub Pages needs a 404 fallback for direct URL navigation.
                fallback: '404.html'
            }),
            // BASE_PATH is set in the GitHub Actions workflow to /repo-name.
            // Leave empty for a username.github.io root deployment.
            paths: {
                // Use a type assertion to satisfy SvelteKit's template literal string requirement
                base: (process.env.BASE_PATH ?? '') as `/${string}` | ''
            }
        })
    ],
    assetsInclude: ['**/*.wasm']
});
