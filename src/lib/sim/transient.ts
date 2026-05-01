import {solveLinearSystem} from '$lib/sim/linear';
import {computeTransistorStamp} from '$lib/sim/transistor';
import type {
    SimulationInductorElement,
    SimulationNetlist,
    SimulationTransformerElement,
    SimulationVoltageSourceElement,
    TransientConfig,
    TransientResult,
    TransientState
} from '$lib/types';

export function initializeTransientState(netlist: SimulationNetlist): TransientState {
    const capacitorVoltages: Record<string, number> = {};
    // Inductor companion state: we track the voltage across the inductor
    // (stored in capacitorVoltages under a ':v' key) so we can compute the
    // companion current source each step.  Initial voltage = 0 (no stored energy).
    const relayStates: Record<string, boolean> = {};
    for (const element of netlist.elements) {
        if (element.type !== 'capacitor') {
            continue;
        }

        capacitorVoltages[element.componentId] = element.initialVoltage;
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

        if (element.cjeFarads > 0) {
            capacitorVoltages[`${element.componentId}:be`] = 0;
        }

        if (element.cjcFarads > 0) {
            capacitorVoltages[`${element.componentId}:bc`] = 0;
        }
    }

    for (const element of netlist.elements) {
        if (element.type !== 'relay') {
            continue;
        }

        relayStates[element.componentId] = false;
    }

    return {time: 0, capacitorVoltages, nodeVoltages: {}, relayStates};
}

export function stepTransientNetlist(
    netlist: SimulationNetlist,
    state: TransientState,
    config: TransientConfig
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

    const usedNodes = new Set<number>([netlist.groundNodeId]);
    for (const element of netlist.elements) {
        if (element.type === 'resistor' || element.type === 'capacitor' || element.type === 'inductor') {
            usedNodes.add(element.nodes[0]);
            usedNodes.add(element.nodes[1]);
        } else if (element.type === 'voltage-source') {
            usedNodes.add(element.positiveNode);
            usedNodes.add(element.negativeNode);
        } else if (element.type === 'transistor') {
            usedNodes.add(element.baseNode);
            usedNodes.add(element.collectorNode);
            usedNodes.add(element.emitterNode);
        } else if (element.type === 'transformer') {
            usedNodes.add(element.primaryNodeA);
            usedNodes.add(element.primaryNodeB);
            usedNodes.add(element.secondaryNodeA);
            usedNodes.add(element.secondaryNodeB);
        } else {
            usedNodes.add(element.coilPositiveNode);
            usedNodes.add(element.coilNegativeNode);
            usedNodes.add(element.commonNode);
            usedNodes.add(element.normallyClosedNode);
            usedNodes.add(element.normallyOpenNode);
        }
    }

    const adjacency = new Map<number, Set<number>>();
    const link = (a: number, b: number) => {
        const set = adjacency.get(a) ?? new Set<number>();
        set.add(b);
        adjacency.set(a, set);
    };

    for (const element of netlist.elements) {
        if (element.type === 'resistor' || element.type === 'capacitor' || element.type === 'inductor') {
            link(element.nodes[0], element.nodes[1]);
            link(element.nodes[1], element.nodes[0]);
        } else if (element.type === 'voltage-source') {
            link(element.positiveNode, element.negativeNode);
            link(element.negativeNode, element.positiveNode);
        } else if (element.type === 'transistor') {
            link(element.baseNode, element.emitterNode);
            link(element.emitterNode, element.baseNode);
            link(element.collectorNode, element.emitterNode);
            link(element.emitterNode, element.collectorNode);
        } else if (element.type === 'transformer') {
            link(element.primaryNodeA, element.primaryNodeB);
            link(element.primaryNodeB, element.primaryNodeA);
            link(element.secondaryNodeA, element.secondaryNodeB);
            link(element.secondaryNodeB, element.secondaryNodeA);
            link(element.primaryNodeA, element.secondaryNodeA);
            link(element.secondaryNodeA, element.primaryNodeA);
            link(element.primaryNodeB, element.secondaryNodeB);
            link(element.secondaryNodeB, element.primaryNodeB);
        } else {
            link(element.coilPositiveNode, element.coilNegativeNode);
            link(element.coilNegativeNode, element.coilPositiveNode);
            link(element.commonNode, element.normallyClosedNode);
            link(element.normallyClosedNode, element.commonNode);
            link(element.commonNode, element.normallyOpenNode);
            link(element.normallyOpenNode, element.commonNode);
        }
    }

    const groundedNodes = new Set<number>();
    const queue = [netlist.groundNodeId];
    while (queue.length > 0) {
        const node = queue.shift();
        if (node === undefined || groundedNodes.has(node)) continue;
        groundedNodes.add(node);
        for (const neighbor of adjacency.get(node) ?? []) {
            if (!groundedNodes.has(neighbor)) queue.push(neighbor);
        }
    }

    const groundedElements = netlist.elements.filter((element) => {
        if (element.type === 'resistor' || element.type === 'capacitor' || element.type === 'inductor') {
            return groundedNodes.has(element.nodes[0]) && groundedNodes.has(element.nodes[1]);
        }
        if (element.type === 'voltage-source') {
            return groundedNodes.has(element.positiveNode) && groundedNodes.has(element.negativeNode);
        }
        if (element.type === 'transistor') {
            return (
                groundedNodes.has(element.baseNode) &&
                groundedNodes.has(element.collectorNode) &&
                groundedNodes.has(element.emitterNode)
            );
        }
        if (element.type === 'transformer') {
            return (
                groundedNodes.has(element.primaryNodeA) &&
                groundedNodes.has(element.primaryNodeB) &&
                groundedNodes.has(element.secondaryNodeA) &&
                groundedNodes.has(element.secondaryNodeB) &&
                element.turnsRatio > 0
            );
        }
        return (
            groundedNodes.has(element.coilPositiveNode) &&
            groundedNodes.has(element.coilNegativeNode) &&
            groundedNodes.has(element.commonNode) &&
            groundedNodes.has(element.normallyClosedNode) &&
            groundedNodes.has(element.normallyOpenNode) &&
            element.coilResistanceOhms > 0 &&
            element.ronOhms > 0 &&
            element.roffOhms > 0
        );
    });

    const relayElements = groundedElements.filter((element) => element.type === 'relay');
    const relayIterations = relayElements.length > 0 ? 5 : 1;
    let relayStates: Record<string, boolean> = {...state.relayStates};
    const updateRelayStates = (voltages: Record<number, number>) => {
        for (const relay of relayElements) {
            const vp = voltages[relay.coilPositiveNode] ?? 0;
            const vn = voltages[relay.coilNegativeNode] ?? 0;
            const coilCurrent = Math.abs((vp - vn) / relay.coilResistanceOhms);
            const currentlyOn = relayStates[relay.componentId] ?? false;
            if (currentlyOn) {
                relayStates[relay.componentId] = coilCurrent >= relay.offCurrent;
            } else {
                relayStates[relay.componentId] = coilCurrent >= relay.onCurrent;
            }
        }
    };

    const stampRelays = () => {
        for (const relay of relayElements) {
            stampConductance(relay.coilPositiveNode, relay.coilNegativeNode, 1 / relay.coilResistanceOhms);

            const isOn = relayStates[relay.componentId] ?? false;
            const gComNc = 1 / (isOn ? relay.roffOhms : relay.ronOhms);
            const gComNo = 1 / (isOn ? relay.ronOhms : relay.roffOhms);
            stampConductance(relay.commonNode, relay.normallyClosedNode, gComNc);
            stampConductance(relay.commonNode, relay.normallyOpenNode, gComNo);
        }
    };

    if (groundedElements.length < netlist.elements.length) {
        warnings.push({
            code: 'floating-subcircuit',
            message: `${netlist.elements.length - groundedElements.length} element(s) are floating and excluded from transient solve`
        });
    }

    if (groundedElements.length === 0) {
        return {
            ok: false,
            state,
            nodeVoltages: {},
            sourceCurrents: {},
            issue: {code: 'empty-netlist', message: 'No grounded elements to solve'},
            warnings
        };
    }

    const nonGroundNodes = Array.from(usedNodes)
        .filter((nodeId) => nodeId !== netlist.groundNodeId && groundedNodes.has(nodeId))
        .sort((a, b) => a - b);

    const voltageSources: SimulationVoltageSourceElement[] = groundedElements.filter(
        (element): element is SimulationVoltageSourceElement => element.type === 'voltage-source'
    );
    const transformerElements: SimulationTransformerElement[] = groundedElements.filter(
        (element): element is SimulationTransformerElement => element.type === 'transformer'
    );

    const nodeIndex = new Map<number, number>();
    nonGroundNodes.forEach((nodeId, idx) => nodeIndex.set(nodeId, idx));

    const n = nonGroundNodes.length;
    const m = voltageSources.length;
    const t = transformerElements.length;
    const size = n + m + 2 * t;
    const gmin = 1e-9;

    const matrix = Array.from({length: size}, () => new Array(size).fill(0));
    const rhs = new Array(size).fill(0);

    const stampConductance = (a: number, b: number, g: number) => {
        const ia = nodeIndex.get(a);
        const ib = nodeIndex.get(b);
        if (ia !== undefined) matrix[ia][ia] += g;
        if (ib !== undefined) matrix[ib][ib] += g;
        if (ia !== undefined && ib !== undefined) {
            matrix[ia][ib] -= g;
            matrix[ib][ia] -= g;
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

        if (pA !== undefined) matrix[pA][ipIdx] += 1;
        if (pB !== undefined) matrix[pB][ipIdx] -= 1;
        if (sA !== undefined) matrix[sA][isIdx] += 1;
        if (sB !== undefined) matrix[sB][isIdx] -= 1;

        if (pA !== undefined) matrix[ipIdx][pA] += 1;
        if (pB !== undefined) matrix[ipIdx][pB] -= 1;
        if (sA !== undefined) matrix[ipIdx][sA] -= turnsRatio;
        if (sB !== undefined) matrix[ipIdx][sB] += turnsRatio;

        matrix[isIdx][ipIdx] += 1;
        matrix[isIdx][isIdx] += 1 / turnsRatio;
    };

    for (const element of groundedElements) {
        if (element.type !== 'resistor') continue;
        stampConductance(element.nodes[0], element.nodes[1], 1 / element.resistanceOhms);
    }

    const transistorElements = groundedElements.filter((element) => element.type === 'transistor');
    const inductorElements = groundedElements.filter(
        (element): element is SimulationInductorElement => element.type === 'inductor'
    );
    const transistorIterations = transistorElements.length > 0 ? 5 : 1;
    const totalIterations = Math.max(transistorIterations, relayIterations);
    let estimateVoltages: Record<number, number> = {...state.nodeVoltages};

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
        if (ia !== undefined) rhs[ia] += g * previousVoltage;
        if (ib !== undefined) rhs[ib] -= g * previousVoltage;
    };

    for (let iteration = 0; iteration < totalIterations; iteration++) {
        for (let row = 0; row < size; row++) {
            matrix[row].fill(0);
            rhs[row] = 0;
        }

        for (const nodeId of nonGroundNodes) {
            const idx = nodeIndex.get(nodeId);
            if (idx !== undefined) matrix[idx][idx] += gmin;
        }

        for (const element of groundedElements) {
            if (element.type !== 'resistor') continue;
            stampConductance(element.nodes[0], element.nodes[1], 1 / element.resistanceOhms);
        }

        for (const element of groundedElements) {
            if (element.type !== 'capacitor') continue;
            const previousVoltage = state.capacitorVoltages[element.componentId] ?? element.initialVoltage;
            const g = element.capacitanceFarads / config.dt;
            stampConductance(element.nodes[0], element.nodes[1], g);

            const ia = nodeIndex.get(element.nodes[0]);
            const ib = nodeIndex.get(element.nodes[1]);
            if (ia !== undefined) rhs[ia] += g * previousVoltage;
            if (ib !== undefined) rhs[ib] -= g * previousVoltage;
        }

        // Inductor backward-Euler companion: L/dt conductance + history current source.
        // The inductor companion is dual to the capacitor: G_L = L/dt (large L → small G),
        // and the current source I_eq = G_L * V_prev drives current from nodeA to nodeB.
        for (const element of inductorElements) {
            const prevV = state.capacitorVoltages[element.componentId] ?? 0;
            const g = config.dt / element.inductanceHenry; // G_L = dt/L
            stampConductance(element.nodes[0], element.nodes[1], g);
            const ia = nodeIndex.get(element.nodes[0]);
            const ib = nodeIndex.get(element.nodes[1]);
            // I_eq = prevI = prevV * G_L (current that was flowing last step)
            const ieq = prevV * g;
            if (ia !== undefined) rhs[ia] += ieq;
            if (ib !== undefined) rhs[ib] -= ieq;
        }

        stampRelays();

        for (const transistor of transistorElements) {
            const stamp = computeTransistorStamp(transistor, estimateVoltages);
            stampConductance(transistor.baseNode, transistor.emitterNode, stamp.gBe);
            stampConductance(transistor.collectorNode, transistor.emitterNode, stamp.gCe);

            const rowC = nodeIndex.get(transistor.collectorNode);
            const rowE = nodeIndex.get(transistor.emitterNode);
            const rowB = nodeIndex.get(transistor.baseNode);
            const colB = nodeIndex.get(transistor.baseNode);
            const colE = nodeIndex.get(transistor.emitterNode);

            if (rowC !== undefined && colB !== undefined) matrix[rowC][colB] += stamp.gmSigned;
            if (rowC !== undefined && colE !== undefined) matrix[rowC][colE] -= stamp.gmSigned;
            if (rowE !== undefined && colB !== undefined) matrix[rowE][colB] -= stamp.gmSigned;
            if (rowE !== undefined && colE !== undefined) matrix[rowE][colE] += stamp.gmSigned;

            // Linearization current offsets (Ieq) for correct Newton-Raphson stamping.
            // Without these the operating point drifts — each iteration only has the
            // conductance stamp but not the companion current that anchors it to the
            // actual device curve.
            if (rowB !== undefined) rhs[rowB] -= stamp.iEqB;
            if (rowC !== undefined) rhs[rowC] -= stamp.iEqC;
            if (rowE !== undefined) rhs[rowE] -= stamp.iEqE;

            if (transistor.cjeFarads > 0) {
                const key = `${transistor.componentId}:be`;
                const prev = state.capacitorVoltages[key] ?? 0;
                stampCapacitorCompanion(
                    transistor.baseNode,
                    transistor.emitterNode,
                    transistor.cjeFarads,
                    prev
                );
            }

            if (transistor.cjcFarads > 0) {
                const key = `${transistor.componentId}:bc`;
                const prev = state.capacitorVoltages[key] ?? 0;
                stampCapacitorCompanion(
                    transistor.baseNode,
                    transistor.collectorNode,
                    transistor.cjcFarads,
                    prev
                );
            }
        }

        voltageSources.forEach((source, idx) => {
            const row = n + idx;
            const ip = nodeIndex.get(source.positiveNode);
            const ineg = nodeIndex.get(source.negativeNode);

            if (ip !== undefined) {
                matrix[ip][row] += 1;
                matrix[row][ip] += 1;
            }
            if (ineg !== undefined) {
                matrix[ineg][row] -= 1;
                matrix[row][ineg] -= 1;
            }
            rhs[row] = source.voltage;
        });

        transformerElements.forEach((transformer, idx) => {
            stampTransformer(
                transformer.primaryNodeA,
                transformer.primaryNodeB,
                transformer.secondaryNodeA,
                transformer.secondaryNodeB,
                transformer.turnsRatio,
                idx
            );
        });

        solutionVector = solveLinearSystem(matrix, rhs);
        if (!solutionVector) break;

        const updatedEstimate: Record<number, number> = {[netlist.groundNodeId]: 0};
        nonGroundNodes.forEach((nodeId, idx) => {
            updatedEstimate[nodeId] = solutionVector?.[idx] ?? 0;
        });
        estimateVoltages = updatedEstimate;
        updateRelayStates(updatedEstimate);
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

    const nodeVoltages: Record<number, number> = {[netlist.groundNodeId]: 0};
    nonGroundNodes.forEach((nodeId, idx) => {
        nodeVoltages[nodeId] = solutionVector[idx];
    });

    const sourceCurrents: Record<string, number> = {};
    voltageSources.forEach((source, idx) => {
        sourceCurrents[source.componentId] = solutionVector[n + idx];
    });

    const capacitorVoltages: Record<string, number> = {...state.capacitorVoltages};
    for (const element of groundedElements) {
        if (element.type !== 'capacitor') continue;
        const va = nodeVoltages[element.nodes[0]] ?? 0;
        const vb = nodeVoltages[element.nodes[1]] ?? 0;
        capacitorVoltages[element.componentId] = va - vb;
    }
    // Store inductor voltage for companion model next step.
    for (const element of inductorElements) {
        const va = nodeVoltages[element.nodes[0]] ?? 0;
        const vb = nodeVoltages[element.nodes[1]] ?? 0;
        capacitorVoltages[element.componentId] = va - vb;
    }
    for (const transistor of transistorElements) {
        if (transistor.cjeFarads > 0) {
            const vb = nodeVoltages[transistor.baseNode] ?? 0;
            const ve = nodeVoltages[transistor.emitterNode] ?? 0;
            capacitorVoltages[`${transistor.componentId}:be`] = vb - ve;
        }
        if (transistor.cjcFarads > 0) {
            const vb = nodeVoltages[transistor.baseNode] ?? 0;
            const vc = nodeVoltages[transistor.collectorNode] ?? 0;
            capacitorVoltages[`${transistor.componentId}:bc`] = vb - vc;
        }
    }

    return {
        ok: true,
        state: {time: state.time + config.dt, capacitorVoltages, nodeVoltages, relayStates},
        nodeVoltages,
        sourceCurrents,
        warnings
    };
}

