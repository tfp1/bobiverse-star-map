<script lang="ts">
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { mountScene, type SceneHandle, type SceneStats } from '$lib/three/Scene';
	import type { Selection } from '$lib/three/picking';
	import InfoPanel from '$lib/ui/InfoPanel.svelte';

	let container: HTMLDivElement;
	let error = $state<string | null>(null);
	let stats = $state<SceneStats | null>(null);
	let selection = $state<Selection | null>(null);

	onMount(() => {
		let handle: SceneHandle | undefined;
		let cancelled = false;
		mountScene(container, {
			starsBinUrl: `${base}/stars-near.bin`,
			onSelect: (sel) => {
				selection = sel;
			}
		})
			.then((h) => {
				if (cancelled) {
					h.dispose();
				} else {
					handle = h;
					stats = h.stats;
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
		{#if stats}
			<p class="small">
				{stats.systems} systems · {stats.bobs} bobs ·
				<span class="rep">{stats.replicationEdges} replication</span> ·
				<span class="trv">{stats.travelEdges} travel</span> edges
			</p>
		{:else if !error}
			<p class="small">loading…</p>
		{/if}
	</div>
	<InfoPanel {selection} onClose={() => (selection = null)} />
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
		opacity: 0.7;
		font-size: 0.7rem;
	}
	.hud .rep {
		color: #9b7cff;
	}
	.hud .trv {
		color: #ffb15c;
	}
	.error {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		color: #ff8080;
		padding: 1rem;
	}
	:global(.system-label) {
		color: #cfe4ff;
		font-size: 11px;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		letter-spacing: 0.02em;
		padding: 1px 6px;
		background: rgba(0, 8, 24, 0.55);
		border: 1px solid rgba(111, 195, 255, 0.35);
		border-radius: 3px;
		transform: translate(10px, -50%);
		white-space: nowrap;
		text-shadow: 0 0 4px #000;
	}
</style>
