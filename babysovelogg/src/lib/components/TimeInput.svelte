<script lang="ts">
	/** Custom time input — always 24h format (HH:MM), locale-independent. */
	interface Props {
		value: string; // "HH:MM"
		onchange?: (value: string) => void;
		'data-testid'?: string;
	}

	let { value = $bindable(), onchange, 'data-testid': testid }: Props = $props();

	function handleInput(e: Event) {
		const input = e.target as HTMLInputElement;
		let v = input.value.replace(/[^\d:]/g, '');

		// Auto-insert colon after 2 digits
		if (v.length === 2 && !v.includes(':')) {
			v = v + ':';
		}
		// Limit to 5 chars (HH:MM)
		if (v.length > 5) v = v.slice(0, 5);

		input.value = v;
	}

	function handleBlur(e: Event) {
		const input = e.target as HTMLInputElement;
		const v = input.value;

		// Parse and normalize
		const match = v.match(/^(\d{1,2}):?(\d{0,2})$/);
		if (match) {
			let h = Math.min(23, Math.max(0, parseInt(match[1]) || 0));
			let m = Math.min(59, Math.max(0, parseInt(match[2]) || 0));
			const formatted = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
			value = formatted;
			input.value = formatted;
			onchange?.(formatted);
		} else {
			// Reset to current value
			input.value = value;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			e.preventDefault();
			const [h, m] = value.split(':').map(Number);
			const d = new Date(2000, 0, 1, h, m);
			d.setMinutes(d.getMinutes() + (e.key === 'ArrowUp' ? 1 : -1));
			const formatted = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
			value = formatted;
			(e.target as HTMLInputElement).value = formatted;
			onchange?.(formatted);
		}
	}
</script>

<input
	type="text"
	inputmode="numeric"
	class="time-input"
	{value}
	placeholder="HH:MM"
	maxlength="5"
	oninput={handleInput}
	onblur={handleBlur}
	onkeydown={handleKeydown}
	data-testid={testid}
/>

<style>
	.time-input {
		font-variant-numeric: tabular-nums;
		text-align: center;
		width: 5.5em;
	}
</style>
