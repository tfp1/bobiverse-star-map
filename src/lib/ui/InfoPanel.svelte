<script lang="ts">
	import type { Selection } from '$lib/three/picking';
	import { getOverlay } from '$lib/data/overlay';
	import {
		bobVisibleAt,
		bobsAt,
		firstBookOf,
		megastructuresVisibleAt,
		systemsVisibleAt,
		travelCountsAt
	} from '$lib/data/derive';

	interface Props {
		selection: Selection | null;
		onClose: () => void;
		onFocus?: (sel: Selection) => void;
		tier: number;
		yearMax: number | null;
	}
	let { selection, onClose, onFocus, tier, yearMax }: Props = $props();

	const overlay = getOverlay();

	const view = $derived.by(() => {
		if (!selection) return null;
		// Selection survives across tier / scrubber changes (so the user
		// can keep their place while exploring). When the selected entity
		// has been gated out of the rendered scene by the current
		// (tier, yearMax), close the panel — same panel/renderer parity
		// rule as the per-entity counts. The panel reopens automatically
		// if the user scrubs forward past the entity's visibility again,
		// because $derived re-evaluates and selection is still set.
		if (selection.kind === 'system') {
			const sys = overlay.resolveSystem(selection.systemName);
			if (!sys) return null;
			const visibleSystems = systemsVisibleAt(overlay, tier, yearMax);
			if (!visibleSystems.has(selection.systemName)) return null;
			const bobs = bobsAt(overlay, selection.systemName, tier, yearMax);
			const counts = travelCountsAt(overlay, selection.systemName, tier, yearMax);
			const kind = sys.kind ?? 'catalog_star';
			// Megastructures hosted at this catalog star (HR @ Eta Leporis etc.) —
			// surfaced as a related-node row per D9/D10. Must match the rendered
			// scene's visibility: a tier-1 click on Epsilon Eridani should NOT
			// leak Matryoshka Brain (B4/2225).
			const visibleMegas = megastructuresVisibleAt(overlay, tier, yearMax, visibleSystems);
			const hostedMegastructures = overlay.megastructures.filter(
				(m) => m.host === selection.systemName && visibleMegas.has(m.name)
			);
			return {
				kind: 'system' as const,
				name: selection.systemName,
				bobs,
				counts,
				systemKind: kind,
				hostedMegastructures
			};
		}
		if (selection.kind === 'megastructure') {
			const visibleMegas = megastructuresVisibleAt(overlay, tier, yearMax);
			if (!visibleMegas.has(selection.megastructureName)) return null;
			const m = overlay.megastructures.find((x) => x.name === selection.megastructureName);
			if (!m) return null;
			return { kind: 'megastructure' as const, m };
		}
		// Resolve by id, not name. data/bobs.json has display-name
		// collisions (Elmer/Elmer_v4, Loki/Loki_v4) so a click on a
		// Loki_v4 pip would otherwise show the primary Loki record.
		// bobByName is for edge rows that only carry the name string.
		const bob = overlay.bobById.get(selection.bobId);
		if (!bob) return null;
		if (!bobVisibleAt(overlay, bob, tier, yearMax)) return null;
		return {
			kind: 'bob' as const,
			bob,
			parent: bob.parent_id ? overlay.bobById.get(bob.parent_id) : null,
			firstBook: firstBookOf(overlay, bob.name)
		};
	});

	function systemSubtitle(kind: string): string {
		if (kind === 'off_map') return 'Off-map system';
		if (kind === 'sgr_a_star') return 'Sagittarius A* · galactic center';
		return 'System';
	}
	function megastructureSubtitle(subtype: 'topopolis' | 'dyson_variant'): string {
		return subtype === 'topopolis' ? 'Topopolis · Quinlan megastructure' : 'Dyson-variant brain';
	}
</script>

{#if view}
	<aside class="panel">
		<div class="panel-actions">
			{#if onFocus && selection}
				<button class="focus" onclick={() => selection && onFocus(selection)} aria-label="Focus camera on this object">
					Focus
				</button>
			{/if}
			<button class="close" onclick={onClose} aria-label="Close">×</button>
		</div>
		{#if view.kind === 'system'}
			<h2>{view.name}</h2>
			<p class="sub">{systemSubtitle(view.systemKind)}</p>
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
			{#if view.hostedMegastructures.length > 0}
				<h3>Megastructures at this system</h3>
				<ul class="sub-list">
					{#each view.hostedMegastructures as m (m.name)}
						<li>{m.name}</li>
					{/each}
				</ul>
			{/if}
		{:else if view.kind === 'megastructure'}
			<h2>{view.m.name}</h2>
			<p class="sub">{megastructureSubtitle(view.m.subtype)}</p>
			<dl>
				<dt>Host system</dt>
				<dd>{view.m.host}</dd>
				<dt>First appears in</dt>
				<dd>Book {view.m.first_book}</dd>
			</dl>
			{#if view.m.sub_locations.length > 0}
				<h3>Sub-locations</h3>
				<ul class="sub-list">
					{#each view.m.sub_locations as loc}
						<li>{loc}</li>
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
	.panel-actions {
		position: absolute;
		top: 6px;
		right: 8px;
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.focus {
		background: transparent;
		border: 1px solid rgba(111, 195, 255, 0.45);
		color: #cfe4ff;
		font-size: 0.72rem;
		line-height: 1;
		cursor: pointer;
		padding: 3px 8px;
		border-radius: 3px;
		font-family: inherit;
	}
	.focus:hover {
		border-color: rgba(111, 195, 255, 0.85);
		color: #fff;
	}
	.close {
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
	.sub-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
		font-size: 0.78rem;
		color: #cfe4ff;
	}
	.sub-list li {
		padding-left: 8px;
		border-left: 1px solid rgba(111, 195, 255, 0.35);
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
