import {solveLinearSystem} from '$lib/sim/linear';
import {computeTransistorStamp} from '$lib/sim/transistor';
import {computeDiodeStamp} from '$lib/sim/diode';
import {analyzePattern, minimumDegreeOrder, numericFactor, sparseSolveInPlace} from '$lib/sim/sparse';
import type {
    CompiledNetlist,
    SimulationDiodeElement,
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

/**
 * Shared frozen empties for the hot-path return.  No transient-result consumer
 * actually reads `sourceCurrents` or `warnings` — they were ~50-200 bytes of
 * GC pressure per step (≈ 20 k steps/sec at audio rate = 1-4 MB/sec of churn).
 * Allocating once and reusing eliminates this entirely; if a step genuinely has
 * warnings to emit we allocate a fresh array just for that step.
 */
const EMPTY_SOURCE_CURRENTS: Record<string, number> = Object.freeze({}) as Record<string, number>;
const EMPTY_WARNINGS: TransientResult['warnings'] = Object.freeze([]) as unknown as TransientResult['warnings'];

/**
 * Perturbs capacitor and junction-cap voltages by a small random offset so that
 * circuits starting at a DC equilibrium (net signal = 0) receive a nudge that
 * lets oscillators and multivibrators self-start.
 */
export function applyStartupKick(state: TransientState, amplitude: number): TransientState {
    const nextCap   = new Float64Array(state.capVolts);
    const nextTjCap = new Float64Array(state.tjCapVolts);
    const nextInd   = new Float64Array(state.inductorCurrents);
    for (let i = 0; i < nextCap.length;   i++) nextCap[i]   += (Math.random() * 2 - 1) * amplitude;
    for (let i = 0; i < nextTjCap.length; i++) nextTjCap[i] += (Math.random() * 2 - 1) * amplitude;
    for (let i = 0; i < nextInd.length;   i++) nextInd[i]   += (Math.random() * 2 - 1) * amplitude;
    return { ...state, capVolts: nextCap, tjCapVolts: nextTjCap, inductorCurrents: nextInd };
}

/**
 * Build the initial TransientState from a compiled netlist.
 * All arrays are sized to match the compiled element arrays so the Newton loop
 * can index directly without Map lookups.
 *
 * @param compiled             Compiled netlist (from compileNetlist).
 * @param initialNodeVoltages  DC operating-point voltages by topology node ID.
 *                             If provided, capacitor and junction-cap voltages are
 *                             seeded from the operating point; otherwise start at 0.
 */
export function initializeTransientState(
    compiled: CompiledNetlist,
    initialNodeVoltages?: Record<number, number>,
): TransientState {
    const { nonGroundNodes, capElements: capEls, transistorElements, inductorElements,
            transistorNodeIndices: tni, n } = compiled;

    // ── Node voltages ──────────────────────────────────────────────────────
    const nodeVolts = new Float64Array(n);
    if (initialNodeVoltages) {
        for (let i = 0; i < n; i++) {
            nodeVolts[i] = initialNodeVoltages[nonGroundNodes[i]] ?? 0;
        }
    }

    // ── Relay states ───────────────────────────────────────────────────────
    const relayStates: Record<string, boolean> = {};
    for (const el of compiled.groundedElements) {
        if (el.type === 'relay') relayStates[el.componentId] = false;
    }

    // ── Capacitor voltages ─────────────────────────────────────────────────
    const capVolts = new Float64Array(capEls.length);
    for (let ci = 0; ci < capEls.length; ci++) {
        const el = capEls[ci];
        if (el.initialVoltage !== 0) {
            capVolts[ci] = el.initialVoltage;
        } else if (initialNodeVoltages) {
            capVolts[ci] = (initialNodeVoltages[el.nodes[0]] ?? 0)
                         - (initialNodeVoltages[el.nodes[1]] ?? 0);
        }
        // else: 0 (Float64Array default)
    }

    // ── Transistor junction cap voltages ───────────────────────────────────
    // [Q0_Vbe, Q0_Vbc, Q1_Vbe, Q1_Vbc, …]
    const tjCapVolts = new Float64Array(transistorElements.length * 2);
    for (let ti = 0; ti < transistorElements.length; ti++) {
        const t  = transistorElements[ti];
        const vb = initialNodeVoltages ? (initialNodeVoltages[t.baseNode]      ?? 0) : 0;
        const vc = initialNodeVoltages ? (initialNodeVoltages[t.collectorNode] ?? 0) : 0;
        const ve = initialNodeVoltages ? (initialNodeVoltages[t.emitterNode]   ?? 0) : 0;
        if (t.cjeFarads > 0 || (t.tfSeconds ?? 0) > 0) tjCapVolts[2 * ti]     = vb - ve;
        if (t.cjcFarads > 0 || (t.trSeconds ?? 0) > 0) tjCapVolts[2 * ti + 1] = vb - vc;
    }

    return {
        nodeVolts,
        prevNodeVolts:        new Float64Array(n),
        capVolts,
        prevCapVolts:         new Float64Array(capEls.length),
        tjCapVolts,
        tjCapVoltsBack:       new Float64Array(transistorElements.length * 2),
        inductorCurrents:     new Float64Array(inductorElements.length),
        prevInductorCurrents: new Float64Array(inductorElements.length),
        relayStates,
        gear2Ready:   false,
        prevDt:       0,   // predictor disabled until the second accepted step
        avgIterCount: 10,  // conservative initial budget (matches transistor default)
    };
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
        } else if (element.type === 'diode') {
            usedNodes.add(element.anodeNode); usedNodes.add(element.cathodeNode);
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

    // For coupling elements: when multiple inductors share a couplingGroup, the
    // transformer's primary and secondary are electrically coupled.  The BFS
    // must treat them as connected so the secondary side stays in the grounded
    // subgraph — otherwise SPK1 connected only to the secondary gets filtered out.
    const couplingGroups = new Map<string, number[]>();
    for (const element of netlist.elements) {
        if (element.type === 'inductor' && element.couplingGroup) {
            const nodes = couplingGroups.get(element.couplingGroup) ?? [];
            nodes.push(element.nodes[0], element.nodes[1]);
            couplingGroups.set(element.couplingGroup, nodes);
        }
    }

    for (const element of netlist.elements) {
        if (element.type === 'coupling') {
            // Bidirectionally link every node of every inductor in this coupling group.
            const groupNodes = couplingGroups.get(element.couplingGroup);
            if (!groupNodes) continue;
            for (let i = 0; i < groupNodes.length; i++) {
                for (let j = i + 1; j < groupNodes.length; j++) {
                    link(groupNodes[i], groupNodes[j]);
                    link(groupNodes[j], groupNodes[i]);
                }
            }
            continue;
        }
        if (element.type === 'resistor' || element.type === 'capacitor' || element.type === 'inductor') {
            link(element.nodes[0], element.nodes[1]); link(element.nodes[1], element.nodes[0]);
        } else if (element.type === 'voltage-source') {
            link(element.positiveNode, element.negativeNode); link(element.negativeNode, element.positiveNode);
        } else if (element.type === 'transistor') {
            link(element.baseNode, element.emitterNode); link(element.emitterNode, element.baseNode);
            link(element.collectorNode, element.emitterNode); link(element.emitterNode, element.collectorNode);
        } else if (element.type === 'diode') {
            link(element.anodeNode, element.cathodeNode); link(element.cathodeNode, element.anodeNode);
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
        if (el.type === 'diode')
            return groundedNodes.has(el.anodeNode) && groundedNodes.has(el.cathodeNode);
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

    // ── Minimum Degree reordering ──────────────────────────────────────────
    // Permute nonGroundNodes so low-connectivity nodes are eliminated first
    // during LU factorisation, reducing fill-in in the sparse LU pattern.
    // All downstream stamp/index computation uses nodeIndex.get(node), so
    // reordering here automatically propagates through every stamp.
    //
    // Only the node block (rows 0..n-1) is reordered; voltage-source,
    // transformer, and inductor branch rows keep their MNA-standard positions
    // at the bottom of the matrix.  This keeps the algorithm simple while
    // capturing the main benefit (node rows dominate fill-in growth).
    if (nonGroundNodes.length > 1) {
        const nNodes = nonGroundNodes.length;
        // Map topology node ID → temporary compact index (sorted by ID).
        const tempIndex = new Map<number, number>();
        nonGroundNodes.forEach((id, i) => tempIndex.set(id, i));

        // Build edge list from elements that connect pairs of non-ground nodes.
        const edges: [number, number][] = [];
        const pushPair = (na: number, nb: number) => {
            const ia = tempIndex.get(na);
            const ib = tempIndex.get(nb);
            if (ia !== undefined && ib !== undefined && ia !== ib) edges.push([ia, ib]);
        };
        const allPairs = (nodes: number[]) => {
            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) pushPair(nodes[i], nodes[j]);
            }
        };
        for (const el of groundedElements) {
            if (el.type === 'coupling') continue;
            if (el.type === 'resistor' || el.type === 'capacitor' || el.type === 'inductor') {
                pushPair(el.nodes[0], el.nodes[1]);
            } else if (el.type === 'voltage-source') {
                pushPair(el.positiveNode, el.negativeNode);
            } else if (el.type === 'transistor') {
                allPairs([el.baseNode, el.collectorNode, el.emitterNode]);
            } else if (el.type === 'diode') {
                pushPair(el.anodeNode, el.cathodeNode);
            } else if (el.type === 'transformer') {
                allPairs([el.primaryNodeA, el.primaryNodeB, el.secondaryNodeA, el.secondaryNodeB]);
            }
        }

        const order = minimumDegreeOrder(nNodes, edges);
        const reordered = new Array<number>(nNodes);
        for (let k = 0; k < nNodes; k++) reordered[k] = nonGroundNodes[order[k]];
        for (let k = 0; k < nNodes; k++) nonGroundNodes[k] = reordered[k];
    }

    const voltageSources = groundedElements.filter((e): e is SimulationVoltageSourceElement => e.type === 'voltage-source');
    const transformerElements = groundedElements.filter((e): e is SimulationTransformerElement => e.type === 'transformer');
    const inductorElements = groundedElements.filter((e): e is SimulationInductorElement => e.type === 'inductor');
    const transistorElements = groundedElements.filter((e): e is SimulationTransistorElement => e.type === 'transistor');
    const diodeElements = groundedElements.filter((e): e is SimulationDiodeElement => e.type === 'diode');

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

    // Precomputed capacitor stamp indices: for each cap, store [ia, ib, ia*size+ib, ib*size+ia]
    // so the Newton loop can stamp without any Map lookups.  The off-diagonal indices
    // require BOTH ia and ib to be non-grounded — if either side is ground, the off-diagonal
    // cell doesn't exist and we mark it -1 so the stamp loop skips it.
    const capElements = groundedElements.filter((e): e is Extract<typeof e, {type:'capacitor'}> => e.type === 'capacitor');
    const capStampIndices = new Int32Array(capElements.length * 4); // [ia, ib, ia*size+ib | -1, ib*size+ia | -1] per cap
    capElements.forEach((el, i) => {
        const ia = nodeIndex.get(el.nodes[0]) ?? -1;
        const ib = nodeIndex.get(el.nodes[1]) ?? -1;
        const off = ia >= 0 && ib >= 0;
        capStampIndices[i * 4 + 0] = ia;
        capStampIndices[i * 4 + 1] = ib;
        capStampIndices[i * 4 + 2] = off ? ia * size + ib : -1;
        capStampIndices[i * 4 + 3] = off ? ib * size + ia : -1;
    });

    // ── Symbolic LU analysis ────────────────────────────────────────────────
    // The sparsity pattern is fully determined by the compiled netlist:
    //   • Static stamps: recorded in staticStampList (row, col, val triples)
    //   • Cap companions: conductance at cap node pairs — from capStampIndices
    //   • Inductor self-term and mutual coupling: from inductorBranchRows + pairList
    //   • Transistors: all 9 pairwise combinations of (base, collector, emitter)
    //   • Diodes: 4 positions — (anode,anode), (cath,cath), (anode,cath), (cath,anode)
    // We mark every position once, run the symbolic elimination to find fill-in,
    // then store the result for use by numericFactor() every Newton iteration.
    const patMark = new Uint8Array(size * size);

    // 1. Static stamps — (row, col, val) triples; positions never change with dt.
    for (let k = 0; k < staticStampList.length; k += 3) {
        patMark[(staticStampList[k] | 0) * size + (staticStampList[k + 1] | 0)] = 1;
    }

    // 2. Capacitor companion positions (conductance between the two cap nodes).
    //    The diagonal entries are already in staticStamps via gmin, but the
    //    off-diagonals for cap companions may not be if a cap is the only element
    //    spanning those nodes.  Mark all four positions explicitly.
    for (let ci = 0; ci < capElements.length; ci++) {
        const ia = capStampIndices[ci * 4];       // node index, or -1 if grounded
        const ib = capStampIndices[ci * 4 + 1];
        if (ia >= 0) patMark[ia * size + ia] = 1;
        if (ib >= 0) patMark[ib * size + ib] = 1;
        if (ia >= 0 && ib >= 0) {
            patMark[ia * size + ib] = 1;
            patMark[ib * size + ia] = 1;
        }
    }

    // 3. Inductor branch-row self-term (coeff varies with dt but position is fixed).
    for (let li = 0; li < inductorBranchRows.length; li++) {
        const br = inductorBranchRows[li];
        patMark[br * size + br] = 1;
    }

    // 4. Mutual inductance cross-terms between inductor branch rows.
    for (let p = 0; p < pairList.length; p += 3) {
        const ri = inductorBranchRows[pairList[p]     | 0];
        const rj = inductorBranchRows[pairList[p + 1] | 0];
        patMark[ri * size + rj] = 1;
    }

    // 5. Transistor stamp positions — all 9 pairwise combos of {base, collector, emitter}.
    //    Covers: gBe/gBc conductances, gm/gmu VCCS, and junction cap companions.
    for (const t of transistorElements) {
        for (const na of [t.baseNode, t.collectorNode, t.emitterNode]) {
            const ri = nodeIndex.get(na);
            if (ri === undefined) continue;
            for (const nb of [t.baseNode, t.collectorNode, t.emitterNode]) {
                const rj = nodeIndex.get(nb);
                if (rj === undefined) continue;
                patMark[ri * size + rj] = 1;
            }
        }
    }

    // 6. Diode stamp positions — conductance between anode and cathode.
    for (const d of diodeElements) {
        const ia = nodeIndex.get(d.anodeNode);
        const ic = nodeIndex.get(d.cathodeNode);
        if (ia !== undefined) patMark[ia * size + ia] = 1;
        if (ic !== undefined) patMark[ic * size + ic] = 1;
        if (ia !== undefined && ic !== undefined) {
            patMark[ia * size + ic] = 1;
            patMark[ic * size + ia] = 1;
        }
    }

    const sparsePattern = analyzePattern(patMark, size);

    // Precompute compact node indices for transistors and diodes so the Newton
    // loop can skip all nodeIndex.get() calls and stamp calls take plain ints.
    const transistorNodeIndices = new Int32Array(transistorElements.length * 3);
    transistorElements.forEach((t, i) => {
        transistorNodeIndices[i * 3]     = nodeIndex.get(t.baseNode)      ?? -1;
        transistorNodeIndices[i * 3 + 1] = nodeIndex.get(t.collectorNode) ?? -1;
        transistorNodeIndices[i * 3 + 2] = nodeIndex.get(t.emitterNode)   ?? -1;
    });

    const diodeNodeIndices = new Int32Array(diodeElements.length * 2);
    diodeElements.forEach((d, i) => {
        diodeNodeIndices[i * 2]     = nodeIndex.get(d.anodeNode)   ?? -1;
        diodeNodeIndices[i * 2 + 1] = nodeIndex.get(d.cathodeNode) ?? -1;
    });

    return {
        groundedElements,
        nonGroundNodes,
        voltageSources,
        transformerElements,
        inductorElements,
        transistorElements,
        diodeElements,
        nodeIndex,
        n, m, t, size,
        matrix: new Float64Array(size * size),
        rhs: new Float64Array(size),
        scratch: new Float64Array(size * size + size),
        baseMatrix: new Float64Array(size * size),
        baseRhs: new Float64Array(size),
        staticStamps: new Float64Array(staticStampList),
        gminIndices,
        capElements,
        capStampIndices,
        inductorBranchRows,
        inductorNodeIndices,
        inductorCouplingPairs,
        sparsePattern,
        transistorNodeIndices,
        diodeNodeIndices,
    };
}

export function stepTransientNetlist(
    netlist: SimulationNetlist,
    state: TransientState,
    config: TransientConfig,
    compiled?: CompiledNetlist
): TransientResult {
    // Lazy: stays as the shared frozen empty unless we actually push a warning.
    // Avoids ~20 k allocations/sec of empty arrays in the audio hot path.
    let warnings: TransientResult['warnings'] = EMPTY_WARNINGS;

    if (netlist.unsupported.length > 0) {
        warnings = [{
            code: 'unsupported-elements',
            message: `${netlist.unsupported.length} component(s) are unsupported and excluded from transient solve`
        }];
    }

    if (config.dt <= 0 || !Number.isFinite(config.dt)) {
        return {
            ok: false,
            state,

            sourceCurrents: EMPTY_SOURCE_CURRENTS,
            issue: {code: 'empty-netlist', message: 'Transient dt must be > 0'},
            warnings
        };
    }

    if (netlist.groundNodeId === null) {
        return {
            ok: false,
            state,

            sourceCurrents: EMPTY_SOURCE_CURRENTS,
            issue: {code: 'no-ground', message: 'Ground node is required for transient solve'},
            warnings
        };
    }

    if (netlist.elements.length === 0) {
        return {
            ok: false,
            state,

            sourceCurrents: EMPTY_SOURCE_CURRENTS,
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
            return { ok: false, state, sourceCurrents: EMPTY_SOURCE_CURRENTS,
                issue: { code: 'singular-matrix', message: 'Could not compile netlist' }, warnings };
        }
    }
    const { groundedElements, nonGroundNodes, voltageSources, transformerElements,
            inductorElements, transistorElements, diodeElements, nodeIndex, n, m, t, size,
            transistorNodeIndices: tni, diodeNodeIndices: dni } = _compiled;
    // Mutate state.relayStates in place — the previous `{...state.relayStates}`
    // cloned at every step (~20 k/sec) for circuits with relays.
    const relayStates: Record<string, boolean> = state.relayStates;

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
    const relayIterations      = relayElements.length      > 0 ?  3 : 1;
    const diodeIterations      = diodeElements.length      > 0 ? 10 : 1;
    const baseIterLimit        = Math.max(transistorIterations, relayIterations, diodeIterations);

    // Adaptive iteration ceiling.
    // Once the EWMA has converged to a typical iteration count for this circuit,
    // use 2.5× that as the ceiling — enough headroom for occasional hard steps
    // while avoiding the full 20-iteration budget on every smooth oscillation.
    // Minimum is 5 for nonlinear circuits so we always have room to converge.
    const hasNonlinear = transistorElements.length > 0 || diodeElements.length > 0;
    const totalIterations = hasNonlinear && state.avgIterCount > 0
        ? Math.max(5, Math.min(baseIterLimit, Math.ceil(state.avgIterCount * 2.5)))
        : baseIterLimit;

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

    const updateRelayStates = () => {
        for (const element of relayElements) {
            const cpIdx = nodeIndex.get(element.coilPositiveNode);
            const cnIdx = nodeIndex.get(element.coilNegativeNode);
            const vCoilP = cpIdx !== undefined ? estBuf[cpIdx] : 0;
            const vCoilN = cnIdx !== undefined ? estBuf[cnIdx] : 0;
            const vCoil = Math.abs(vCoilP - vCoilN);
            const wasActive = relayStates[element.componentId] ?? false;
            const shouldActivate = vCoil > element.onCurrent * element.coilResistanceOhms;
            const shouldRelease = vCoil < element.offCurrent * element.coilResistanceOhms;
            if (!wasActive && shouldActivate) relayStates[element.componentId] = true;
            if (wasActive && shouldRelease) relayStates[element.componentId] = false;
        }
    };

    // ── Linear predictor warm-start ─────────────────────────────────────────
    // After the first accepted step (gear2Ready = true, prevDt > 0) extrapolate
    // the node voltages using the trajectory from the two most recent steps:
    //   est_{n+1} = x_n + (x_n − x_{n-1}) × (dt_n / dt_{n-1})
    //
    // For smooth oscillatory signals this places Newton within one Newton step
    // of the solution immediately, halving the typical iteration count.
    // The correction is clamped to PREDICTOR_CLIP so a sudden topology or value
    // change can't launch Newton far outside the pnjlim-safe region.
    const canPredict   = state.gear2Ready && state.prevDt > 0;
    const dtRatio      = canPredict ? Math.min(config.dt / state.prevDt, 4.0) : 0;
    const PREDICTOR_CLIP = 1.5; // V — max single-node correction from predictor

    const estBuf = new Float64Array(size);
    for (let i = 0; i < n; i++) {
        const curr = state.nodeVolts[i];
        if (canPredict) {
            const delta = (curr - state.prevNodeVolts[i]) * dtRatio;
            estBuf[i] = curr + Math.max(-PREDICTOR_CLIP, Math.min(PREDICTOR_CLIP, delta));
        } else {
            estBuf[i] = curr;
        }
    }

    // Iteration tracking variables — updated inside the Newton loop.
    let solutionVector:   ArrayLike<number> | null = null;
    let prevRawMaxDelta = Infinity; // raw step magnitude from the previous iteration
    let actualIterations = totalIterations; // overwritten on early convergence
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

    // Inductor previous-step currents read directly from state (Float64Arrays).
    // The earlier copy-into-scratch pattern was redundant and allocated per step.

    // Build static base matrix/RHS once per timestep. Includes everything that
    // doesn't change across Newton iterations: static element stamps, gmin,
    // voltage-source RHS, capacitor companions, inductor companions, and mutual
    // inductance terms. Each iteration restores from this snapshot, then adds
    // only the dynamic (transistor + relay) stamps on top.
    //
    // baseMatBuf and baseRhsBuf are pre-allocated in CompiledNetlist (sized once
    // at compile time) and zeroed here, avoiding a size² + size allocation per step.
    const indBranchRows = _compiled.inductorBranchRows;
    const pairs         = _compiled.inductorCouplingPairs;
    const pairLen       = pairs.length;
    const baseMatBuf    = _compiled.baseMatrix;
    const baseRhsBuf    = _compiled.baseRhs;
    baseMatBuf.fill(0);
    baseRhsBuf.fill(0);

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
            const prevV  = state.capVolts[ci];
            const prev2V = useGear2 ? state.prevCapVolts[ci] : 0;
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
            const prevI     = state.inductorCurrents[li];
            const prev2I    = useGear2 ? state.prevInductorCurrents[li] : 0;
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
                ? (M / (2 * dt)) * (4 * state.inductorCurrents[j] - state.prevInductorCurrents[j])
                : (M / dt) * state.inductorCurrents[j];
            baseMatBuf[indBranchRows[i] * size + indBranchRows[j]] -= Mcoeff;
            baseRhsBuf[indBranchRows[i]] -= Mrhs;
        }
    }

    for (let iteration = 0; iteration < totalIterations; iteration++) {
        matBuf.set(baseMatBuf);
        rhsBuf.set(baseRhsBuf);
        stampRelays();

        for (let ti = 0; ti < transistorElements.length; ti++) {
            const transistor = transistorElements[ti];
            const bi = tni[ti * 3];
            const ci = tni[ti * 3 + 1];
            const ei = tni[ti * 3 + 2];
            const stamp = computeTransistorStamp(transistor, estBuf, bi, ci, ei, state.nodeVolts);

            const rowB = bi >= 0 ? bi : undefined;
            const rowC = ci >= 0 ? ci : undefined;
            const rowE = ei >= 0 ? ei : undefined;
            const colB = rowB, colC = rowC, colE = rowE;

            // ── Gummel-Poon MNA stamp ────────────────────────────────────────
            // B-E conductance (gBe = gpi)
            stampConductance(transistor.baseNode, transistor.emitterNode, stamp.gBe);
            // B-C conductance (reverse/leakage)
            stampConductance(transistor.baseNode, transistor.collectorNode, stamp.gBc);

            // gm VCCS: gm*(Vb-Ve) leaves C, enters E (works for both NPN and PNP)
            if (rowC !== undefined && colB !== undefined) madd(rowC, colB,  stamp.gm);
            if (rowC !== undefined && colE !== undefined) madd(rowC, colE, -stamp.gm);
            if (rowE !== undefined && colB !== undefined) madd(rowE, colB, -stamp.gm);
            if (rowE !== undefined && colE !== undefined) madd(rowE, colE,  stamp.gm);

            // gmu VCCS: gmu*(Vb-Vc) leaves C, enters E
            if (rowC !== undefined && colB !== undefined) madd(rowC, colB,  stamp.gmu);
            if (rowC !== undefined && colC !== undefined) madd(rowC, colC, -stamp.gmu);
            if (rowE !== undefined && colB !== undefined) madd(rowE, colB, -stamp.gmu);
            if (rowE !== undefined && colC !== undefined) madd(rowE, colC,  stamp.gmu);

            // Companion current sources (nonlinear offset correction)
            if (rowB !== undefined) radd(rowB, -stamp.iEqB);
            if (rowC !== undefined) radd(rowC, -stamp.iEqC);
            if (rowE !== undefined) radd(rowE, -stamp.iEqE);

            // Junction + diffusion capacitance.
            const tf = transistor.tfSeconds ?? 0;
            const tr = transistor.trSeconds ?? 0;
            const cbeTotal = transistor.cjeFarads + tf * stamp.gm;
            const cbcTotal = transistor.cjcFarads + tr * stamp.gmu_b;

            if (cbeTotal > 0) {
                stampCapacitorCompanion(
                    transistor.baseNode, transistor.emitterNode,
                    cbeTotal, state.tjCapVolts[2 * ti]);
            }
            if (cbcTotal > 0) {
                stampCapacitorCompanion(
                    transistor.baseNode, transistor.collectorNode,
                    cbcTotal, state.tjCapVolts[2 * ti + 1]);
            }
        }

        // ── Diode stamps (Shockley + optional Zener) ──────────────────────
        for (let di = 0; di < diodeElements.length; di++) {
            const diode = diodeElements[di];
            const ai = dni[di * 2];
            const ki = dni[di * 2 + 1];
            const stamp = computeDiodeStamp(diode, estBuf, ai, ki, state.nodeVolts);
            stampConductance(diode.anodeNode, diode.cathodeNode, stamp.gd);
            if (ai >= 0) radd(ai, -stamp.ieq);
            if (ki >= 0) radd(ki,  stamp.ieq);
        }

        // ── Sparse LU solve ────────────────────────────────────────────────────
        // numericFactor modifies matBuf in-place (stores L below diag, U above).
        // sparseSolveInPlace overwrites rhsBuf with the solution.
        // Both buffers are reset from baseMatBuf/baseRhsBuf at the top of the
        // next iteration, so in-place mutation is safe.
        const pat = _compiled.sparsePattern;
        if (numericFactor(matBuf, size, pat)) {
            sparseSolveInPlace(matBuf, rhsBuf, size, pat);
            solutionVector = rhsBuf; // Float64Array satisfies ArrayLike<number>
        } else {
            // Fallback: dense Gaussian elimination with partial pivoting.
            // Triggers only if a diagonal goes below 1e-14 (effectively singular).
            solutionVector = solveLinearSystem(matBuf, rhsBuf, size, _compiled.scratch);
        }
        if (!solutionVector) break;

        // Pre-compute raw step magnitude (before clamping) so we can detect divergence.
        let rawMaxDelta = 0;
        for (let i = 0; i < n; i++) {
            const d = Math.abs(solutionVector![i] - estBuf[i]);
            if (d > rawMaxDelta) rawMaxDelta = d;
        }

        // Adaptive damping:
        //   iteration 0 → 1.0  (predictor already placed us close; trust full step)
        //   diverging (raw Δ > 2× previous) → 0.1  (emergency brake; avoids oscillation)
        //   iterations 1–2 → 0.6  (slightly looser than before; predictor earns it)
        //   iterations 3+  → 0.3  (heavier for stubborn nonlinear cases)
        const damping = iteration === 0 ? 1.0
            : rawMaxDelta > prevRawMaxDelta * 2.0 ? 0.1
            : iteration < 3 ? 0.6 : 0.3;
        prevRawMaxDelta = rawMaxDelta;

        let maxDelta = 0;
        const STEP_LIMIT = 1.0; // V — SPICE-style per-iteration voltage clamp
        for (let i = 0; i < n; i++) {
            const newV = solutionVector![i];
            const oldV = estBuf[i];
            let delta = newV - oldV;
            if (delta >  STEP_LIMIT) delta =  STEP_LIMIT;
            if (delta < -STEP_LIMIT) delta = -STEP_LIMIT;
            estBuf[i] = oldV + damping * delta;
            const absDelta = Math.abs(delta);
            if (absDelta > maxDelta) maxDelta = absDelta;
        }
        // Branch currents (voltage source / transformer / inductor rows): no damping
        for (let i = n; i < size; i++) estBuf[i] = solutionVector![i];

        updateRelayStates();

        // Convergence: ‖Δv‖∞ < (rtol·max|v| + atol).
        const NEWTON_RTOL = 1e-4;
        const NEWTON_ATOL = 1e-6;
        let maxV = 0;
        for (let i = 0; i < n; i++) {
            const av = Math.abs(estBuf[i]);
            if (av > maxV) maxV = av;
        }
        // With a good predictor the solution may already be converged after iteration 0.
        // Allow checking from iteration 1; without predictor, require at least 2 iterations
        // to avoid accepting an unconverged DC warm-start.
        const minConvergeIter = canPredict ? 1 : 2;
        actualIterations = iteration + 1;
        if (iteration >= minConvergeIter && maxDelta < NEWTON_RTOL * maxV + NEWTON_ATOL) break;
    }
    if (!solutionVector) {
        return {
            ok: false,
            state,
            sourceCurrents: EMPTY_SOURCE_CURRENTS,
            issue: {code: 'singular-matrix', message: 'Transient solve failed: singular matrix'},
            warnings
        };
    }

    // ── LTE estimation + adaptive dt recommendation ─────────────────────────
    // Must be computed BEFORE the double-buffer reuse below, since LTE reads
    // state.prevCapVolts (which we're about to overwrite).
    const rtol = 1e-3;
    const atol = 1e-6;
    let maxLteRatio = 0;
    if (useGear2) {
        for (let ci = 0; ci < capEls.length; ci++) {
            const ia = capIdx[ci * 4];
            const ib = capIdx[ci * 4 + 1];
            const Vc_n   = (ia >= 0 ? estBuf[ia] : 0) - (ib >= 0 ? estBuf[ib] : 0);
            const Vc_n1  = state.capVolts[ci];
            const Vc_n2  = state.prevCapVolts[ci];
            const delta2 = Math.abs(Vc_n - 2 * Vc_n1 + Vc_n2);
            const lte    = delta2 / 6;
            const tol    = rtol * Math.max(Math.abs(Vc_n), Math.abs(Vc_n1)) + atol;
            const ratio  = lte / tol;
            if (ratio > maxLteRatio) maxLteRatio = ratio;
        }
    }

    let recommendedDt = config.dt;
    if (maxLteRatio > 0) {
        const scale = 0.9 * Math.pow(1 / Math.max(maxLteRatio, 1e-10), 1 / 3);
        recommendedDt = config.dt * Math.min(2.0, Math.max(0.5, scale));
    } else {
        recommendedDt = config.dt * 1.2;
    }

    // ── Build new flat state from the Newton solution (already in estBuf) ──
    // Double-buffering: reuse the input state's "previous" buffers as the write
    // targets for the new step's values.  After this step:
    //   • The buffer that WAS state.prevNodeVolts now holds the NEW current values
    //   • The buffer that WAS state.nodeVolts becomes the "previous" buffer
    // The same ping-pong applies to capVolts, inductorCurrents, and tjCapVolts
    // (which uses an explicit tjCapVoltsBack scratch since it has no prev sibling).
    // Net effect: zero per-step allocation in the hot path.

    // Node voltages (compact array, indices 0..n-1 of estBuf).
    const newNodeVolts = state.prevNodeVolts;
    for (let i = 0; i < n; i++) newNodeVolts[i] = estBuf[i];

    // Capacitor voltages from node voltage differences.
    const newCapVolts = state.prevCapVolts;
    for (let ci = 0; ci < capEls.length; ci++) {
        const ia = capIdx[ci * 4];
        const ib = capIdx[ci * 4 + 1];
        newCapVolts[ci] = (ia >= 0 ? estBuf[ia] : 0) - (ib >= 0 ? estBuf[ib] : 0);
    }

    // Transistor junction cap voltages (Vbe = Vb − Ve, Vbc = Vb − Vc).
    // Writes into the back-buffer; the existing state.tjCapVolts is still read
    // for the "skip if cap disabled" branches (different indices than written).
    const newTjCapVolts = state.tjCapVoltsBack;
    for (let ti = 0; ti < transistorElements.length; ti++) {
        const transistor = transistorElements[ti];
        const bi = tni[ti * 3], ci = tni[ti * 3 + 1], ei = tni[ti * 3 + 2];
        const vb = bi >= 0 ? estBuf[bi] : 0;
        const vc = ci >= 0 ? estBuf[ci] : 0;
        const ve = ei >= 0 ? estBuf[ei] : 0;
        const hasBeCap = transistor.cjeFarads > 0 || (transistor.tfSeconds ?? 0) > 0;
        const hasBcCap = transistor.cjcFarads > 0 || (transistor.trSeconds ?? 0) > 0;
        newTjCapVolts[2 * ti]     = hasBeCap ? (vb - ve) : state.tjCapVolts[2 * ti];
        newTjCapVolts[2 * ti + 1] = hasBcCap ? (vb - vc) : state.tjCapVolts[2 * ti + 1];
    }

    // Inductor branch currents read from the branch-row entries of estBuf.
    const newInductorCurrents = state.prevInductorCurrents;
    for (let li = 0; li < inductorElements.length; li++) {
        const I_solved = estBuf[indBranchRows[li]];
        const iSat = inductorElements[li].saturationCurrentA;
        newInductorCurrents[li] = iSat !== undefined
            ? Math.max(-iSat, Math.min(iSat, I_solved)) : I_solved;
    }

    // sourceCurrents is part of the TransientResult contract but no caller in
    // the audio hot path reads it.  The dc analysis path computes its own.
    // Skipping the per-step Record allocation and key-write loop saves another
    // ~1 MB/sec of GC churn at audio rate.
    const sourceCurrents: Record<string, number> = EMPTY_SOURCE_CURRENTS;

    // Update smoothed iteration count for the next step's adaptive ceiling.
    // α = 0.3 tracks recent behaviour while smoothing single-step spikes.
    const ITER_ALPHA   = 0.3;
    const newAvgIter   = state.avgIterCount > 0
        ? ITER_ALPHA * actualIterations + (1 - ITER_ALPHA) * state.avgIterCount
        : actualIterations;

    return {
        ok: true,
        state: {
            nodeVolts:            newNodeVolts,            // (was state.prevNodeVolts buffer)
            prevNodeVolts:        state.nodeVolts,         // (was state.nodeVolts buffer)
            capVolts:             newCapVolts,             // (was state.prevCapVolts buffer)
            prevCapVolts:         state.capVolts,          // (was state.capVolts buffer)
            tjCapVolts:           newTjCapVolts,           // (was state.tjCapVoltsBack buffer)
            tjCapVoltsBack:       state.tjCapVolts,        // (was state.tjCapVolts buffer)
            inductorCurrents:     newInductorCurrents,     // (was state.prevInductorCurrents buffer)
            prevInductorCurrents: state.inductorCurrents,  // (was state.inductorCurrents buffer)
            relayStates,
            gear2Ready:   true,
            prevDt:       config.dt,    // stored so next step's predictor scales correctly
            avgIterCount: newAvgIter,
        },
        sourceCurrents,
        warnings,
        recommendedDt,
        lteRatio: maxLteRatio,
    };
}

