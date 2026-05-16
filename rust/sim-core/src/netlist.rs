//! Netlist data structures.
//!
//! Mirrors the TypeScript `SimulationNetlist` and the `SimulationElement`
//! union in `src/lib/types.ts`.  Elements are represented as a Rust enum
//! rather than a tagged-union object — the Rust convention, and it lets
//! us pattern-match in the compile/stamp paths without runtime type tags.
//!
//! Phase 3a scope: resistor, capacitor, inductor (single-coil, no mutual
//! coupling), voltage source, transistor (Phase 2 stamp), diode (Phase 2
//! stamp).  Transformers, relays, and inductor coupling come in Phase 3b.
//!
//! Node IDs are `u32` — they match topology-level node identifiers that
//! the SvelteKit netlist builder produces.  Ground is conventionally
//! `groundNodeId` (a specific u32 — there's no implicit "0 = ground"
//! assumption).
//!
//! Element IDs are `String` so they round-trip with the TS
//! `componentId: string`.  They're only used for diagnostics (source-
//! current reporting in Phase 3b) so the allocation cost is paid once at
//! netlist build time.

use crate::types::{Diode, Transistor};

/// A single circuit element.  Each variant carries the topology nodes it
/// connects to plus any model parameters needed by the stamp function.
#[derive(Debug, Clone, PartialEq)]
pub enum Element {
    Resistor {
        id: String,
        a: u32,
        b: u32,
        resistance_ohms: f64,
    },
    Capacitor {
        id: String,
        a: u32,
        b: u32,
        capacitance_farads: f64,
        initial_voltage: f64,
    },
    Inductor {
        id: String,
        a: u32,
        b: u32,
        inductance_henry: f64,
        saturation_current_a: Option<f64>,
        /// Coupling group identifier — all inductors sharing the same
        /// non-empty group are mutually coupled with strength `k` from the
        /// corresponding `Coupling` element.  `None` for stand-alone
        /// inductors.
        coupling_group: Option<String>,
        /// Winding direction relative to the group's flux axis: +1 or −1.
        /// Used to set the sign of the mutual-inductance term.  Defaults
        /// to +1 for stand-alone inductors.
        coupling_polarity: i32,
    },
    VoltageSource {
        id: String,
        positive_node: u32,
        negative_node: u32,
        voltage: f64,
    },
    Transistor {
        id: String,
        base: u32,
        collector: u32,
        emitter: u32,
        params: Transistor,
    },
    Diode {
        id: String,
        anode: u32,
        cathode: u32,
        params: Diode,
    },
    /// A coupling element binds a set of inductors into a mutual-inductance
    /// group.  Has no nodes of its own — it just supplies the coupling
    /// coefficient `k` (0..1) for all inductors carrying the matching
    /// `coupling_group` string.  Mutual inductance for each pair (i, j) is
    /// `M = k · sqrt(Li · Lj) · si · sj`.
    Coupling {
        id: String,
        coupling_group: String,
        k: f64,
    },
}

impl Element {
    /// Element ID — for diagnostics and source-current reporting.
    pub fn id(&self) -> &str {
        match self {
            Element::Resistor { id, .. }
            | Element::Capacitor { id, .. }
            | Element::Inductor { id, .. }
            | Element::VoltageSource { id, .. }
            | Element::Transistor { id, .. }
            | Element::Diode { id, .. }
            | Element::Coupling { id, .. } => id.as_str(),
        }
    }

    /// All topology nodes this element touches.  Used by the compile path
    /// to build the adjacency graph for Minimum Degree reordering.
    /// `Coupling` returns an empty list — it has no nodes of its own.
    pub fn nodes(&self) -> Vec<u32> {
        match self {
            Element::Resistor { a, b, .. }
            | Element::Capacitor { a, b, .. }
            | Element::Inductor { a, b, .. } => vec![*a, *b],
            Element::VoltageSource { positive_node, negative_node, .. } => {
                vec![*positive_node, *negative_node]
            }
            Element::Transistor { base, collector, emitter, .. } => {
                vec![*base, *collector, *emitter]
            }
            Element::Diode { anode, cathode, .. } => vec![*anode, *cathode],
            Element::Coupling { .. } => Vec::new(),
        }
    }
}

/// A complete netlist: every element plus the node-id chosen as ground.
///
/// The caller is responsible for assigning topology-level node IDs.  Ground
/// is identified by `ground_node_id`; ground is at `0 V` in every solve.
/// All other nodes are "non-ground" and get a compact MNA matrix row.
#[derive(Debug, Clone)]
pub struct Netlist {
    pub elements: Vec<Element>,
    pub ground_node_id: u32,
}

impl Netlist {
    /// Empty netlist ready to be populated by `push`.
    pub fn new(ground_node_id: u32) -> Self {
        Self { elements: Vec::new(), ground_node_id }
    }

    pub fn push(&mut self, e: Element) -> &mut Self {
        self.elements.push(e);
        self
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn element_nodes_returns_correct_nodes() {
        let r = Element::Resistor {
            id: "R1".into(), a: 1, b: 2, resistance_ohms: 1000.0,
        };
        assert_eq!(r.nodes(), vec![1, 2]);

        let q = Element::Transistor {
            id: "Q1".into(), base: 3, collector: 4, emitter: 5,
            params: Transistor::npn_basic(1e-14, 200.0, 1.0, 100.0),
        };
        assert_eq!(q.nodes(), vec![3, 4, 5]);
    }

    #[test]
    fn netlist_builds_correctly() {
        let mut n = Netlist::new(0);
        n.push(Element::Resistor { id: "R1".into(), a: 1, b: 0, resistance_ohms: 1e3 });
        n.push(Element::Capacitor { id: "C1".into(), a: 1, b: 0,
            capacitance_farads: 1e-6, initial_voltage: 0.0 });
        assert_eq!(n.elements.len(), 2);
        assert_eq!(n.ground_node_id, 0);
        assert_eq!(n.elements[0].id(), "R1");
    }
}
