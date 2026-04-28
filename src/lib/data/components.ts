import type { DeviceModel, KitComponent } from '$lib/types';

const model2SB56: DeviceModel = {
	name: '2SB56',
	type: 'bjt',
	params: {
		polarity: 'pnp',
		is: 1e-6,
		ikf: 10,
		ise: 5e-7,
		ne: 1.5,
		ikr: 20,
		isc: 2e-7,
		nc: 1.5,
		nf: 1,
		nr: 1,
		vaf: 0.04,
		var: 0.05,
		br: 5,
		bf: 100
	}
};

// I think the JS711-11 is a 2SC711 in a different package.
// Which the modern equivalent is the 2N3707
// I found enough specs to create a spice model
const modelJS711: DeviceModel = {
	name: 'S711',
	type: 'bjt',
	params: {
		polarity: 'npn',
		is: 1.35e-14,
		ikf: 0.05,
		ise: 1.2e-14,
		ne: 1.5,
		ikr: 0.01,
		isc: 1.0e-12,
		nc: 2,
		nf: 1,
		nr: 1,
		vaf: 100,
		var: 0.05,
		br: 5,
		bf: 300,
		rb: 20,
		re: 1,
		rc: 5,
		cje: 5.0e-12,
		vje: 0.75,
		mje: 0.33,
		cjc: 2.5e-12,
		vjc: 0.75,
		mjc: 0.33,
		tf: 1.06e-9,
		xtf: 10,
		vtf: 10,
		itf: 0.05,
		tr: 10e-9,
		eg: 1.11,
		xti: 3,
		fc: 0.5
	}
};

// * C103Y SCR Subcircuit (30V, 0.8A)
// * Terminals: Anode Gate Cathode
// .SUBCKT C103Y 1 2 3
//     QP 4 1 2 QPNP
//     QN 2 4 3 QNPN
//     .MODEL QPNP PNP (IS=1e-14 BF=5 CJE=20p VAF=30)
//     .MODEL QNPN NPN (IS=1e-14 BF=100 CJE=20p VAF=30)
//     RGK 2 3 1k
// .ENDS
const modelC103Y: DeviceModel = {
	name: 'C103Y',
	type: 'scr',
	params: {
		// Keep existing simplified SCR controls used by the app.
		triggerTime: 75e-6,
		holdTime: 75e-6,
		gateResistance: 1000,
		// Derived from the provided C103Y subcircuit.
		maxVoltage: 30,
		maxCurrent: 0.8,
		qpnpIs: 1e-14,
		qpnpBf: 5,
		qpnpCje: 20e-12,
		qpnpVaf: 30,
		qnpnIs: 1e-14,
		qnpnBf: 100,
		qnpnCje: 20e-12,
		qnpnVaf: 30
	}
};

const model1N34A: DeviceModel = {
	name: '1N34A',
	type: 'diode',
	params: {
		is: 2.14e-6,
		rs: 0.1,
		n: 1.3,
		bv: 65
	}
};

const model1N5233: DeviceModel = {
	name: '1N5233',
	type: 'diode',
	params: {
		is: 5e-9,
		rs: 7,
		n: 2,
		bv: 6.2
	}
};

const resistors: KitComponent[] = [
	{ id: 'R1', kind: 'resistor', name: '100 ohm', terminals: [1, 2], value: 100, unit: 'ohm' },
	{ id: 'R2', kind: 'resistor', name: '470 ohm', terminals: [3, 4], value: 470, unit: 'ohm' },
	{ id: 'R3', kind: 'resistor', name: '1 kohm', terminals: [5, 6], value: 1000, unit: 'ohm' },
	{ id: 'R4', kind: 'resistor', name: '2.2 kohm', terminals: [7, 8], value: 2200, unit: 'ohm' },
	{ id: 'R5', kind: 'resistor', name: '4.7 kohm', terminals: [9, 10], value: 4700, unit: 'ohm' },
	{ id: 'R6', kind: 'resistor', name: '10 kohm', terminals: [11, 12], value: 10000, unit: 'ohm' },
	{ id: 'R7', kind: 'resistor', name: '22 kohm', terminals: [13, 14], value: 22000, unit: 'ohm' },
	{ id: 'R8', kind: 'resistor', name: '47 kohm', terminals: [15, 16], value: 47000, unit: 'ohm' },
	{ id: 'R9', kind: 'resistor', name: '100 kohm', terminals: [17, 18], value: 100000, unit: 'ohm' },
	{ id: 'R10', kind: 'resistor', name: '220 kohm', terminals: [19, 20], value: 220000, unit: 'ohm' }
];

const capacitors: KitComponent[] = [
	{ id: 'C1', kind: 'capacitor', name: '100 pF', terminals: [24, 25], value: 100e-12, unit: 'F' },
	{ id: 'C2', kind: 'capacitor', name: '0.02 uF', terminals: [26, 27], value: 20e-9, unit: 'F' },
	{ id: 'C3', kind: 'capacitor', name: '0.05 uF', terminals: [28, 29], value: 50e-9, unit: 'F' },
	{ id: 'C4', kind: 'capacitor', name: '0.1 uF', terminals: [30, 31], value: 100e-9, unit: 'F' },
	{
		id: 'C5',
		kind: 'capacitor',
		name: '3.3 uF electrolytic',
		terminals: [32, 33],
		value: 3.3e-6,
		unit: 'F',
		metadata: { polarized: true }
	},
	{
		id: 'C6',
		kind: 'capacitor',
		name: '10 uF electrolytic',
		terminals: [34, 35],
		value: 10e-6,
		unit: 'F',
		metadata: { polarized: true }
	},
	{
		id: 'C7',
		kind: 'capacitor',
		name: '230 uF electrolytic',
		terminals: [36, 37],
		value: 230e-6,
		unit: 'F',
		metadata: { polarized: true }
	},
	{
		id: 'VC1',
		kind: 'variable-capacitor',
		name: 'variable capacitor',
		terminals: [38, 39],
		value: 265e-12,
		unit: 'F',
		metadata: { min: 1e-12, max: 265e-12, default: 265e-12 }
	}
];

const activeDevices: KitComponent[] = [
	{
		id: 'Q1',
		kind: 'transistor',
		name: '2SB56 PNP (Ge)',
		terminals: [46, 47, 48],
		model: model2SB56,
		metadata: { base: 46, collector: 47, emitter: 48 }
	},
	{
		id: 'Q2',
		kind: 'transistor',
		name: '2SB56 PNP (Ge)',
		terminals: [49, 50, 51],
		model: model2SB56,
		metadata: { base: 49, collector: 50, emitter: 51 }
	},
	{
		id: 'Q3',
		kind: 'transistor',
		name: 'JS71 -11 NPN transistor (Si)',
		terminals: [52, 53, 54],
		model: modelJS711,
		metadata: { base: 52, collector: 53, emitter: 54 }
	},
	{
		id: 'SCR1',
		kind: 'scr',
		name: 'C103Y SCR',
		terminals: [55, 56, 57],
		model: modelC103Y,
		metadata: { gate: 55, anode: 56, cathode: 57 }
	},
	{ id: 'D1', kind: 'diode', name: '1N34A diode', terminals: [58, 59], model: model1N34A },
	{ id: 'D2', kind: 'diode', name: '1N34A diode', terminals: [60, 61], model: model1N34A },
	{
		id: 'DZ1',
		kind: 'zener-diode',
		name: '1N5233 zener',
		terminals: [62, 63],
		model: model1N5233
	}
];

/*
* LT700 Audio Output Transformer
* Terminals: 1=Primary Start, 2=Center Tap, 3=Primary End
*            4=Secondary Start, 5=Secondary End
.SUBCKT LT700 1 2 3 4 5
    * Primary: Total Inductance approx 1.6H (based on 100Hz response)
    * Split into two 0.4H coils for the center tap
    LP1 1 2 0.4 RDC=45
    LP2 2 3 0.4 RDC=45

    * Secondary: 20:1 ratio means 1/400th the inductance
    LS1 4 5 0.004 RDC=0.4

    * Coupling coefficient (High quality but accounts for some leakage)
    K1 LP1 LP2 LS1 0.995
.ENDS
 */
const electroMechanical: KitComponent[] = [
	{
		id: 'RL1',
		kind: 'relay',
		name: 'relay',
		terminals: [75, 76, 77, 78, 79],
		metadata: {
			coilPositive: 75,
			coilNegative: 78,
			common: 77,
			normallyClosed: 76,
			normallyOpen: 79
		},
		model: {
			name: 'relay-default',
			type: 'relay',
			params: {
				inductance: 1.12,
				coilResistanceOhms: 150,
				ron: 0.05,
				roff: 1_000_000,
				onCurrent: 0.02,
				offCurrent: 0.015
			}
		}
	},
	{
		id: 'LAMP1',
		kind: 'lamp',
		name: '3.5V 200mA MES bulb',
		terminals: [68, 69],
		model: {
			name: 'lamp-default',
			type: 'lamp',
			params: { tempC: 300, nominalVoltage: 3.5, nominalCurrent: 0.2, nominalPower: 0.7 }
		}
	},
	{ id: 'SPK1', kind: 'speaker', name: '8 ohm speaker', terminals: [90, 91], value: 8, unit: 'ohm' }
];

const magneticParts: KitComponent[] = [
	{
		id: 'L1',
		kind: 'inductor',
		name: 'antenna coil (4 tap)',
		terminals: [40, 41, 42, 43],
		metadata: { segmentInductance: 110e-6 }
	},
	{
		id: 'T1',
		kind: 'transformer',
		name: 'LT700 audio output transformer',
		terminals: [70, 71, 72, 73, 74],
		metadata: {
			// LT700 terminal order: 1=primary start, 2=center tap, 3=primary end, 4=secondary start, 5=secondary end.
			primaryStart: 70,
			primaryCenterTap: 71,
			primaryEnd: 72,
			secondaryStart: 73,
			secondaryEnd: 74,
			// .SUBCKT LT700 winding values.
			lp1H: 0.4,
			lp2H: 0.4,
			lsH: 0.004,
			rp1Ohm: 45,
			rp2Ohm: 45,
			rsOhm: 0.4,
			coupling: 0.995,
			// Compatibility aliases for existing transformer consumers.
			ratioParameter: 0.05,
			turnsRatioApprox: 20
		}
	}
];

const controlsAndSources: KitComponent[] = [
	{
		id: 'VR1',
		kind: 'potentiometer',
		name: '50 kohm variable resistor',
		terminals: [21, 22, 23],
		value: 50000,
		unit: 'ohm',
		metadata: { wiper: 22, endA: 21, endB: 23, defaultPosition: 0.5, rheostatExponent: 5 }
	},
	{
		id: 'BAT9',
		kind: 'battery',
		name: '9V battery',
		terminals: [86, 87],
		value: 9,
		unit: 'V',
		metadata: { positive: 86, negative: 87 }
	},
	{
		id: 'BAT3',
		kind: 'battery',
		name: '3V battery',
		terminals: [88, 89],
		value: 3,
		unit: 'V',
		metadata: { positive: 88, negative: 89 }
	},
	{
		id: 'ANT1',
		kind: 'antenna',
		name: 'antenna / ground input',
		terminals: [44, 45],
		metadata: { antenna: 44, ground: 45 }
	}
];

export const KIT_COMPONENTS: KitComponent[] = [
	...resistors,
	...capacitors,
	...controlsAndSources,
	...magneticParts,
	...activeDevices,
	...electroMechanical
];

export const KIT_TERMINAL_IDS = Array.from(
	new Set(KIT_COMPONENTS.flatMap((component) => component.terminals))
).sort((a, b) => a - b);

export const UNMAPPED_TERMINAL_GAPS = [64, 65, 66, 67, 80, 81, 82, 83, 84, 85];
