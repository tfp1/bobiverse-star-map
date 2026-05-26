// Disable SSR — the app is a Three.js client-only renderer, and
// adapter-static still prerenders the HTML shell.
export const prerender = true;
export const ssr = false;
