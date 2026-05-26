<script lang="ts">
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { mountScene, type SceneHandle, type SceneStats } from '$lib/three/Scene';
	import type { Selection } from '$lib/three/picking';
	import InfoPanel from '$lib/ui/InfoPanel.svelte';
	import { parseHash, writeHash } from '$lib/url/hash';

	const DEFAULT_TIER = 1;
	const BOOKS = [1, 2, 3, 4, 5] as const;

	let container: HTMLDivElement;
	let error = $state<string | null>(null);
	let stats = $state<SceneStats | null>(null);
	let selection = $state<Selection | null>(null);
	let tier = $state<number>(DEFAULT_TIER);
	let handle: SceneHandle | undefined;

	onMount(() => {
		const initial = parseHash(window.location.hash, { tier: DEFAULT_TIER });
		tier = initial.tier;

		let cancelled = false;
		mountScene(container, {
			starsBinUrl: `${base}/stars-near.bin`,
			initialTier: tier,
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

		const onHashChange = () => {
			const next = parseHash(window.location.hash, { tier: DEFAULT_TIER });
			if (next.tier !== tier) {
				tier = next.tier;
				selection = null;
				if (handle) stats = handle.applyTier(tier);
			}
		};
		window.addEventListener('hashchange', onHashChange);

		return () => {
			cancelled = true;
			window.removeEventListener('hashchange', onHashChange);
			handle?.dispose();
			handle = undefined;
		};
	});

	function selectTier(next: number) {
		if (next === tier) return;
		tier = next;
		// Clear stale selection — the picked entity may have been gated out.
		selection = null;
		// replaceState does NOT fire 'hashchange', so drive the rebuild
		// directly here. Other tabs / manual hash edits go through onHashChange.
		history.replaceState(null, '', writeHash({ tier }));
		if (handle) stats = handle.applyTier(tier);
	}
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
	<div class="tier-picker" role="group" aria-label="Spoiler tier: maximum book to reveal">
		<span class="tier-label">Through book</span>
		{#each BOOKS as b}
			<button
				type="button"
				class:active={b === tier}
				aria-pressed={b === tier}
				onclick={() => selectTier(b)}
			>
				{b}
			</button>
		{/each}
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
	.tier-picker {
		position: absolute;
		top: 12px;
		right: 16px;
		display: flex;
		gap: 4px;
		align-items: center;
		padding: 6px 8px;
		background: rgba(0, 8, 24, 0.55);
		border: 1px solid rgba(111, 195, 255, 0.35);
		border-radius: 4px;
	}
	.tier-label {
		font-size: 0.7rem;
		opacity: 0.7;
		margin-right: 6px;
		letter-spacing: 0.02em;
	}
	.tier-picker button {
		background: transparent;
		color: #cfe4ff;
		border: 1px solid rgba(111, 195, 255, 0.35);
		border-radius: 3px;
		padding: 2px 8px;
		font-size: 0.8rem;
		cursor: pointer;
		font-family: inherit;
		min-width: 24px;
	}
	.tier-picker button:hover {
		border-color: rgba(111, 195, 255, 0.7);
		color: #fff;
	}
	.tier-picker button.active {
		background: rgba(111, 195, 255, 0.25);
		border-color: rgba(111, 195, 255, 0.9);
		color: #fff;
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
