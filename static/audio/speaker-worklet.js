/* global AudioWorkletProcessor, registerProcessor */
/// <reference lib="WebWorker" />
/// <reference lib="DOM" />

/**
 * SpeakerSampleProcessor — high-quality audio worklet for the virtual 65-in-1.
 *
 * Design goals:
 *  1. No GC in the process() hot path — fixed-size Float32Array ring buffer.
 *  2. Cubic Hermite interpolation for upsampled (non-audio-rate) sim paths.
 *  3. Jitter buffer with backpressure: worklet reports buffer fill so main
 *     thread can throttle/accelerate sample production.
 *  4. Glitch-free underrun: hold last sample instead of going silent.
 *  5. Smooth fade-in on first connect to avoid click.
 */

const BUFFER_SIZE = 32768; // power-of-2 → ~0.74 s at 44100 Hz
const BUFFER_MASK = BUFFER_SIZE - 1;

// Target fill: large enough to ride out a pulse-phase stall in the simulator.
// Each pulse can take ~100-200ms wall-time during which no samples arrive;
// at 44.1kHz that's ~5000-9000 samples that must already be in the buffer.
// 8192 samples ≈ 186ms — chosen as power-of-two for clean wraparound.
const TARGET_FILL = 8192;

// Report fill to main thread every N process() calls.
const REPORT_EVERY = 16;

function cubicHermite(p0, p1, p2, p3, t) {
	const t2 = t * t;
	const t3 = t2 * t;
	return (
		0.5 *
		(2 * p1 +
			(-p0 + p2) * t +
			(2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
			(-p0 + 3 * p1 - 3 * p2 + p3) * t3)
	);
}

/**
 * Biquad band-pass coefficients (RBJ cookbook, "constant skirt gain, peak gain = Q").
 * Models the speaker cone's acoustic transfer function: a small 8Ω paper-cone
 * speaker rings around 400 Hz with broad Q (~1.5), and acts as a mechanical
 * band-pass filter for the electrical drive signal. This is what gives a real
 * blocking-oscillator metronome its characteristic 'ping' tone instead of the
 * raw electrical waveform's high-frequency buzz.
 */
function makeBandpass(sampleRate, f0, Q) {
	const w0 = 2 * Math.PI * f0 / sampleRate;
	const cosw = Math.cos(w0);
	const sinw = Math.sin(w0);
	const alpha = sinw / (2 * Q);
	// "Skirt gain" form
	const b0 = sinw / 2;
	const b1 = 0;
	const b2 = -sinw / 2;
	const a0 = 1 + alpha;
	const a1 = -2 * cosw;
	const a2 = 1 - alpha;
	return {
		b0: b0 / a0, b1: b1 / a0, b2: b2 / a0,
		a1: a1 / a0, a2: a2 / a0,
	};
}

class SpeakerSampleProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this._buf = new Float32Array(BUFFER_SIZE);
		this._writeIdx = 0;
		this._readIdx = 0;
		this._readFrac = 0; // sub-sample fractional position [0, 1)
		this._lastSample = 0;
		this._blockCount = 0;
		// Fade-in on first buffer drain to prevent click.
		this._fadePos = 0;
		this._fadeSamples = 256; // ~6 ms at 44100 Hz

		// Speaker cone bandpass. Lowered to 250 Hz (Q=0.7) so the siren sweep
		// (≈170–600 Hz) and similar direct-drive circuits pass with useful gain.
		// Q=0.7 gives ~355 Hz -3dB bandwidth, covering 70 Hz–570 Hz.
		this._bp = makeBandpass(sampleRate, 250, 0.7);
		this._bpZ1 = 0;
		this._bpZ2 = 0;
		// Boost to compensate: lower Q means less peak gain, so raise _bpGain.
		this._bpGain = 1.2;

		this.port.onmessage = (event) => {
			if (!event.data) return;

			if (event.data.type === 'samples') {
				const values = event.data.values;
				if (!Array.isArray(values)) return;
				for (let i = 0; i < values.length; i++) {
					const v = +values[i];
					if (!isFinite(v)) continue;
					this._buf[this._writeIdx & BUFFER_MASK] = v < -1 ? -1 : v > 1 ? 1 : v;
					this._writeIdx = (this._writeIdx + 1) | 0;
					// Overwrite-protection: if full, advance read to drop oldest.
					if (((this._writeIdx - this._readIdx) & BUFFER_MASK) === 0) {
						this._readIdx = (this._readIdx + 1) | 0;
					}
				}
			}

			if (event.data.type === 'reset') {
				this._buf.fill(0);
				this._writeIdx = 0;
				this._readIdx = 0;
				this._readFrac = 0;
				this._lastSample = 0;
				this._fadePos = 0;
				this._bpZ1 = 0;
				this._bpZ2 = 0;
			}
		};
	}

	get _avail() {
		return (this._writeIdx - this._readIdx) & BUFFER_MASK;
	}

	_readSample(rate) {
		const avail = this._avail;
		if (avail === 0) return this._lastSample; // underrun concealment

		// Fast path: integer rate = 1, no fractional offset.
		if (this._readFrac === 0 && rate === 1.0) {
			const s = this._buf[this._readIdx & BUFFER_MASK];
			this._readIdx = (this._readIdx + 1) | 0;
			this._lastSample = s;
			return s;
		}

		// Cubic Hermite with clamped neighbourhood.
		const ri = this._readIdx & BUFFER_MASK;
		const p0 = this._buf[ri === 0 ? 0 : (ri - 1) & BUFFER_MASK];
		const p1 = this._buf[ri];
		const p2 = avail > 1 ? this._buf[(ri + 1) & BUFFER_MASK] : p1;
		const p3 = avail > 2 ? this._buf[(ri + 2) & BUFFER_MASK] : p2;

		const s = cubicHermite(p0, p1, p2, p3, this._readFrac);
		const clamped = s < -1 ? -1 : s > 1 ? 1 : s;

		this._readFrac += rate;
		const whole = this._readFrac | 0;
		if (whole > 0) {
			this._readIdx = (this._readIdx + whole) | 0;
			this._readFrac -= whole;
		}

		this._lastSample = clamped;
		return clamped;
	}

	process(_inputs, outputs) {
		const out = outputs[0];
		if (!out || out.length === 0) return true;
		const ch0 = out[0];
		const n = ch0.length;
		const chCount = out.length;

		const avail = this._avail;
		// Adaptive rate: nudge ±2% to hold TARGET_FILL in the buffer.
		const err = avail - TARGET_FILL;
		const rate = 1.0 + Math.max(-0.02, Math.min(0.02, err / (TARGET_FILL * 4)));

		const bp = this._bp;
		let z1 = this._bpZ1, z2 = this._bpZ2;
		const bpGain = this._bpGain;

		for (let i = 0; i < n; i++) {
			let s = this._readSample(rate);

			// Speaker cone bandpass (direct-form II transposed biquad).
			// y[n] = b0*x[n] + z1
			// z1   = b1*x[n] - a1*y[n] + z2
			// z2   = b2*x[n] - a2*y[n]
			const x = s;
			const y = bp.b0 * x + z1;
			z1 = bp.b1 * x - bp.a1 * y + z2;
			z2 = bp.b2 * x - bp.a2 * y;
			s = y * bpGain;

			// Soft-clip after the boost
			if (s >  1) s =  1;
			if (s < -1) s = -1;

			// Fade-in envelope.
			if (this._fadePos < this._fadeSamples) {
				s *= this._fadePos / this._fadeSamples;
				this._fadePos++;
			}

			ch0[i] = s;
			for (let c = 1; c < chCount; c++) out[c][i] = s;
		}
		this._bpZ1 = z1;
		this._bpZ2 = z2;

		// Backpressure report.
		if (++this._blockCount >= REPORT_EVERY) {
			this._blockCount = 0;
			this.port.postMessage({ type: 'bufferFill', available: this._avail, target: TARGET_FILL });
		}

		return true;
	}
}

registerProcessor('speaker-sample-processor', SpeakerSampleProcessor);
