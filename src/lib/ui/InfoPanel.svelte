<script lang="ts">
	import type { Selection } from '$lib/three/picking';
	import { getOverlay } from '$lib/data/overlay';
	import { bobsAt, firstBookOf, travelCountsAt } from '$lib/data/derive';

	interface Props {
		selection: Selection | null;
		onClose: () => void;
		tier: number;
		yearMax: number | null;
	}
	let { selection, onClose, tier, yearMax }: Props = $props();

	const overlay = getOverlay();

	const view = $derived.by(() => {
		if (!selection) return null;
		if (selection.kind === 'system') {
			const bobs = bobsAt(overlay, selection.systemName, tier, yearMax);
			const counts = travelCountsAt(overlay, selection.systemName, tier, yearMax);
			return { kind: 'system' as const, name: selection.systemName, bobs, counts };
		}
		// Resolve by id, not name. data/bobs.json has display-name
		// collisions (Elmer/Elmer_v4, Loki/Loki_v4) so a click on a
		// Loki_v4 pip would otherwise show the primary Loki record.
		// bobByName is for edge rows that only carry the name string.
		const bob = overlay.bobById.get(selection.bobId);
		if (!bob) return null;
		return {
			kind: 'bob' as const,
			bob,
			parent: bob.parent_id ? overlay.bobById.get(bob.parent_id) : null,
			firstBook: firstBookOf(overlay, bob.name)
		};
	});
</script>

{#if view}
	<aside class="panel">
		<button class="close" onclick={onClose} aria-label="Close">×</button>
		{#if view.kind === 'system'}
			<h2>{view.name}</h2>
			<p class="sub">System</p>
			<dl>
				<dt>Bob residents</dt>
				<dd>{view.bobs.length}</dd>
				<dt>Travel arrivals</dt>
				<dd>{view.counts.arrivals}</dd>
				<dt>Travel departures</dt>
				<dd>{view.counts.departures}</dd>
			</dl>
			{#if view.bobs.length > 0}
				<h3>Bobs originating here</h3>
				<ul class="bob-list">
					{#each view.bobs.sort((a, b) => a.bob_number - b.bob_number) as bob (bob.id)}
						<li>
							<span class="gen gen-{Math.min(bob.generation, 6)}">G{bob.generation}</span>
							{bob.name}
						</li>
					{/each}
				</ul>
			{/if}
		{:else}
			<h2>{view.bob.name}</h2>
			<p class="sub">Bob #{view.bob.bob_number} · Generation {view.bob.generation}</p>
			<dl>
				<dt>Origin system</dt>
				<dd>{view.bob.origin_system ?? '—'}</dd>
				<dt>Parent</dt>
				<dd>{view.parent?.name ?? view.bob.parent_id ?? '—'}</dd>
				<dt>Online year</dt>
				<dd>{view.bob.online_year ?? view.bob.created_year ?? '—'}</dd>
				<dt>First appears in</dt>
				<dd>{view.firstBook ? `Book ${view.firstBook}` : '—'}</dd>
				{#if view.bob.destinations.length > 0}
					<dt>Destinations</dt>
					<dd>{view.bob.destinations.join(', ')}</dd>
				{/if}
			</dl>
		{/if}
	</aside>
{/if}

<style>
	.panel {
		position: absolute;
		top: 12px;
		right: 12px;
		width: 280px;
		max-height: calc(100vh - 24px);
		overflow-y: auto;
		background: rgba(8, 12, 24, 0.92);
		border: 1px solid rgba(111, 195, 255, 0.35);
		border-radius: 6px;
		padding: 12px 16px 16px 16px;
		color: #d8dde6;
		font-size: 0.85rem;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
	}
	.close {
		position: absolute;
		top: 6px;
		right: 8px;
		background: transparent;
		border: 0;
		color: #98a8c4;
		font-size: 1.4rem;
		line-height: 1;
		cursor: pointer;
		padding: 2px 6px;
	}
	.close:hover {
		color: #fff;
	}
	h2 {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		letter-spacing: 0.02em;
	}
	h3 {
		margin: 14px 0 6px 0;
		font-size: 0.78rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: #98a8c4;
		font-weight: 600;
	}
	.sub {
		margin: 2px 0 12px 0;
		font-size: 0.72rem;
		color: #98a8c4;
	}
	dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 4px 12px;
		margin: 0;
	}
	dt {
		color: #98a8c4;
		font-size: 0.72rem;
	}
	dd {
		margin: 0;
		font-size: 0.82rem;
	}
	.bob-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.bob-list li {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.gen {
		display: inline-block;
		min-width: 22px;
		text-align: center;
		font-size: 0.66rem;
		padding: 1px 4px;
		border-radius: 3px;
		font-weight: 600;
		background: rgba(255, 255, 255, 0.08);
	}
	.gen-1 {
		color: #ffe9a8;
	}
	.gen-2 {
		color: #ffc56c;
	}
	.gen-3 {
		color: #ff8c5c;
	}
	.gen-4 {
		color: #ff6680;
	}
	.gen-5 {
		color: #d970c5;
	}
	.gen-6 {
		color: #a97cff;
	}
</style>
