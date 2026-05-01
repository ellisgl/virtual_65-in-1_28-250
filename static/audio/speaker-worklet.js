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

// Target fill: ~23 ms at 44100 Hz — enough slack for setInterval jitter.
const TARGET_FILL = 1024;

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

		for (let i = 0; i < n; i++) {
			let s = this._readSample(rate);

			// Fade-in envelope.
			if (this._fadePos < this._fadeSamples) {
				s *= this._fadePos / this._fadeSamples;
				this._fadePos++;
			}

			ch0[i] = s;
			for (let c = 1; c < chCount; c++) out[c][i] = s;
		}

		// Backpressure report.
		if (++this._blockCount >= REPORT_EVERY) {
			this._blockCount = 0;
			this.port.postMessage({ type: 'bufferFill', available: this._avail, target: TARGET_FILL });
		}

		return true;
	}
}

registerProcessor('speaker-sample-processor', SpeakerSampleProcessor);
