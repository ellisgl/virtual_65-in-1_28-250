/* global AudioWorkletProcessor, registerProcessor */
/// <reference lib="WebWorker" />
/// <reference lib="DOM" />
class SpeakerSampleProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.currentSample = 0;
		this.port.onmessage = (event) => {
			if (!event.data || event.data.type !== 'sample') return;
			const value = Number(event.data.value);
			if (Number.isFinite(value)) {
				this.currentSample = Math.max(-1, Math.min(1, value));
			}
		};
	}

	process(inputs, outputs) {
		const output = outputs[0];
		for (let channel = 0; channel < output.length; channel += 1) {
			output[channel].fill(this.currentSample);
		}
		return true;
	}
}

registerProcessor('speaker-sample-processor', SpeakerSampleProcessor);

