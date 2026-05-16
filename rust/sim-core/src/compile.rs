//! Netlist compilation: derive the static MNA structure from a `Netlist`.
//!
//! Mirrors the relevant bits of `compileNetlist` in `src/lib/sim/transient.ts`.
//! Phase 3a scope:
//! - Discover the set of non-ground nodes and assign compact indices.
//! - Reorder via Minimum Degree to reduce LU fill.
//! - Build the symbolic sparsity pattern for the MNA matrix.
//! - Precompute static stamps (resistor conductances, voltage-source
//!   incidence) so the Newton inner loop is allocation-free.
//! - Precompute compact node indices for transistors, diodes, capacitors,
//!   inductors so stamps don't traverse a HashMap.
//!
//! Phase 3b adds: inductor coupling (mutual inductance pairs), transformer
//! elements, relay state machine, source-current diagnostic indices.

use std::collections::{BTreeMap, BTreeSet};

use crate::netlist::{Element, Netlist};
use crate::sparse::{analyze_pattern, minimum_degree_order, SparseLuPattern};

/// All the precomputed structure the Newton inner loop needs.  Buffers
/// (`matrix`, `rhs`, etc.) are owned by the compiled netlist so we never
/// allocate inside the step.
pub struct CompiledNetlist {
    // ── Topology ────────────────────────────────────────────────────────
    /// Non-ground topology node IDs in elimination order (MD-permuted).
    pub non_ground_nodes: Vec<u32>,
    /// `node_index[topology_node_id] = compact MNA row index (0..n)`.
    pub node_index: BTreeMap<u32, usize>,

    /// Number of non-ground nodes.
    pub n: usize,
    /// Number of voltage sources.
    pub m: usize,
    /// Total MNA matrix dimension: `n + m + inductor_count`.
    pub size: usize,

    // ── Pre-allocated scratch ───────────────────────────────────────────
    pub matrix: Vec<f64>,     // size × size, row-major
    pub rhs: Vec<f64>,        // size
    pub base_matrix: Vec<f64>,// size × size — built once per step
    pub base_rhs: Vec<f64>,   // size

    // ── Static stamps ───────────────────────────────────────────────────
    /// Flat triples `[row0, col0, val0, row1, col1, val1, …]`.  Applied at
    /// the top of each step before the Newton loop.  Resistor conductances
    /// and voltage-source incidence go here.
    pub static_stamps: Vec<f64>,
    /// Diagonal indices for gmin regularisation (one per non-ground node).
    pub gmin_indices: Vec<i32>,

    // ── Per-element index caches ────────────────────────────────────────
    /// `cap_stamp_indices[ci*4..ci*4+4] = [ia, ib, ab_offset, ba_offset]`
    /// where `ia`/`ib` are compact node indices (−1 if grounded) and the
    /// offsets are `ia*size+ib`/`ib*size+ia` (−1 if grounded on that side).
    pub cap_stamp_indices: Vec<i32>,
    pub cap_count: usize,

    /// Per-inductor [a, b] compact node indices.  −1 if grounded.
    pub inductor_node_indices: Vec<i32>,
    /// Per-inductor MNA branch-row index (in the `size`×`size` matrix).
    pub inductor_branch_rows: Vec<i32>,
    pub inductor_count: usize,
    /// Flat mutual-inductance pairs: `[i, j, M_signed, …]` per coupled
    /// (i, j) pair (i ≠ j).  Both orderings (a, b) and (b, a) are stored
    /// so the matrix stamp is symmetric.  `M_signed = k · sqrt(Li · Lj)
    /// · si · sj` where si/sj are coupling polarities.
    ///
    /// Each entry packs i and j as f64-encoded usize plus M as f64; the
    /// step function reads three f64s per pair.
    pub inductor_coupling_pairs: Vec<f64>,

    /// Per-transistor [base, collector, emitter] compact indices.
    pub transistor_node_indices: Vec<i32>,
    pub transistor_count: usize,

    /// Per-diode [anode, cathode] compact indices.
    pub diode_node_indices: Vec<i32>,
    pub diode_count: usize,

    /// Per-voltage-source MNA branch-row index.
    pub voltage_source_branch_rows: Vec<i32>,
    pub voltage_source_node_indices: Vec<i32>, // [pos, neg, pos, neg, …]
    pub voltage_source_values: Vec<f64>,

    /// Symbolic LU pattern covering every position any stamp writes to.
    pub sparse_pattern: SparseLuPattern,

    // ── Element handles ─────────────────────────────────────────────────
    /// Cloned element list — the step function reads model parameters
    /// (transistor, diode, capacitor C, inductor L, etc.) directly from
    /// here keyed by the index caches above.
    pub elements: Vec<Element>,
    /// Indices into `elements` for each kind, in stamp order.
    pub resistor_indices: Vec<usize>,
    pub capacitor_indices: Vec<usize>,
    pub inductor_indices: Vec<usize>,
    pub voltage_source_indices: Vec<usize>,
    pub transistor_indices: Vec<usize>,
    pub diode_indices: Vec<usize>,
}

/// Compile a netlist.  Returns `None` if there are no non-ground nodes
/// (an empty circuit) — every other error case is recoverable.
pub fn compile_netlist(netlist: &Netlist) -> Option<CompiledNetlist> {
    let ground = netlist.ground_node_id;

    // ── Discover non-ground nodes ───────────────────────────────────────
    let mut nodes: BTreeSet<u32> = BTreeSet::new();
    for el in &netlist.elements {
        for n in el.nodes() {
            if n != ground {
                nodes.insert(n);
            }
        }
    }
    if nodes.is_empty() {
        return None;
    }
    let mut non_ground_nodes: Vec<u32> = nodes.into_iter().collect();
    let n = non_ground_nodes.len();

    // ── Minimum-Degree reordering ───────────────────────────────────────
    // Build the edge list between non-ground nodes from element adjacency,
    // then permute non_ground_nodes so low-degree nodes come first.
    if n > 1 {
        let temp_index: BTreeMap<u32, usize> = non_ground_nodes
            .iter()
            .enumerate()
            .map(|(i, &id)| (id, i))
            .collect();
        let mut edges: Vec<(usize, usize)> = Vec::new();
        for el in &netlist.elements {
            let ns = el.nodes();
            for i in 0..ns.len() {
                for j in (i + 1)..ns.len() {
                    if ns[i] == ns[j] {
                        continue;
                    }
                    if let (Some(&a), Some(&b)) =
                        (temp_index.get(&ns[i]), temp_index.get(&ns[j]))
                    {
                        edges.push((a, b));
                    }
                }
            }
        }
        let order = minimum_degree_order(n, edges);
        let reordered: Vec<u32> = order.iter().map(|&k| non_ground_nodes[k as usize]).collect();
        non_ground_nodes = reordered;
    }

    let node_index: BTreeMap<u32, usize> = non_ground_nodes
        .iter()
        .enumerate()
        .map(|(i, &id)| (id, i))
        .collect();

    // Helper: compact node index (or −1 for ground).
    let ni = |id: u32| -> i32 {
        if id == ground {
            -1
        } else {
            *node_index.get(&id).expect("node missing from index") as i32
        }
    };

    // ── Categorise elements by kind ─────────────────────────────────────
    let mut resistor_indices = Vec::new();
    let mut capacitor_indices = Vec::new();
    let mut inductor_indices = Vec::new();
    let mut voltage_source_indices = Vec::new();
    let mut transistor_indices = Vec::new();
    let mut diode_indices = Vec::new();
    let mut coupling_indices = Vec::new();
    for (i, el) in netlist.elements.iter().enumerate() {
        match el {
            Element::Resistor { .. } => resistor_indices.push(i),
            Element::Capacitor { .. } => capacitor_indices.push(i),
            Element::Inductor { .. } => inductor_indices.push(i),
            Element::VoltageSource { .. } => voltage_source_indices.push(i),
            Element::Transistor { .. } => transistor_indices.push(i),
            Element::Diode { .. } => diode_indices.push(i),
            Element::Coupling { .. } => coupling_indices.push(i),
        }
    }

    let m = voltage_source_indices.len();
    let inductor_count = inductor_indices.len();
    let cap_count = capacitor_indices.len();
    let transistor_count = transistor_indices.len();
    let diode_count = diode_indices.len();

    // MNA matrix layout:
    //   rows 0..n          → node KCL equations
    //   rows n..n+m        → voltage-source branch equations
    //   rows n+m..n+m+L    → inductor branch equations (L = inductor_count)
    let size = n + m + inductor_count;

    // ── Static stamps (resistor conductance + voltage-source incidence) ──
    let mut static_stamps: Vec<f64> = Vec::new();
    let push_stamp = |stamps: &mut Vec<f64>, row: i32, col: i32, val: f64| {
        if row >= 0 && col >= 0 {
            stamps.push(row as f64);
            stamps.push(col as f64);
            stamps.push(val);
        }
    };

    // Resistors.
    for &ri in &resistor_indices {
        if let Element::Resistor { a, b, resistance_ohms, .. } = &netlist.elements[ri] {
            let g = 1.0 / resistance_ohms.max(1e-12);
            let ai = ni(*a);
            let bi = ni(*b);
            // Y[a,a] += g, Y[b,b] += g, Y[a,b] -= g, Y[b,a] -= g
            push_stamp(&mut static_stamps, ai, ai,  g);
            push_stamp(&mut static_stamps, bi, bi,  g);
            push_stamp(&mut static_stamps, ai, bi, -g);
            push_stamp(&mut static_stamps, bi, ai, -g);
        }
    }

    // Voltage sources: branch row at `n + idx`; +1 / −1 incidence.
    let mut voltage_source_branch_rows: Vec<i32> = Vec::with_capacity(m);
    let mut voltage_source_node_indices: Vec<i32> = Vec::with_capacity(m * 2);
    let mut voltage_source_values: Vec<f64> = Vec::with_capacity(m);
    for (idx, &vi) in voltage_source_indices.iter().enumerate() {
        if let Element::VoltageSource { positive_node, negative_node, voltage, .. } =
            &netlist.elements[vi]
        {
            let pi = ni(*positive_node);
            let ne = ni(*negative_node);
            let row = (n + idx) as i32;
            voltage_source_branch_rows.push(row);
            voltage_source_node_indices.push(pi);
            voltage_source_node_indices.push(ne);
            voltage_source_values.push(*voltage);
            // KCL: +1 enters from V-source positive into node, −1 from negative
            push_stamp(&mut static_stamps, pi, row,  1.0);
            push_stamp(&mut static_stamps, ne, row, -1.0);
            // Branch equation: V_pos − V_neg = V_src
            push_stamp(&mut static_stamps, row, pi,  1.0);
            push_stamp(&mut static_stamps, row, ne, -1.0);
        }
    }

    // gmin diagonal entries.
    let gmin_indices: Vec<i32> = (0..n).map(|i| (i * size + i) as i32).collect();

    // ── Capacitor stamp index cache ─────────────────────────────────────
    let mut cap_stamp_indices: Vec<i32> = Vec::with_capacity(cap_count * 4);
    for &ci in &capacitor_indices {
        if let Element::Capacitor { a, b, .. } = &netlist.elements[ci] {
            let ia = ni(*a);
            let ib = ni(*b);
            cap_stamp_indices.push(ia);
            cap_stamp_indices.push(ib);
            cap_stamp_indices.push(if ia >= 0 && ib >= 0 { ia * (size as i32) + ib } else { -1 });
            cap_stamp_indices.push(if ia >= 0 && ib >= 0 { ib * (size as i32) + ia } else { -1 });
        }
    }

    // ── Inductor index cache ────────────────────────────────────────────
    let mut inductor_node_indices: Vec<i32> = Vec::with_capacity(inductor_count * 2);
    let mut inductor_branch_rows: Vec<i32> = Vec::with_capacity(inductor_count);
    for (idx, &li) in inductor_indices.iter().enumerate() {
        if let Element::Inductor { a, b, .. } = &netlist.elements[li] {
            let ia = ni(*a);
            let ib = ni(*b);
            inductor_node_indices.push(ia);
            inductor_node_indices.push(ib);
            let row = (n + m + idx) as i32;
            inductor_branch_rows.push(row);
            // KCL: +1 from positive terminal, −1 from negative
            push_stamp(&mut static_stamps, ia, row,  1.0);
            push_stamp(&mut static_stamps, ib, row, -1.0);
            // Branch equation: +1 at node a, −1 at node b in the branch row
            // (the L*dI/dt term is added per step in the base RHS).
            push_stamp(&mut static_stamps, row, ia,  1.0);
            push_stamp(&mut static_stamps, row, ib, -1.0);
        }
    }

    // ── Inductor coupling pairs ─────────────────────────────────────────
    // Group inductors by coupling_group, then for each group with a
    // matching Coupling element supplying `k`, generate every (i, j) pair
    // with i ≠ j and signed mutual inductance M = k · sqrt(Li · Lj) · si · sj.
    let mut k_by_group: BTreeMap<String, f64> = BTreeMap::new();
    for &ci in &coupling_indices {
        if let Element::Coupling { coupling_group, k, .. } = &netlist.elements[ci] {
            // Last-write-wins if duplicates exist; the TS reference behaves
            // the same.
            k_by_group.insert(coupling_group.clone(), *k);
        }
    }
    let mut inductors_by_group: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (idx, &li) in inductor_indices.iter().enumerate() {
        if let Element::Inductor { coupling_group: Some(g), .. } = &netlist.elements[li] {
            inductors_by_group.entry(g.clone()).or_default().push(idx);
        }
    }
    let mut inductor_coupling_pairs: Vec<f64> = Vec::new();
    for (group, idx_list) in &inductors_by_group {
        let k = match k_by_group.get(group) {
            Some(&k) => k,
            None => continue, // No coupling element for this group — uncoupled
        };
        for &a in idx_list {
            for &b in idx_list {
                if a == b { continue; }
                let (l_a, s_a) = match &netlist.elements[inductor_indices[a]] {
                    Element::Inductor { inductance_henry, coupling_polarity, .. } =>
                        (*inductance_henry, *coupling_polarity as f64),
                    _ => unreachable!(),
                };
                let (l_b, s_b) = match &netlist.elements[inductor_indices[b]] {
                    Element::Inductor { inductance_henry, coupling_polarity, .. } =>
                        (*inductance_henry, *coupling_polarity as f64),
                    _ => unreachable!(),
                };
                let m = k * (l_a * l_b).sqrt() * s_a * s_b;
                inductor_coupling_pairs.push(a as f64);
                inductor_coupling_pairs.push(b as f64);
                inductor_coupling_pairs.push(m);
            }
        }
    }

    // ── Transistor + diode index caches ─────────────────────────────────
    let mut transistor_node_indices: Vec<i32> = Vec::with_capacity(transistor_count * 3);
    for &ti in &transistor_indices {
        if let Element::Transistor { base, collector, emitter, .. } = &netlist.elements[ti] {
            transistor_node_indices.push(ni(*base));
            transistor_node_indices.push(ni(*collector));
            transistor_node_indices.push(ni(*emitter));
        }
    }
    let mut diode_node_indices: Vec<i32> = Vec::with_capacity(diode_count * 2);
    for &di in &diode_indices {
        if let Element::Diode { anode, cathode, .. } = &netlist.elements[di] {
            diode_node_indices.push(ni(*anode));
            diode_node_indices.push(ni(*cathode));
        }
    }

    // ── Sparsity marker — every position any stamp can ever write ──────
    let mut marker = vec![0u8; size * size];
    let mark = |m: &mut [u8], r: i32, c: i32| {
        if r >= 0 && c >= 0 {
            m[(r as usize) * size + (c as usize)] = 1;
        }
    };

    // Static stamp positions.
    let mut k = 0;
    while k < static_stamps.len() {
        mark(&mut marker, static_stamps[k] as i32, static_stamps[k + 1] as i32);
        k += 3;
    }
    // gmin diagonal.
    for i in 0..n {
        marker[i * size + i] = 1;
    }
    // Capacitor companion positions.
    for ci in 0..cap_count {
        let ia = cap_stamp_indices[ci * 4];
        let ib = cap_stamp_indices[ci * 4 + 1];
        if ia >= 0 {
            marker[(ia as usize) * size + (ia as usize)] = 1;
        }
        if ib >= 0 {
            marker[(ib as usize) * size + (ib as usize)] = 1;
        }
        if ia >= 0 && ib >= 0 {
            marker[(ia as usize) * size + (ib as usize)] = 1;
            marker[(ib as usize) * size + (ia as usize)] = 1;
        }
    }
    // Inductor branch-row self-term.
    for &br in &inductor_branch_rows {
        marker[(br as usize) * size + (br as usize)] = 1;
    }
    // Mutual inductance pairs — off-diagonals at (branch_i, branch_j).
    let mut p = 0;
    while p < inductor_coupling_pairs.len() {
        let i_idx = inductor_coupling_pairs[p] as usize;
        let j_idx = inductor_coupling_pairs[p + 1] as usize;
        let br_i = inductor_branch_rows[i_idx] as usize;
        let br_j = inductor_branch_rows[j_idx] as usize;
        marker[br_i * size + br_j] = 1;
        p += 3;
    }
    // Transistor stamp positions — all 9 pairs of (B, C, E).
    for ti in 0..transistor_count {
        for a_off in 0..3 {
            let ri = transistor_node_indices[ti * 3 + a_off];
            if ri < 0 {
                continue;
            }
            for b_off in 0..3 {
                let rj = transistor_node_indices[ti * 3 + b_off];
                if rj < 0 {
                    continue;
                }
                marker[(ri as usize) * size + (rj as usize)] = 1;
            }
        }
    }
    // Diode stamp positions.
    for di in 0..diode_count {
        let ai = diode_node_indices[di * 2];
        let ki = diode_node_indices[di * 2 + 1];
        if ai >= 0 {
            marker[(ai as usize) * size + (ai as usize)] = 1;
        }
        if ki >= 0 {
            marker[(ki as usize) * size + (ki as usize)] = 1;
        }
        if ai >= 0 && ki >= 0 {
            marker[(ai as usize) * size + (ki as usize)] = 1;
            marker[(ki as usize) * size + (ai as usize)] = 1;
        }
    }

    let sparse_pattern = analyze_pattern(&marker, size);

    Some(CompiledNetlist {
        non_ground_nodes,
        node_index,
        n,
        m,
        size,
        matrix: vec![0.0; size * size],
        rhs: vec![0.0; size],
        base_matrix: vec![0.0; size * size],
        base_rhs: vec![0.0; size],
        static_stamps,
        gmin_indices,
        cap_stamp_indices,
        cap_count,
        inductor_node_indices,
        inductor_branch_rows,
        inductor_count,
        inductor_coupling_pairs,
        transistor_node_indices,
        transistor_count,
        diode_node_indices,
        diode_count,
        voltage_source_branch_rows,
        voltage_source_node_indices,
        voltage_source_values,
        sparse_pattern,
        elements: netlist.elements.clone(),
        resistor_indices,
        capacitor_indices,
        inductor_indices,
        voltage_source_indices,
        transistor_indices,
        diode_indices,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::netlist::Element;

    /// Simple RC: 5 V source through 1 kΩ to 1 µF cap, both returning to ground.
    /// Two non-ground nodes: source-positive (1) and the resistor/cap node (2).
    fn rc_netlist() -> Netlist {
        let mut nl = Netlist::new(0);
        nl.push(Element::VoltageSource {
            id: "V1".into(), positive_node: 1, negative_node: 0, voltage: 5.0,
        });
        nl.push(Element::Resistor {
            id: "R1".into(), a: 1, b: 2, resistance_ohms: 1_000.0,
        });
        nl.push(Element::Capacitor {
            id: "C1".into(), a: 2, b: 0, capacitance_farads: 1e-6, initial_voltage: 0.0,
        });
        nl
    }

    #[test]
    fn rc_compile_sizes_match_expected() {
        let nl = rc_netlist();
        let c = compile_netlist(&nl).unwrap();
        assert_eq!(c.n, 2);                              // 2 non-ground nodes
        assert_eq!(c.m, 1);                              // 1 voltage source
        assert_eq!(c.inductor_count, 0);
        assert_eq!(c.cap_count, 1);
        assert_eq!(c.transistor_count, 0);
        assert_eq!(c.diode_count, 0);
        assert_eq!(c.size, 3);                           // n + m + inductors
        assert_eq!(c.sparse_pattern.n, 3);
    }

    #[test]
    fn rc_static_stamps_present() {
        let nl = rc_netlist();
        let c = compile_netlist(&nl).unwrap();
        // Resistor (both nodes non-ground) → 4 triples.
        // Voltage source (negative terminal = ground) → 2 triples (the
        // two ground-side incidence entries are filtered).
        // 6 triples × 3 floats = 18 entries.
        assert!(
            c.static_stamps.len() >= 18,
            "static stamps len = {}",
            c.static_stamps.len(),
        );
        assert!(c.static_stamps.len() % 3 == 0, "static stamps not in triples");
    }
}
