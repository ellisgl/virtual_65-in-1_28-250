//! Pure-Rust simulation kernels for the virtual 65-in-1 kit.
//!
//! This crate is a faithful port of the TypeScript simulator in
//! `src/lib/sim/`.  Each algorithm here has a matching test that produces
//! the same numerical output (within floating-point tolerance) as the
//! reference TypeScript implementation.
//!
//! Layering
//! --------
//! - `sparse`    — symbolic + numeric sparse LU, Minimum-Degree reordering.
//!                 No element types here; pure linear algebra.
//! - (later)    — element types, MNA stamping, Newton solver, BDF-2 loop.
//!
//! The crate is intentionally `no_std`-friendly except where Vec is needed
//! for variable-length scratch.  Future work could replace those with
//! statically-sized buffers passed in by the caller.

pub mod sparse;
pub mod types;
pub mod diode;
pub mod transistor;
pub mod netlist;
pub mod linear;
pub mod compile;
pub mod transient;
