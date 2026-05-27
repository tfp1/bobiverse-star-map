<script lang="ts">
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { mountScene, type SceneHandle, type SceneStats } from '$lib/three/Scene';
	import type { Selection } from '$lib/three/picking';
	import InfoPanel from '$lib/ui/InfoPanel.svelte';
	import { parseHash, writeHash, YEAR_MIN, YEAR_MAX, type ViewMode } from '$lib/url/hash';

	const DEFAULT_TIER = 1;
	const DEFAULT_MODE: ViewMode = 'explore';
	const DEFAULT_YEAR = YEAR_MIN;
	const BOOKS = [1, 2, 3, 4, 5] as const;
	const SPEEDS = [
		{ label: '0.5×', yps: 2.5 },
		{ label: '1×', yps: 5 },
		{ label: '2×', yps: 10 },
		{ label: '5×', yps: 25 }
	] as const;

	let container: HTMLDivElement;
	let error = $state<string | null>(null);
	let stats = $state<SceneStats | null>(null);
	let selection = $state<Selection | null>(null);
	let tier = $state<number>(DEFAULT_TIER);
	let mode = $state<ViewMode>(DEFAULT_MODE);
	let year = $state<number>(DEFAULT_YEAR);
	let playing = $state<boolean>(false);
	let speedIdx = $state<number>(1);
	let handle: SceneHandle | undefined;

	const yearMax = $derived(mode === 'timeline' ? year : null);

	onMount(() => {
		const initial = parseHash(window.location.hash, {
			tier: DEFAULT_TIER,
			mode: DEFAULT_MODE,
			year: DEFAULT_YEAR
		});
		tier = initial.tier;
		mode = initial.mode;
		year = initial.year;

		let cancelled = false;
		mountScene(container, {
			starsBinUrl: `${base}/stars-near.bin`,
			initialTier: tier,
			initialYearMax: mode === 'timeline' ? year : null,
			onSelect: (sel) => {
				selection = sel;
			}
		})
			.then((h) => {
				if (cancelled) {
					h.dispose();
					return;
				}
				handle = h;
				// `tier`/`mode`/`year` may have changed via hashchange while
				// the scene was still loading. Reconcile so the rendered
				// overlay matches the current selector state.
				stats = h.applyView({ tier, yearMax });
			})
			.catch((e: unknown) => {
				if (cancelled) return;
				error = e instanceof Error ? e.message : String(e);
				console.error(e);
			});

		const onHashChange = () => {
			const next = parseHash(window.location.hash, {
				tier: DEFAULT_TIER,
				mode: DEFAULT_MODE,
				year: DEFAULT_YEAR
			});
			let changed = false;
			if (next.tier !== tier) {
				tier = next.tier;
				changed = true;
			}
			if (next.mode !== mode) {
				mode = next.mode;
				changed = true;
			}
			if (next.year !== year) {
				year = next.year;
				changed = true;
			}
			if (changed) {
				selection = null;
				if (handle) stats = handle.applyView({ tier, yearMax });
			}
		};
		window.addEventListener('hashchange', onHashChange);

		// Playback loop: advance an internal float accumulator while
		// playing in Timeline mode, and only push the integer year to
		// state when it changes (so each scene rebuild advances by a
		// whole year). The accumulator resets to the current `year`
		// whenever the user scrubs manually — we detect that by
		// keeping `lastYear` in sync.
		let raf = 0;
		let lastTs = 0;
		let yearFloat = year;
		let lastYear = year;
		const loop = (ts: number) => {
			raf = requestAnimationFrame(loop);
			if (!playing || mode !== 'timeline') {
				lastTs = ts;
				if (year !== lastYear) {
					yearFloat = year;
					lastYear = year;
				}
				return;
			}
			if (year !== lastYear) {
				yearFloat = year;
				lastYear = year;
			}
			if (!lastTs) lastTs = ts;
			const dt = (ts - lastTs) / 1000;
			lastTs = ts;
			yearFloat += SPEEDS[speedIdx].yps * dt;
			if (yearFloat >= YEAR_MAX) {
				yearFloat = YEAR_MAX;
				year = YEAR_MAX;
				lastYear = year;
				playing = false;
				persist();
				return;
			}
			const rounded = Math.floor(yearFloat);
			if (rounded !== year) {
				year = rounded;
				lastYear = year;
				persist();
			}
		};
		raf = requestAnimationFrame(loop);

		return () => {
			cancelled = true;
			cancelAnimationFrame(raf);
			window.removeEventListener('hashchange', onHashChange);
			handle?.dispose();
			handle = undefined;
		};
	});

	function persist() {
		history.replaceState(null, '', writeHash({ tier, mode, year }));
		if (handle) stats = handle.applyView({ tier, yearMax });
	}

	function selectTier(next: number) {
		if (next === tier) return;
		tier = next;
		selection = null;
		persist();
	}

	function selectMode(next: ViewMode) {
		if (next === mode) return;
		mode = next;
		if (mode === 'explore') playing = false;
		selection = null;
		persist();
	}

	function onScrub(e: Event) {
		const target = e.target as HTMLInputElement;
		const n = Number(target.value);
		if (!Number.isFinite(n)) return;
		year = Math.max(YEAR_MIN, Math.min(YEAR_MAX, Math.round(n)));
		persist();
	}

	function togglePlay() {
		if (mode !== 'timeline') return;
		if (year >= YEAR_MAX) year = YEAR_MIN;
		playing = !playing;
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
				{stats.systems} systems{stats.megastructures > 0
					? ` · ${stats.megastructures} megastructures`
					: ''} · {stats.bobs} bobs ·
				<span class="rep">{stats.replicationEdges} replication</span> ·
				<span class="trv">{stats.travelEdges} travel</span> edges
			</p>
		{:else if !error}
			<p class="small">loading…</p>
		{/if}
	</div>
	<div class="top-right">
		<div class="picker mode-picker" role="group" aria-label="View mode">
			<button
				type="button"
				class:active={mode === 'explore'}
				aria-pressed={mode === 'explore'}
				onclick={() => selectMode('explore')}>Explore</button
			>
			<button
				type="button"
				class:active={mode === 'timeline'}
				aria-pressed={mode === 'timeline'}
				onclick={() => selectMode('timeline')}>Timeline</button
			>
		</div>
		<div class="picker tier-picker" role="group" aria-label="Spoiler tier: maximum book to reveal">
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
	</div>
	{#if mode === 'timeline'}
		<div class="scrubber" role="group" aria-label="Timeline scrubber">
			<button
				type="button"
				class="play"
				onclick={togglePlay}
				aria-pressed={playing}
				aria-label={playing ? 'Pause' : 'Play'}
			>
				{playing ? '❚❚' : '▶'}
			</button>
			<input
				type="range"
				min={YEAR_MIN}
				max={YEAR_MAX}
				step="1"
				value={year}
				oninput={onScrub}
				aria-label="Year"
			/>
			<span class="year">{year}</span>
			<div class="speeds" role="group" aria-label="Playback speed">
				{#each SPEEDS as s, i}
					<button
						type="button"
						class:active={i === speedIdx}
						aria-pressed={i === speedIdx}
						onclick={() => (speedIdx = i)}
					>
						{s.label}
					</button>
				{/each}
			</div>
		</div>
	{/if}
	<InfoPanel {selection} {tier} {yearMax} onClose={() => (selection = null)} />
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
	.top-right {
		position: absolute;
		top: 12px;
		right: 16px;
		display: flex;
		flex-direction: column;
		gap: 6px;
		align-items: flex-end;
	}
	.picker {
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
	.picker button {
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
	.picker button:hover {
		border-color: rgba(111, 195, 255, 0.7);
		color: #fff;
	}
	.picker button.active {
		background: rgba(111, 195, 255, 0.25);
		border-color: rgba(111, 195, 255, 0.9);
		color: #fff;
	}
	.scrubber {
		position: absolute;
		left: 50%;
		bottom: 16px;
		transform: translateX(-50%);
		display: flex;
		gap: 10px;
		align-items: center;
		padding: 8px 14px;
		background: rgba(0, 8, 24, 0.75);
		border: 1px solid rgba(111, 195, 255, 0.35);
		border-radius: 6px;
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
		width: min(520px, calc(100vw - 32px));
	}
	.scrubber input[type='range'] {
		flex: 1 1 auto;
		accent-color: #6fc3ff;
	}
	.scrubber .year {
		font-variant-numeric: tabular-nums;
		font-size: 0.9rem;
		min-width: 3.6em;
		text-align: right;
		color: #cfe4ff;
	}
	.scrubber .play {
		background: transparent;
		color: #cfe4ff;
		border: 1px solid rgba(111, 195, 255, 0.35);
		border-radius: 3px;
		padding: 2px 10px;
		font-size: 0.9rem;
		cursor: pointer;
		font-family: inherit;
		min-width: 36px;
	}
	.scrubber .play:hover {
		border-color: rgba(111, 195, 255, 0.7);
		color: #fff;
	}
	.scrubber .speeds {
		display: flex;
		gap: 2px;
	}
	.scrubber .speeds button {
		background: transparent;
		color: #cfe4ff;
		border: 1px solid rgba(111, 195, 255, 0.35);
		border-radius: 3px;
		padding: 1px 6px;
		font-size: 0.7rem;
		cursor: pointer;
		font-family: inherit;
	}
	.scrubber .speeds button:hover {
		border-color: rgba(111, 195, 255, 0.7);
		color: #fff;
	}
	.scrubber .speeds button.active {
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
	:global(.off-map-label) {
		color: #a8b8cc;
		border-color: rgba(112, 136, 168, 0.55);
		background: rgba(8, 14, 30, 0.65);
		font-style: italic;
	}
	:global(.sgr-a-label) {
		color: #f4c75a;
		border-color: rgba(244, 199, 90, 0.7);
	}
	:global(.megastructure-label) {
		color: #d8e8d0;
		border-color: rgba(109, 208, 160, 0.6);
		background: rgba(10, 24, 18, 0.7);
	}
</style>
