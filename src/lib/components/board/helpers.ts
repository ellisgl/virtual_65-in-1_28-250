export function voltageToColor(voltage: number | undefined): string {
	if (voltage === undefined || !Number.isFinite(voltage)) return '#d4a24f';
	const clamped = Math.max(-9, Math.min(9, voltage));
	const t = (clamped + 9) / 18;
	const hue = 220 - (220 - 10) * t;
	return `hsl(${hue} 80% 60%)`;
}

export function formatCapacitance(capacitanceFarads: number): string {
	if (capacitanceFarads >= 1e-6) return `${(capacitanceFarads * 1e6).toFixed(2)} µF`;
	if (capacitanceFarads >= 1e-9) return `${(capacitanceFarads * 1e9).toFixed(2)} nF`;
	return `${(capacitanceFarads * 1e12).toFixed(1)} pF`;
}

export function formatPotPosition(position: number): string {
	return `${(position * 100).toFixed(0)}%`;
}

