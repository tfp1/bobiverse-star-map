<script lang="ts">
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { mountScene, type SceneHandle } from '$lib/three/Scene';

	let container: HTMLDivElement;
	let error = $state<string | null>(null);

	onMount(() => {
		let handle: SceneHandle | undefined;
		let cancelled = false;
		mountScene(container, { starsBinUrl: `${base}/stars-near.bin` })
			.then((h) => {
				if (cancelled) {
					h.dispose();
				} else {
					handle = h;
				}
			})
			.catch((e: unknown) => {
				if (cancelled) return;
				error = e instanceof Error ? e.message : String(e);
				console.error(e);
			});
		return () => {
			cancelled = true;
			handle?.dispose();
		};
	});
</script>

<div class="root" bind:this={container}>
	{#if error}
		<div class="error">Failed to load scene: {error}</div>
	{/if}
	<div class="hud">
		<h1>Bobiverse Star Map</h1>
		<p>WASD to fly · drag mouse to look · R/F up/down · Q/E roll</p>
		<p class="small">v0 · spatial scaffold · overlay graph coming next</p>
	</div>
</div>

<style>
	:global(html),
	:global(body) {
		margin: 0;
		padding: 0;
		height: 100%;
		background: #000005;
		color: #d8dde6;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		overflow: hidden;
	}
	.root {
		position: fixed;
		inset: 0;
	}
	.hud {
		position: absolute;
		top: 12px;
		left: 16px;
		pointer-events: none;
		text-shadow: 0 0 6px #000;
	}
	.hud h1 {
		margin: 0;
		font-size: 1.1rem;
		font-weight: 500;
		letter-spacing: 0.04em;
	}
	.hud p {
		margin: 4px 0 0 0;
		font-size: 0.8rem;
		opacity: 0.8;
	}
	.hud .small {
		opacity: 0.5;
		font-size: 0.7rem;
	}
	.error {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		color: #ff8080;
		padding: 1rem;
	}
</style>
