/**
 * relay-click.ts — synthesized mechanical relay click.
 *
 * Real relays make two distinct sounds: a sharp snap when the coil pulls the
 * armature in, and a slightly duller clack when the spring drops it out.
 * Rather than shipping audio assets, both are synthesized once per
 * AudioContext into cached AudioBuffers:
 *
 *   click  =  noise burst        (the contact snap; fast exponential decay)
 *           + damped sine        (the armature/frame body resonance)
 *           + bounce  (pull-in only: a weaker echo of the snap ~8 ms later —
 *                      real contacts physically bounce on closure)
 *
 * Pull-in is brighter and louder (1.9 kHz body, full level); drop-out is
 * duller and softer (1.25 kHz body, ~60% level).
 *
 * `playRelayClick` is rate-limited (one click per 70 ms per context) so
 * relay-oscillator circuits — which can switch faster than the UI snapshot
 * rate can even observe — produce an occasional tick instead of a machine-gun
 * burst.  The *audible* buzz of such circuits should come from the simulated
 * audio path itself, not from UI clicks.
 */

interface ClickBuffers {
	pullIn: AudioBuffer;
	dropOut: AudioBuffer;
}

const bufferCache = new WeakMap<AudioContext, ClickBuffers>();
const lastClickAt = new WeakMap<AudioContext, number>();

const MIN_CLICK_INTERVAL_MS = 70;

function synthesizeClick(
	ctx: AudioContext,
	opts: { bodyHz: number; snapTau: number; bodyTau: number; bounce: boolean }
): AudioBuffer {
	const sr = ctx.sampleRate;
	const durSec = 0.03;
	const n = Math.floor(sr * durSec);
	const buf = ctx.createBuffer(1, n, sr);
	const data = buf.getChannelData(0);

	const bounceDelay = Math.floor(0.008 * sr);
	let peak = 0;
	for (let i = 0; i < n; i++) {
		const t = i / sr;
		// Contact snap: white noise with a fast exponential decay.
		const snap = (Math.random() * 2 - 1) * Math.exp(-t / opts.snapTau);
		// Body resonance: damped sine (armature hitting the core/frame).
		const body = 0.6 * Math.sin(2 * Math.PI * opts.bodyHz * t) * Math.exp(-t / opts.bodyTau);
		let s = snap + body;
		// Contact bounce: a weaker copy of the snap shortly after closure.
		if (opts.bounce && i >= bounceDelay) {
			const tb = (i - bounceDelay) / sr;
			s += 0.35 * (Math.random() * 2 - 1) * Math.exp(-tb / (opts.snapTau * 0.7));
		}
		data[i] = s;
		const a = Math.abs(s);
		if (a > peak) peak = a;
	}
	// Normalize so the level is set purely by the GainNode in playRelayClick.
	if (peak > 0) {
		for (let i = 0; i < n; i++) data[i] = (data[i] / peak) * 0.9;
	}
	return buf;
}

function getBuffers(ctx: AudioContext): ClickBuffers {
	let buffers = bufferCache.get(ctx);
	if (!buffers) {
		buffers = {
			pullIn: synthesizeClick(ctx, { bodyHz: 1900, snapTau: 0.002, bodyTau: 0.006, bounce: true }),
			dropOut: synthesizeClick(ctx, { bodyHz: 1250, snapTau: 0.0025, bodyTau: 0.007, bounce: false })
		};
		bufferCache.set(ctx, buffers);
	}
	return buffers;
}

/**
 * Play the relay click for an energize (`true`) or de-energize (`false`)
 * transition.  Connects directly to `ctx.destination`, bypassing the sim's
 * master gain / filters — the click is UI feedback, not part of the
 * simulated circuit audio.  Silently does nothing if the context isn't
 * running or a click played within the last 70 ms.
 */
export function playRelayClick(ctx: AudioContext, energized: boolean): void {
	if (ctx.state !== 'running') return;

	const now = performance.now();
	const last = lastClickAt.get(ctx) ?? -Infinity;
	if (now - last < MIN_CLICK_INTERVAL_MS) return;
	lastClickAt.set(ctx, now);

	const buffers = getBuffers(ctx);
	const source = ctx.createBufferSource();
	source.buffer = energized ? buffers.pullIn : buffers.dropOut;

	const gain = ctx.createGain();
	gain.gain.value = energized ? 0.3 : 0.18;

	source.connect(gain);
	gain.connect(ctx.destination);
	source.start();
	// One-shot cleanup: disconnect once playback ends so nodes can be GC'd.
	source.onended = () => {
		source.disconnect();
		gain.disconnect();
	};
}
