<script lang="ts">
	/** Custom date input — always DD.MM.YYYY format, locale-independent.
	 *  bind:value uses ISO format (YYYY-MM-DD) internally. */
	interface Props {
		value: string; // "YYYY-MM-DD"
		onchange?: (value: string) => void;
		'data-testid'?: string;
	}

	let { value = $bindable(), onchange, 'data-testid': testid }: Props = $props();

	/** Convert YYYY-MM-DD to DD.MM.YYYY for display. */
	function toDisplay(iso: string): string {
		const parts = iso.split('-');
		if (parts.length !== 3) return iso;
		return `${parts[2]}.${parts[1]}.${parts[0]}`;
	}

	/** Convert DD.MM.YYYY to YYYY-MM-DD for value. */
	function toIso(display: string): string | null {
		const match = display.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
		if (!match) return null;
		const d = parseInt(match[1], 10), m = parseInt(match[2], 10), y = parseInt(match[3], 10);
		if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2020 || y > 2099) return null;
		// Verify the day actually exists in that month (rejects 31.02, 31.04, etc.):
		// constructing the Date with an overflow day silently rolls into the next
		// month, so a round-trip check catches it.
		const dt = new Date(y, m - 1, d);
		if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
		return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
	}

	let displayValue = $state(toDisplay(value));

	// Sync display when value changes externally
	$effect(() => {
		const expected = toDisplay(value);
		if (displayValue !== expected) {
			displayValue = expected;
		}
	});

	function handleInput(e: Event) {
		const input = e.target as HTMLInputElement;
		let v = input.value.replace(/[^\d.]/g, '');

		// Auto-insert dots after day and month
		const digits = v.replace(/\./g, '');
		if (digits.length >= 2 && !v.includes('.')) {
			v = digits.slice(0, 2) + '.' + digits.slice(2);
		}
		if (digits.length >= 4 && v.split('.').length < 3) {
			const parts = v.split('.');
			if (parts.length === 2 && parts[1].length >= 2) {
				v = parts[0] + '.' + parts[1].slice(0, 2) + '.' + parts[1].slice(2);
			}
		}
		if (v.length > 10) v = v.slice(0, 10);

		displayValue = v;
		input.value = v;
	}

	function handleBlur() {
		const iso = toIso(displayValue);
		if (iso) {
			value = iso;
			displayValue = toDisplay(iso);
			onchange?.(iso);
		} else {
			// Reset to current value
			displayValue = toDisplay(value);
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			e.preventDefault();
			const d = new Date(value + 'T12:00:00');
			d.setDate(d.getDate() + (e.key === 'ArrowUp' ? 1 : -1));
			const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
			value = iso;
			displayValue = toDisplay(iso);
			onchange?.(iso);
		}
	}
</script>

<input
	type="text"
	inputmode="numeric"
	class="date-input"
	value={displayValue}
	placeholder="DD.MM.YYYY"
	maxlength="10"
	oninput={handleInput}
	onblur={handleBlur}
	onkeydown={handleKeydown}
	data-testid={testid}
/>

<style>
	.date-input {
		font-variant-numeric: tabular-nums;
		text-align: center;
		width: 8em;
	}
</style>
