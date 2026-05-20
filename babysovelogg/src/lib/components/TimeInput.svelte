<script lang="ts">
	/** Custom time input — always 24h format (HH:MM), locale-independent.
	 *  Selects all on focus for easy replacement. Parses shortcuts:
	 *  "9" → "09:00", "930" → "09:30", "1830" → "18:30", "18" → "18:00" */
	interface Props {
		value: string; // "HH:MM"
		onchange?: (value: string) => void;
		'data-testid'?: string;
	}

	let { value = $bindable(), onchange, 'data-testid': testid }: Props = $props();

	/** Parse a flexible time string into HH:MM format, or null if invalid. */
	function parseTime(raw: string): string | null {
		const v = raw.replace(/[^\d:]/g, '').trim();
		if (!v) return null;

		// Already HH:MM format
		const colonMatch = v.match(/^(\d{1,2}):(\d{1,2})$/);
		if (colonMatch) {
			const h = parseInt(colonMatch[1], 10);
			const m = parseInt(colonMatch[2], 10);
			// Reject out-of-range input outright — silently clamping "99:99" to
			// "23:59" lets a typo land as a perfectly plausible time.
			if (h > 23 || m > 59) return null;
			return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
		}

		// Pure digits — interpret by length
		const digits = v.replace(/:/g, '');
		if (digits.length === 1) {
			// "9" → "09:00"
			return `0${digits}:00`;
		}
		if (digits.length === 2) {
			const h = parseInt(digits);
			// "18" → "18:00", "09" → "09:00"
			if (h <= 23) return `${String(h).padStart(2, '0')}:00`;
			// "93" → "09:30"? No — ambiguous. Treat as HH.
			return null;
		}
		if (digits.length === 3) {
			// "930" → "09:30"
			const h = parseInt(digits[0]);
			const m = parseInt(digits.slice(1));
			if (h <= 9 && m <= 59) return `0${h}:${String(m).padStart(2, '0')}`;
			return null;
		}
		if (digits.length === 4) {
			// "1830" → "18:30", "0930" → "09:30"
			const h = parseInt(digits.slice(0, 2));
			const m = parseInt(digits.slice(2));
			if (h <= 23 && m <= 59) {
				return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
			}
			return null;
		}

		return null;
	}

	function handleFocus(e: FocusEvent) {
		const input = e.target as HTMLInputElement;
		// Select all text on focus so user can just type a new time
		requestAnimationFrame(() => input.select());
	}

	function handleInput(e: Event) {
		const input = e.target as HTMLInputElement;
		let v = input.value.replace(/[^\d:]/g, '');

		// Auto-insert colon after 2 digits if user is typing fresh
		if (v.length === 2 && !v.includes(':')) {
			v = v + ':';
		}
		if (v.length > 5) v = v.slice(0, 5);

		input.value = v;
	}

	function handleBlur(e: Event) {
		const input = e.target as HTMLInputElement;
		const parsed = parseTime(input.value);
		if (parsed) {
			value = parsed;
			input.value = parsed;
			onchange?.(parsed);
		} else {
			// Reset to current value
			input.value = value;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			(e.target as HTMLInputElement).blur();
			e.preventDefault();
			return;
		}
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
	onfocus={handleFocus}
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
