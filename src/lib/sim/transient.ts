import {solveLinearSystem} from '$lib/sim/linear';
import {computeTransistorStamp} from '$lib/sim/transistor';
import type {
    CompiledNetlist,
    SimulationElement,
    SimulationInductorElement,
    SimulationNetlist,
    SimulationTransformerElement,
    SimulationTransistorElement,
    SimulationVoltageSourceElement,
    TransientConfig,
    TransientResult,
    TransientState
} from '$lib/types';

export function initializeTransientState(
    netlist: SimulationNetlist,
    initialNodeVoltages?: Record<number, number>
): TransientState {
    const capacitorVoltages: Record<string, number> = {};
    // Inductor companion state: we track the voltage across the inductor
    // (stored in capacitorVoltages under a ':v' key) so we can compute the
    // companion current source each step.  Initial voltage = 0 (no stored energy).
    const relayStates: Record<string, boolean> = {};

    // Detect transistor nodes whose DC voltage is unreliable due to a floating base.
    // A base is "floating" if no resistor or voltage source connects to it —
    // only gmin (1nS) ties it to ground, giving a bogus ~0 V that massively
    // forward-biases the junction and corrupts the collector node voltage.
    // Skip DC pre-charge for caps that touch such nodes; use 0 V instead.
    const unreliableDcNodes = new Set<number>();
    if (initialNodeVoltages) {
        const dcBiasedNodes = new Set<number>();
        for (const el of netlist.elements) {
            if (el.type === 'resistor' || el.type === 'voltage-source') {
                const nodes = el.type === 'resistor' ? el.nodes : [el.positiveNode, el.negativeNode];
                for (const n of nodes) dcBiasedNodes.add(n);
            }
        }
        for (const el of netlist.elements) {
            if (el.type !== 'transistor') continue;
            if (!dcBiasedNodes.has(el.baseNode)) {
                // Base has no resistive/source DC path — gmin is the only tie to ground.
                unreliableDcNodes.add(el.baseNode);
                unreliableDcNodes.add(el.collectorNode);
            }
        }
    }

    for (const element of netlist.elements) {
        if (element.type !== 'capacitor') {
            continue;
        }
        const nodeUnreliable = unreliableDcNodes.has(element.nodes[0]) || unreliableDcNodes.has(element.nodes[1]);
        // Pre-charge to DC steady-state to avoid initial click transient,
        // but only when the DC solution is trustworthy for these nodes.
        if (element.initialVoltage !== 0) {
            capacitorVoltages[element.componentId] = element.initialVoltage;
        } else if (initialNodeVoltages && !nodeUnreliable) {
            const v0 = initialNodeVoltages[element.nodes[0]] ?? 0;
            const v1 = initialNodeVoltages[element.nodes[1]] ?? 0;
            capacitorVoltages[element.componentId] = v0 - v1;
        } else {
            capacitorVoltages[element.componentId] = 0;
        }
    }

    for (const element of netlist.elements) {
        if (element.type === 'inductor') {
            capacitorVoltages[element.componentId] = 0; // initial voltage across inductor = 0
        }
    }

    for (const element of netlist.elements) {
        if (element.type !== 'transistor') {
            continue;
        }

        const baseUnreliable = unreliableDcNodes.has(element.baseNode);
        const collectorUnreliable = unreliableDcNodes.has(element.collectorNode);

        if (element.cjeFarads > 0 || (element.tfSeconds ?? 0) > 0) {
            const unreliable = baseUnreliable || unreliableDcNodes.has(element.emitterNode);
            const vb = (!unreliable && initialNodeVoltages) ? (initialNodeVoltages[element.baseNode] ?? 0) : 0;
            const ve = (!unreliable && initialNodeVoltages) ? (initialNodeVoltages[element.emitterNode] ?? 0) : 0;
            capacitorVoltages[`${element.componentId}:be`] = vb - ve;
        }

        if (element.cjcFarads > 0 || (element.trSeconds ?? 0) > 0) {
            const unreliable = baseUnreliable || collectorUnreliable;
            const vb = (!unreliable && initialNodeVoltages) ? (initialNodeVoltages[element.baseNode] ?? 0) : 0;
            const vc = (!unreliable && initialNodeVoltages) ? (initialNodeVoltages[element.collectorNode] ?? 0) : 0;
            capacitorVoltages[`${element.componentId}:bc`] = vb - vc;
        }
    }

    for (const element of netlist.elements) {
        if (element.type !== 'relay') {
            continue;
        }

        relayStates[element.componentId] = false;
    }

    return {time: 0, capacitorVoltages, nodeVoltages: initialNodeVoltages ?? {}, relayStates};
}


/** Build a reusable CompiledNetlist from a static SimulationNetlist.
 *  Call once when the netlist changes; pass the result to every stepTransientNetlist() call.
 */
export function compileNetlist(netlist: SimulationNetlist): CompiledNetlist | null {
    if (netlist.groundNodeId === null || netlist.elements.length === 0) return null;

    // --- usedNodes ---
    const usedNodes = new Set<number>([netlist.groundNodeId]);
    for (const element of netlist.elements) {
        if (element.type === 'coupling') continue; // meta-element, no nodes
        if (element.type === 'resistor' || element.type === 'capacitor' || element.type === 'inductor') {
            usedNodes.add(element.nodes[0]); usedNodes.add(element.nodes[1]);
        } else if (element.type === 'voltage-source') {
            usedNodes.add(element.positiveNode); usedNodes.add(element.negativeNode);
        } else if (element.type === 'transistor') {
            usedNodes.add(element.baseNode); usedNodes.add(element.collectorNode); usedNodes.add(element.emitterNode);
        } else if (element.type === 'transformer') {
            usedNodes.add(element.primaryNodeA); usedNodes.add(element.primaryNodeB);
            usedNodes.add(element.secondaryNodeA); usedNodes.add(element.secondaryNodeB);
        } else {
            const r = element as {coilPositiveNode:number;coilNegativeNode:number;commonNode:number;normallyClosedNode:number;normallyOpenNode:number};
            usedNodes.add(r.coilPositiveNode); usedNodes.add(r.coilNegativeNode);
            usedNodes.add(r.commonNode); usedNodes.add(r.normallyClosedNode); usedNodes.add(r.normallyOpenNode);
        }
    }

    // --- adjacency + groundedNodes (BFS) ---
    const adj = new Map<number, number[]>();
    const link = (a: number, b: number) => { const s = adj.get(a) ?? []; s.push(b); adj.set(a, s); };
    for (const element of netlist.elements) {
        if (element.type === 'coupling') continue;
        if (element.type === 'resistor' || element.type === 'capacitor' || element.type === 'inductor') {
            link(element.nodes[0], element.nodes[1]); link(element.nodes[1], element.nodes[0]);
        } else if (element.type === 'voltage-source') {
            link(element.positiveNode, element.negativeNode); link(element.negativeNode, element.positiveNode);
        } else if (element.type === 'transistor') {
            link(element.baseNode, element.emitterNode); link(element.emitterNode, element.baseNode);
            link(element.collectorNode, element.emitterNode); link(element.emitterNode, element.collectorNode);
        } else if (element.type === 'transformer') {
            link(element.primaryNodeA, element.primaryNodeB); link(element.primaryNodeB, element.primaryNodeA);
            link(element.secondaryNodeA, element.secondaryNodeB); link(element.secondaryNodeB, element.secondaryNodeA);
            link(element.primaryNodeA, element.secondaryNodeA); link(element.secondaryNodeA, element.primaryNodeA);
            link(element.primaryNodeB, element.secondaryNodeB); link(element.secondaryNodeB, element.primaryNodeB);
        } else {
            const r = element as {coilPositiveNode:number;coilNegativeNode:number;commonNode:number;normallyClosedNode:number;normallyOpenNode:number};
            link(r.coilPositiveNode, r.coilNegativeNode); link(r.coilNegativeNode, r.coilPositiveNode);
            link(r.commonNode, r.normallyClosedNode); link(r.normallyClosedNode, r.commonNode);
            link(r.commonNode, r.normallyOpenNode); link(r.normallyOpenNode, r.commonNode);
        }
    }

    const groundedNodes = new Set<number>();
    const queue: number[] = [netlist.groundNodeId];
    while (queue.length > 0) {
        const node = queue.pop()!;
        if (groundedNodes.has(node)) continue;
        groundedNodes.add(node);
        for (const nb of adj.get(node) ?? []) if (!groundedNodes.has(nb)) queue.push(nb);
    }

    const groundedElements = netlist.elements.filter((el): el is SimulationElement => {
        if (el.type === 'coupling') return true; // always include — meta-element
        if (el.type === 'resistor' || el.type === 'capacitor' || el.type === 'inductor')
            return groundedNodes.has(el.nodes[0]) && groundedNodes.has(el.nodes[1]);
        if (el.type === 'voltage-source')
            return groundedNodes.has(el.positiveNode) && groundedNodes.has(el.negativeNode);
        if (el.type === 'transistor')
            return groundedNodes.has(el.baseNode) && groundedNodes.has(el.collectorNode) && groundedNodes.has(el.emitterNode);
        if (el.type === 'transformer')
            return groundedNodes.has(el.primaryNodeA) && groundedNodes.has(el.primaryNodeB) &&
                   groundedNodes.has(el.secondaryNodeA) && groundedNodes.has(el.secondaryNodeB) && el.turnsRatio > 0;
        const r = el as {coilPositiveNode:number;coilNegativeNode:number;commonNode:number;normallyClosedNode:number;normallyOpenNode:number};
        return groundedNodes.has(r.coilPositiveNode) && groundedNodes.has(r.coilNegativeNode) &&
               groundedNodes.has(r.commonNode) && groundedNodes.has(r.normallyClosedNode) && groundedNodes.has(r.normallyOpenNode);
    });

    const nonGroundNodes = Array.from(usedNodes)
        .filter(id => id !== netlist.groundNodeId && groundedNodes.has(id))
        .sort((a, b) => a - b);

    const voltageSources = groundedElements.filter((e): e is SimulationVoltageSourceElement => e.type === 'voltage-source');
    const transformerElements = groundedElements.filter((e): e is SimulationTransformerElement => e.type === 'transformer');
    const inductorElements = groundedElements.filter((e): e is SimulationInductorElement => e.type === 'inductor');
    const transistorElements = groundedElements.filter((e): e is SimulationTransistorElement => e.type === 'transistor');

    const nodeIndex = new Map<number, number>();
    nonGroundNodes.forEach((id, i) => nodeIndex.set(id, i));

    const n = nonGroundNodes.length;
    const m = voltageSources.length;
    const t = transformerElements.length;
    const L = inductorElements.length; // inductors get their own MNA branch rows
    const inductorBranchStart = n + m + 2 * t; // first row index for inductor branches
    const size = n + m + 2 * t + L;

    // Precompute static stamp triples [row, col, val] for all resistors.
    // Applied each Newton iteration via a tight typed-array loop — no Map lookups.
    const staticStampList: number[] = [];
    const stamp4 = (ia: number | undefined, ib: number | undefined, g: number) => {
        if (ia !== undefined) staticStampList.push(ia, ia, g);
        if (ib !== undefined) staticStampList.push(ib, ib, g);
        if (ia !== undefined && ib !== undefined) {
            staticStampList.push(ia, ib, -g);
            staticStampList.push(ib, ia, -g);
        }
    };
    for (const el of groundedElements) {
        if (el.type !== 'resistor') continue;
        stamp4(nodeIndex.get(el.nodes[0]), nodeIndex.get(el.nodes[1]), 1 / el.resistanceOhms);
    }
    // Voltage source KCL stamps (static — V values go in rhs, not matrix).
    voltageSources.forEach((src, idx) => {
        const row = n + idx;
        const ip = nodeIndex.get(src.positiveNode);
        const ineg = nodeIndex.get(src.negativeNode);
        if (ip !== undefined) { staticStampList.push(ip, row, 1, row, ip, 1); }
        if (ineg !== undefined) { staticStampList.push(ineg, row, -1, row, ineg, -1); }
    });
    // Transformer stamps (static).
    transformerElements.forEach((tx, idx) => {
        const ipIdx = n + m + 2 * idx;
        const isIdx = ipIdx + 1;
        const pA = nodeIndex.get(tx.primaryNodeA);
        const pB = nodeIndex.get(tx.primaryNodeB);
        const sA = nodeIndex.get(tx.secondaryNodeA);
        const sB = nodeIndex.get(tx.secondaryNodeB);
        const tr = tx.turnsRatio;
        if (pA !== undefined) { staticStampList.push(pA, ipIdx, 1, ipIdx, pA, 1); }
        if (pB !== undefined) { staticStampList.push(pB, ipIdx, -1, ipIdx, pB, -1); }
        if (sA !== undefined) { staticStampList.push(sA, isIdx, 1, ipIdx, sA, -tr); }
        if (sB !== undefined) { staticStampList.push(sB, isIdx, -1, ipIdx, sB, tr); }
        staticStampList.push(isIdx, ipIdx, 1, isIdx, isIdx, 1 / tr);
    });

    // Inductor branch-row static KCL stamps (current I flows from nodeA to nodeB).
    // The branch equation V_a - V_b - (L/dt)*I = -(L/dt)*I_prev is added per-iteration
    // since the (L/dt) coefficient depends on dt (and may also use BDF-2 history).
    //
    // KCL: I leaves nodeA and enters nodeB:
    //   matrix[a_row][branchRow] = +1  (KCL at A: +I)
    //   matrix[b_row][branchRow] = -1  (KCL at B: -I)
    // Branch eq: V_a - V_b - (L/dt) * I = ...
    //   matrix[branchRow][a_col] = +1
    //   matrix[branchRow][b_col] = -1
    const inductorBranchRows = new Int32Array(L); // row index per inductor
    const inductorNodeIndices = new Int32Array(L * 2); // [iaIdx, ibIdx] per inductor (-1 if grounded)
    inductorElements.forEach((el, idx) => {
        const branchRow = inductorBranchStart + idx;
        const ia = nodeIndex.get(el.nodes[0]);
        const ib = nodeIndex.get(el.nodes[1]);
        inductorBranchRows[idx] = branchRow;
        inductorNodeIndices[idx * 2] = ia ?? -1;
        inductorNodeIndices[idx * 2 + 1] = ib ?? -1;
        if (ia !== undefined) staticStampList.push(ia, branchRow, 1, branchRow, ia, 1);
        if (ib !== undefined) staticStampList.push(ib, branchRow, -1, branchRow, ib, -1);
    });

    // ── Mutual inductance precompute ──────────────────────────────────────
    // For every pair of inductors in the same coupling group, compute the
    // signed mutual inductance M_eff = k * sqrt(L_i*L_j) * s_i * s_j.
    // Stored as parallel typed arrays (i_idx, j_idx, M_eff) so the Newton
    // loop can stamp without Map lookups.
    const couplingElements = groundedElements.filter(
        (e): e is Extract<typeof e, {type:'coupling'}> => e.type === 'coupling'
    );
    const couplingByGroup = new Map<string, number>();
    for (const c of couplingElements) couplingByGroup.set(c.couplingGroup, c.k);

    // Group inductor indices by coupling group
    const inductorsByGroup = new Map<string, number[]>();
    inductorElements.forEach((el, idx) => {
        if (!el.couplingGroup) return;
        const list = inductorsByGroup.get(el.couplingGroup) ?? [];
        list.push(idx);
        inductorsByGroup.set(el.couplingGroup, list);
    });

    // Build pair list: (i, j, M_ij_signed). Only i != j pairs included.
    // Each unordered pair generates two entries (i,j) and (j,i) so the matrix
    // gets stamped symmetrically.
    const pairList: number[] = []; // flat: [i, j, M_signed, i, j, M_signed, ...]
    inductorsByGroup.forEach((idxList, group) => {
        const k = couplingByGroup.get(group);
        if (k === undefined) return;
        for (let a = 0; a < idxList.length; a++) {
            for (let b = 0; b < idxList.length; b++) {
                if (a === b) continue;
                const i = idxList[a], j = idxList[b];
                const Li = inductorElements[i].inductanceHenry;
                const Lj = inductorElements[j].inductanceHenry;
                const si = inductorElements[i].couplingPolarity ?? 1;
                const sj = inductorElements[j].couplingPolarity ?? 1;
                const M = k * Math.sqrt(Li * Lj) * si * sj;
                pairList.push(i, j, M);
            }
        }
    });
    const inductorCouplingPairs = new Float64Array(pairList);

    // gmin: diagonal index for each non-ground node.
    const gminIndices = new Int32Array(n);
    nonGroundNodes.forEach((_, i) => { gminIndices[i] = i * size + i; });

    // Precomputed capacitor stamp indices: for each cap, store [ia, ib, ia*size+ia, ib*size+ib, ia*size+ib, ib*size+ia]
    // so the Newton loop can stamp without any Map lookups.
    const capElements = groundedElements.filter((e): e is Extract<typeof e, {type:'capacitor'}> => e.type === 'capacitor');
    const capStampIndices = new Int32Array(capElements.length * 4); // [ia, ib, (ia>=0? ia*size+ia : -1), (ib>=0 ? ib*size+ib : -1)] per cap
    capElements.forEach((el, i) => {
        const ia = nodeIndex.get(el.nodes[0]) ?? -1;
        const ib = nodeIndex.get(el.nodes[1]) ?? -1;
        capStampIndices[i * 4 + 0] = ia;
        capStampIndices[i * 4 + 1] = ib;
        capStampIndices[i * 4 + 2] = ia >= 0 ? ia * size + ib : -1;
        capStampIndices[i * 4 + 3] = ib >= 0 ? ib * size + ia : -1;
    });

    return {
        groundedElements,
        nonGroundNodes,
        voltageSources,
        transformerElements,
        inductorElements,
        transistorElements,
        nodeIndex,
        n, m, t, size,
        matrix: new Float64Array(size * size),
        rhs: new Float64Array(size),
        scratch: new Float64Array(size * size + size),
        staticStamps: new Float64Array(staticStampList),
        gminIndices,
        capElements,
        capStampIndices,
        inductorBranchRows,
        inductorNodeIndices,
        inductorCouplingPairs,
    };
}

export function stepTransientNetlist(
    netlist: SimulationNetlist,
    state: TransientState,
    config: TransientConfig,
    compiled?: CompiledNetlist
): TransientResult {
    const warnings = [] as TransientResult['warnings'];

    if (netlist.unsupported.length > 0) {
        warnings.push(
            {
                code: 'unsupported-elements',
                message: `${netlist.unsupported.length} component(s) are unsupported and excluded from transient solve`
            }
        );
    }

    if (config.dt <= 0 || !Number.isFinite(config.dt)) {
        return {
            ok: false,
            state,
            nodeVoltages: {},
            sourceCurrents: {},
            issue: {code: 'empty-netlist', message: 'Transient dt must be > 0'},
            warnings
        };
    }

    if (netlist.groundNodeId === null) {
        return {
            ok: false,
            state,
            nodeVoltages: {},
            sourceCurrents: {},
            issue: {code: 'no-ground', message: 'Ground node is required for transient solve'},
            warnings
        };
    }

    if (netlist.elements.length === 0) {
        return {
            ok: false,
            state,
            nodeVoltages: {},
            sourceCurrents: {},
            issue: {
                code: 'empty-netlist',
                message: 'No runtime elements to solve'
            },
            warnings
        };
    }

    // --- Use precompiled data if provided, otherwise compute on the fly ---
    let _compiled: CompiledNetlist | null = compiled ?? null;
    if (!_compiled) {
        _compiled = compileNetlist(netlist);
        if (!_compiled) {
            return { ok: false, state, nodeVoltages: {}, sourceCurrents: {},
                issue: { code: 'singular-matrix', message: 'Could not compile netlist' }, warnings };
        }
    }
    const { groundedElements, nonGroundNodes, voltageSources, transformerElements,
            inductorElements, transistorElements, nodeIndex, n, m, t, size } = _compiled;
    let relayStates: Record<string, boolean> = {...state.relayStates};

    const gmin = 1e-9;

    // Preallocated scratch buffers from compiled netlist.
    const matBuf = _compiled.matrix;
    const rhsBuf = _compiled.rhs;

    // Inline stamp helpers.
    const madd = (r: number, c: number, v: number) => { matBuf[r * size + c] += v; };
    const radd = (i: number, v: number) => { rhsBuf[i] += v; };

    // stampConductance: closure over matBuf and nodeIndex.
    const stampConductance = (a: number, b: number, g: number) => {
        const ia = nodeIndex.get(a);
        const ib = nodeIndex.get(b);
        if (ia !== undefined) matBuf[ia * size + ia] += g;
        if (ib !== undefined) matBuf[ib * size + ib] += g;
        if (ia !== undefined && ib !== undefined) {
            matBuf[ia * size + ib] -= g;
            matBuf[ib * size + ia] -= g;
        }
    };

    const stampTransformer = (
        primaryA: number,
        primaryB: number,
        secondaryA: number,
        secondaryB: number,
        turnsRatio: number,
        index: number
    ) => {
        const ipIdx = n + m + 2 * index;
        const isIdx = ipIdx + 1;

        const pA = nodeIndex.get(primaryA);
        const pB = nodeIndex.get(primaryB);
        const sA = nodeIndex.get(secondaryA);
        const sB = nodeIndex.get(secondaryB);

        if (pA !== undefined) madd(pA, ipIdx, 1);
        if (pB !== undefined) madd(pB, ipIdx, -(1));
        if (sA !== undefined) madd(sA, isIdx, 1);
        if (sB !== undefined) madd(sB, isIdx, -(1));

        if (pA !== undefined) madd(ipIdx, pA, 1);
        if (pB !== undefined) madd(ipIdx, pB, -(1));
        if (sA !== undefined) madd(ipIdx, sA, -(turnsRatio));
        if (sB !== undefined) madd(ipIdx, sB, turnsRatio);

        madd(isIdx, ipIdx, 1);
        madd(isIdx, isIdx, 1 / turnsRatio);
    };

    for (const element of groundedElements) {
        if (element.type !== 'resistor') continue;
        stampConductance(element.nodes[0], element.nodes[1], 1 / element.resistanceOhms);
    }

    // transistorElements and inductorElements come from compiled (no re-filter needed).
    // Relay elements need to be extracted here since they can change state.
    const relayElements = groundedElements.filter((element) => element.type === 'relay') as Array<Extract<typeof groundedElements[0], {type:'relay'}>>;
    // Newton iteration count. With strong nonlinearity (Ge transistor with high gm),
    // we need more iterations than the previous fixed 5. The convergence check
    // inside the loop will exit early when ‖Δv‖ falls below tolerance.
    const transistorIterations = transistorElements.length > 0 ? 20 : 1;
    const relayIterations = relayElements.length > 0 ? 3 : 1;

    const stampRelays = () => {
        for (const element of relayElements) {
            const isActive = relayStates[element.componentId] ?? false;
            const contactNode = isActive ? element.normallyOpenNode : element.normallyClosedNode;
            const coilIA = nodeIndex.get(element.coilPositiveNode);
            const coilIB = nodeIndex.get(element.coilNegativeNode);
            if (coilIA !== undefined) madd(coilIA, coilIA, 1 / element.coilResistanceOhms);
            if (coilIB !== undefined) madd(coilIB, coilIB, 1 / element.coilResistanceOhms);
            if (coilIA !== undefined && coilIB !== undefined) {
                madd(coilIA, coilIB, -1 / element.coilResistanceOhms);
                madd(coilIB, coilIA, -1 / element.coilResistanceOhms);
            }
            // Contact: low resistance when closed, high when open
            stampConductance(element.commonNode, contactNode, 1 / element.ronOhms);
            const openContactNode = isActive ? element.normallyClosedNode : element.normallyOpenNode;
            stampConductance(element.commonNode, openContactNode, 1 / element.roffOhms);
        }
    };

    const updateRelayStates = (nodeVoltagesEstimate: Record<number, number>) => {
        for (const element of relayElements) {
            const vCoilP = nodeVoltagesEstimate[element.coilPositiveNode] ?? 0;
            const vCoilN = nodeVoltagesEstimate[element.coilNegativeNode] ?? 0;
            const vCoil = Math.abs(vCoilP - vCoilN);
            const wasActive = relayStates[element.componentId] ?? false;
            const shouldActivate = vCoil > element.onCurrent * element.coilResistanceOhms;
            const shouldRelease = vCoil < element.offCurrent * element.coilResistanceOhms;
            if (!wasActive && shouldActivate) relayStates[element.componentId] = true;
            if (wasActive && shouldRelease) relayStates[element.componentId] = false;
        }
    };

    const totalIterations = Math.max(transistorIterations, relayIterations);
    // Persistent node voltage estimate buffer — reused across Newton iterations.
    // Indexed by compact index (nodeIndex.get(nodeId)). Ground = 0 always.
    const estBuf = new Float64Array(size); // compact index → voltage
    // Warm-start from previous state.
    for (let i = 0; i < nonGroundNodes.length; i++) estBuf[i] = state.nodeVoltages[nonGroundNodes[i]] ?? 0;
    let estimateVoltages: Record<number, number> = {[netlist.groundNodeId!]: 0};
    for (let i = 0; i < nonGroundNodes.length; i++) estimateVoltages[nonGroundNodes[i]] = estBuf[i];

    let solutionVector: number[] | null = null;
    const stampCapacitorCompanion = (
        nodeA: number,
        nodeB: number,
        capacitanceFarads: number,
        previousVoltage: number
    ) => {
        if (capacitanceFarads <= 0) return;
        const g = capacitanceFarads / config.dt;
        stampConductance(nodeA, nodeB, g);
        const ia = nodeIndex.get(nodeA);
        const ib = nodeIndex.get(nodeB);
        if (ia !== undefined) radd(ia, g * previousVoltage);
        if (ib !== undefined) radd(ib, -(g * previousVoltage));
    };

    // Hoist these outside the loop so LTE code can access them after.
    const useGear2 = (config.gear === 2 || config.gear === undefined) && !!state.gear2Ready;
    const capEls = _compiled.capElements;
    const capIdx = _compiled.capStampIndices;
    const dt = config.dt;
    const dtInv = 1 / dt;

    // Pre-allocate inductor history arrays once per timestep — values come from
    // the previous-step state and are constant across Newton iterations.
    const prevIArr  = new Float64Array(inductorElements.length);
    const prev2IArr = new Float64Array(inductorElements.length);
    for (let li = 0; li < inductorElements.length; li++) {
        const id = inductorElements[li].componentId;
        prevIArr[li]  = state.capacitorVoltages[`${id}:i`] ?? 0;
        prev2IArr[li] = state.prevInductorCurrents?.[id] ?? prevIArr[li];
    }

    // Build static base matrix/RHS once per timestep. Includes everything that
    // doesn't change across Newton iterations: static element stamps, gmin,
    // voltage-source RHS, capacitor companions, inductor companions, and mutual
    // inductance terms. Each iteration restores from this snapshot, then adds
    // only the dynamic (transistor + relay) stamps on top.
    const indBranchRows = _compiled.inductorBranchRows;
    const pairs         = _compiled.inductorCouplingPairs;
    const pairLen       = pairs.length;
    const baseMatBuf    = new Float64Array(size * size);
    const baseRhsBuf    = new Float64Array(size);

    {
        const ss    = _compiled.staticStamps;
        const ssLen = ss.length;
        for (let k = 0; k < ssLen; k += 3) {
            baseMatBuf[ss[k] * size + ss[k + 1]] += ss[k + 2];
        }
        const gi   = _compiled.gminIndices;
        const gmin = 1e-9;
        for (let k = 0; k < gi.length; k++) baseMatBuf[gi[k]] += gmin;

        for (let idx = 0; idx < voltageSources.length; idx++) {
            baseRhsBuf[n + idx] = voltageSources[idx].voltage;
        }

        for (let ci = 0; ci < capEls.length; ci++) {
            const el     = capEls[ci];
            const prevV  = state.capacitorVoltages[el.componentId] ?? el.initialVoltage;
            const prev2V = useGear2 ? (state.prevCapacitorVoltages?.[el.componentId] ?? prevV) : 0;
            const C = el.capacitanceFarads;
            let g: number, ieq: number;
            if (useGear2) {
                g   = (3 * C) / (2 * dt);
                ieq = (C / (2 * dt)) * (4 * prevV - prev2V);
            } else {
                g   = C * dtInv;
                ieq = g * prevV;
            }
            const ia    = capIdx[ci * 4];
            const ib    = capIdx[ci * 4 + 1];
            const abIdx = capIdx[ci * 4 + 2];
            const baIdx = capIdx[ci * 4 + 3];
            if (ia >= 0) { baseMatBuf[ia * size + ia] += g; baseRhsBuf[ia] += ieq; }
            if (ib >= 0) { baseMatBuf[ib * size + ib] += g; baseRhsBuf[ib] -= ieq; }
            if (abIdx >= 0) baseMatBuf[abIdx] -= g;
            if (baIdx >= 0) baseMatBuf[baIdx] -= g;
        }

        for (let li = 0; li < inductorElements.length; li++) {
            const el        = inductorElements[li];
            const branchRow = indBranchRows[li];
            const prevI     = state.capacitorVoltages[`${el.componentId}:i`] ?? 0;
            const prev2I    = useGear2 ? (state.prevInductorCurrents?.[el.componentId] ?? prevI) : 0;
            const iSat      = el.saturationCurrentA;
            let Leff = el.inductanceHenry;
            if (iSat !== undefined && Math.abs(prevI) > iSat) {
                Leff = el.inductanceHenry * 0.01;
            }
            let coeff: number, rhsVal: number;
            if (useGear2) {
                coeff  = (3 * Leff) / (2 * dt);
                rhsVal = (Leff / (2 * dt)) * (4 * prevI - prev2I);
            } else {
                coeff  = Leff / dt;
                rhsVal = (Leff / dt) * prevI;
            }
            baseMatBuf[branchRow * size + branchRow] -= coeff;
            baseRhsBuf[branchRow] = -rhsVal;
        }

        for (let p = 0; p < pairLen; p += 3) {
            const i      = pairs[p]     | 0;
            const j      = pairs[p + 1] | 0;
            const M      = pairs[p + 2];
            const Mcoeff = useGear2 ? (3 * M) / (2 * dt) : M / dt;
            const Mrhs   = useGear2
                ? (M / (2 * dt)) * (4 * prevIArr[j] - prev2IArr[j])
                : (M / dt) * prevIArr[j];
            baseMatBuf[indBranchRows[i] * size + indBranchRows[j]] -= Mcoeff;
            baseRhsBuf[indBranchRows[i]] -= Mrhs;
        }
    }

    for (let iteration = 0; iteration < totalIterations; iteration++) {
        matBuf.set(baseMatBuf);
        rhsBuf.set(baseRhsBuf);
        stampRelays();

        for (const transistor of transistorElements) {
            const stamp = computeTransistorStamp(transistor, estimateVoltages, state.nodeVoltages);

            const isPnp = transistor.polarity === 'pnp';
            const rowC = nodeIndex.get(transistor.collectorNode);
            const rowE = nodeIndex.get(transistor.emitterNode);
            const rowB = nodeIndex.get(transistor.baseNode);
            const colB = nodeIndex.get(transistor.baseNode);
            const colC = nodeIndex.get(transistor.collectorNode);
            const colE = nodeIndex.get(transistor.emitterNode);

            // ── Gummel-Poon MNA stamp ────────────────────────────────────────
            // gBe  = ∂Ib/∂Vbe  → conductance between B and E
            // gBc  = ∂Ib/∂Vbc  → conductance between B and C (reverse + leakage)
            // gm   = ∂Ic/∂Vbe  → VCCS at collector, controlled by Vbe
            // gmu  = ∂Ic/∂Vbc  → VCCS at collector, controlled by Vbc (Early/reverse)
            //
            // Device-frame:
            //   Vbe_dev = Ve-Vb (PNP) or Vb-Ve (NPN)  → sign s_be = -1/+1
            //   Vbc_dev = Vc-Vb (PNP) or Vb-Vc (NPN)  → sign s_bc = -1/+1
            // In MNA, we differentiate w.r.t. node voltages (not device-frame).
            // ∂Ic_node/∂Vb = gm*s_be_b + gmu*s_bc_b
            // where s_be_b = +1 (NPN) or -1 (PNP), etc.

            const s = isPnp ? -1 : 1;   // sign: +1 for NPN, -1 for PNP

            // B-E conductance (gBe = gpi)
            stampConductance(transistor.baseNode, transistor.emitterNode, stamp.gBe);
            // B-C conductance (reverse/leakage)
            stampConductance(transistor.baseNode, transistor.collectorNode, stamp.gBc);

            // gm VCCS: Ic = s*gm*(Vb-Ve) [NPN] or Ic = -gm*(Vb-Ve) [PNP]
            // Flows from E to C in device (i.e., leaves C node conventionally for NPN)
            if (rowC !== undefined && colB !== undefined) madd(rowC, colB, -s * stamp.gm);
            if (rowC !== undefined && colE !== undefined) madd(rowC, colE,  s * stamp.gm);
            if (rowE !== undefined && colB !== undefined) madd(rowE, colB,  s * stamp.gm);
            if (rowE !== undefined && colE !== undefined) madd(rowE, colE, -s * stamp.gm);

            // gmu VCCS: Ic_extra = s*gmu*(Vb-Vc) — Early effect & reverse active
            if (rowC !== undefined && colB !== undefined) madd(rowC, colB, -s * stamp.gmu);
            if (rowC !== undefined && colC !== undefined) madd(rowC, colC,  s * stamp.gmu);
            if (rowE !== undefined && colB !== undefined) madd(rowE, colB,  s * stamp.gmu);
            if (rowE !== undefined && colC !== undefined) madd(rowE, colC, -s * stamp.gmu);

            // Companion current sources (nonlinear offset correction)
            if (rowB !== undefined) radd(rowB, -stamp.iEqB);
            if (rowC !== undefined) radd(rowC, -stamp.iEqC);
            if (rowE !== undefined) radd(rowE, -stamp.iEqE);

            // Junction + diffusion capacitance.
            // SPICE GP: Cbe_total = Cje + tf*gm,   Cbc_total = Cjc + tr*gmu_b.
            // The diffusion term models the transit-time-limited carrier storage,
            // which dominates over Cje once the transistor is conducting.
            const tf = transistor.tfSeconds ?? 0;
            const tr = transistor.trSeconds ?? 0;
            const cbeTotal = transistor.cjeFarads + tf * stamp.gm;
            const cbcTotal = transistor.cjcFarads + tr * stamp.gmu_b;

            if (cbeTotal > 0) {
                const key = `${transistor.componentId}:be`;
                const prev = state.capacitorVoltages[key] ?? 0;
                stampCapacitorCompanion(
                    transistor.baseNode,
                    transistor.emitterNode,
                    cbeTotal,
                    prev
                );
            }

            if (cbcTotal > 0) {
                const key = `${transistor.componentId}:bc`;
                const prev = state.capacitorVoltages[key] ?? 0;
                stampCapacitorCompanion(
                    transistor.baseNode,
                    transistor.collectorNode,
                    cbcTotal,
                    prev
                );
            }
        }

        solutionVector = solveLinearSystem(matBuf, rhsBuf, size, _compiled.scratch);
        if (!solutionVector) break;

        // Newton convergence check with damping.
        // For stiff Ge transistor circuits, gm can change 1000× between iterations,
        // requiring strong damping to converge. Adaptive: aggressive first iteration
        // (because warm-start may already be close), then heavily damped.
        let maxDelta = 0;
        const STEP_LIMIT = 1.0; // V — harsh per-iteration step cap for stiff systems
        const damping = iteration === 0 ? 1.0 : iteration < 5 ? 0.5 : 0.25;
        for (let i = 0; i < n; i++) {
            const newV = solutionVector![i];
            const oldV = estBuf[i];
            let delta = newV - oldV;
            // SPICE step limiting
            if (delta >  STEP_LIMIT) delta =  STEP_LIMIT;
            if (delta < -STEP_LIMIT) delta = -STEP_LIMIT;
            const blended = oldV + damping * delta;
            estBuf[i] = blended;
            const absDelta = Math.abs(delta);
            if (absDelta > maxDelta) maxDelta = absDelta;
        }
        // Branch currents (voltage source / transformer / inductor rows): no damping
        for (let i = n; i < size; i++) estBuf[i] = solutionVector![i];

        for (let i = 0; i < nonGroundNodes.length; i++) estimateVoltages[nonGroundNodes[i]] = estBuf[i];
        updateRelayStates(estimateVoltages);

        // Convergence: ‖Δv‖∞ < (rtol*max|v| + atol).
        // Tight enough to give accurate operating points; loose enough to converge fast.
        const NEWTON_RTOL = 1e-4;
        const NEWTON_ATOL = 1e-6;
        let maxV = 0;
        for (let i = 0; i < n; i++) {
            const av = Math.abs(estBuf[i]);
            if (av > maxV) maxV = av;
        }
        if (iteration >= 2 && maxDelta < NEWTON_RTOL * maxV + NEWTON_ATOL) break;
    }
    if (!solutionVector) {
        return {
            ok: false,
            state,
            nodeVoltages: {},
            sourceCurrents: {},
            issue: {code: 'singular-matrix', message: 'Transient solve failed: singular matrix'},
            warnings
        };
    }

    // Build final nodeVoltages from the last Newton solution (already in estBuf).
    const nodeVoltages: Record<number, number> = estimateVoltages; // estBuf already synced

    const sourceCurrents: Record<string, number> = {};
    voltageSources.forEach((source, idx) => {
        sourceCurrents[source.componentId] = solutionVector[n + idx];
    });

    // Mutate a copy of capacitorVoltages for the new state.
    const capacitorVoltages: Record<string, number> = {...state.capacitorVoltages};
    for (const element of groundedElements) {
        if (element.type !== 'capacitor') continue;
        const va = nodeVoltages[element.nodes[0]] ?? 0;
        const vb = nodeVoltages[element.nodes[1]] ?? 0;
        capacitorVoltages[element.componentId] = va - vb;
    }
    // Update inductor state: read branch current directly from solution vector.
    // I is now a true MNA unknown — no companion-model integration needed.
    const indBranchRowsOut = _compiled.inductorBranchRows;
    for (let li = 0; li < inductorElements.length; li++) {
        const element = inductorElements[li];
        const branchRow = indBranchRowsOut[li];
        const va = nodeVoltages[element.nodes[0]] ?? 0;
        const vb = nodeVoltages[element.nodes[1]] ?? 0;
        const vL = va - vb;
        const I_solved = solutionVector[branchRow] ?? 0;

        // Apply saturation clamp on the read-back current (not on companion).
        const iSat = element.saturationCurrentA;
        const iClamped = iSat !== undefined
            ? Math.max(-iSat, Math.min(iSat, I_solved))
            : I_solved;
        capacitorVoltages[`${element.componentId}:i`] = iClamped;
        capacitorVoltages[element.componentId] = vL;
    }
    for (const transistor of transistorElements) {
        const hasBeCap = transistor.cjeFarads > 0 || (transistor.tfSeconds ?? 0) > 0;
        const hasBcCap = transistor.cjcFarads > 0 || (transistor.trSeconds ?? 0) > 0;
        if (hasBeCap) {
            const vb = nodeVoltages[transistor.baseNode] ?? 0;
            const ve = nodeVoltages[transistor.emitterNode] ?? 0;
            capacitorVoltages[`${transistor.componentId}:be`] = vb - ve;
        }
        if (hasBcCap) {
            const vb = nodeVoltages[transistor.baseNode] ?? 0;
            const vc = nodeVoltages[transistor.collectorNode] ?? 0;
            capacitorVoltages[`${transistor.componentId}:bc`] = vb - vc;
        }
    }

    // ── GEAR-2 history update ────────────────────────────────────────────────
    // Save current step's capacitor voltages and inductor currents as "prev"
    // for the next step's GEAR-2 companion. Also save prev node voltages.
    const prevCapacitorVoltages: Record<string, number> = state.capacitorVoltages;
    const prevInductorCurrents: Record<string, number> = {};
    for (const el of inductorElements) {
        prevInductorCurrents[el.componentId] =
            state.capacitorVoltages[`${el.componentId}:i`] ?? 0;
    }
    const prevNodeVoltages: Record<number, number> = state.nodeVoltages;

    // ── LTE estimation + adaptive dt recommendation ─────────────────────────
    // SPICE-style: estimate the local truncation error using the difference
    // between adjacent step values (predictor-corrector estimate).
    //
    // For GEAR-2, the LTE is proportional to h^3 * d^3V/dt^3.
    // We estimate it using the backward-difference approximation:
    //   LTE ≈ (2*dt^2) / (6) * |ΔΔV/dt^2| where ΔΔV = V_n - 2*V_{n-1} + V_{n-2}
    //
    // The recommended dt targets lteRatio = 1.0 (accept if < 2, tighten if > 1).
    const rtol = 1e-3;  // relative
    const atol = 1e-6;  // absolute (1µV)
    let maxLteRatio = 0;
    if (useGear2 && state.prevCapacitorVoltages) {
        for (const el of capEls) {
            const Vc_n  = capacitorVoltages[el.componentId] ?? 0;
            const Vc_n1 = state.capacitorVoltages[el.componentId] ?? el.initialVoltage;
            const Vc_n2 = state.prevCapacitorVoltages[el.componentId] ?? Vc_n1;
            // Second-difference (proportional to d²V/dt²)
            const delta2 = Math.abs(Vc_n - 2 * Vc_n1 + Vc_n2);
            // LTE for BDF-2 ≈ (1/12) * h³ * |d³V/dt³| ≈ (delta2 / (2*dt)) / 6
            const lte   = delta2 / 6;
            const tol   = rtol * Math.max(Math.abs(Vc_n), Math.abs(Vc_n1)) + atol;
            const ratio = lte / tol;
            if (ratio > maxLteRatio) maxLteRatio = ratio;
        }
    }

    // dt recommendation: scale by (1/ratio)^(1/3) with safety=0.9, bounds [0.5x, 2x]
    let recommendedDt = config.dt;
    if (maxLteRatio > 0) {
        const scale = 0.9 * Math.pow(1 / Math.max(maxLteRatio, 1e-10), 1 / 3);
        recommendedDt = config.dt * Math.min(2.0, Math.max(0.5, scale));
    } else {
        // No LTE data yet (first few steps): gently increase dt
        recommendedDt = config.dt * 1.2;
    }

    return {
        ok: true,
        state: {
            time: state.time + config.dt,
            capacitorVoltages,
            nodeVoltages,
            relayStates,
            prevCapacitorVoltages,
            prevInductorCurrents,
            prevNodeVoltages,
            gear2Ready: true,   // after first accepted step, GEAR-2 is ready
        },
        nodeVoltages,
        sourceCurrents,
        warnings,
        recommendedDt,
        lteRatio: maxLteRatio,
    };
}

