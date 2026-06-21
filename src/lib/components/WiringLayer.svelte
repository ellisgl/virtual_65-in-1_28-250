<script lang="ts">
    import {TERMINAL_POSITIONS} from '$lib/data';
    import type {Wire, DragState} from '$lib/types';

    interface Props {
        wires: Wire[];
        drag: DragState;
        onRemoveWire: (wireId: string) => void;
    }

    let {wires, drag, onRemoveWire}: Props = $props();

    const SVG_UNITS_PER_CM = 11;

    // Cubic bezier with a natural sag and stiffness.
    // Clamped to the board's viewBox (437x267).
    function wirePath(fx: number, fy: number, tx: number, ty: number, lengthCm?: number, shapingPoints?: Array<{x: number, y: number}>): string {
        // If we have shaping points, we draw a path passing through all of them.
        // For simplicity and to match the "shaping" idea, we'll use a smooth curve (catmull-rom or simple quadratic chain).
        // Actually, the user expects to "bend" the wire.
        if (shapingPoints && shapingPoints.length > 0) {
            let path = `M ${fx} ${fy}`;
            const pts = [{x: fx, y: fy}, ...shapingPoints, {x: tx, y: ty}];
            
            // Draw segments. For now, let's use quadratic segments for simplicity and "stiffness"
            for (let i = 0; i < pts.length - 1; i++) {
                const p1 = pts[i];
                const p2 = pts[i+1];
                const midX = (p1.x + p2.x) / 2;
                const midY = (p1.y + p2.y) / 2;
                // Add a tiny bit of sag to each segment if it's the only segment? 
                // No, shaping points are meant to define the shape.
                path += ` Q ${p1.x} ${p1.y} ${midX} ${midY}`;
            }
            const last = pts[pts.length - 1];
            path += ` L ${last.x} ${last.y}`;
            return path;
        }

        const dx = tx - fx;
        const dy = ty - fy;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // ViewBox boundaries
        const VW = 437;
        const VH = 267;

        // SVG_UNITS_PER_CM is 11.

        let sagX = 0;
        let sagY = 0;

        if (lengthCm) {
            const lengthUnits = lengthCm * SVG_UNITS_PER_CM;
            if (lengthUnits > dist) {
                // Total sag amplitude
                const sagAmp = Math.sqrt((3 / 16) * (lengthUnits * lengthUnits - dist * dist));

                // Determine sag direction.
                // If the wire is mostly vertical, we push it to the side (stiffness).
                // If it's mostly horizontal, it sags down (gravity).
                const isVertical = Math.abs(dy) > Math.abs(dx);

                if (isVertical) {
                    // Push to the right if we are on the left side, or if from-to is generally left-to-right.
                    // For the capacitors at x=68, pushing right (to ~100+) is better as it stays in the gutter.
                    // If we are on the far right (x > 300), we push left.
                    const avgX = (fx + tx) / 2;
                    const direction = avgX > 250 ? -1 : 1;

                    // Increase horizontal push for vertical wires to avoid terminals.
                    // The distance between capacitor columns (68 and 98) is 30 units.
                    // A push of at least 20-30 units is needed to clear intermediate terminals.
                    sagX = Math.max(sagAmp * 0.7, 25) * direction;
                    sagY = sagAmp * 0.1; // very slight downward gravity
                } else {
                    sagX = 0;
                    sagY = sagAmp;
                }

                // Cap sag to avoid extreme loops
                const maxAllowedSag = 150;
                if (Math.abs(sagX) > maxAllowedSag) sagX = maxAllowedSag * Math.sign(sagX);
                if (Math.abs(sagY) > maxAllowedSag) sagY = maxAllowedSag * Math.sign(sagY);
            } else {
                sagY = dist * 0.05; // almost taut
            }
        } else {
            sagY = Math.min(dist * 0.25, 18);
        }

        // Cubic Bezier control points
        // We want the wire to 'exit' the terminal somewhat perpendicularly or with a curve.
        // For a more natural 'stiff wire' look, we should apply different offsets to cp1 and cp2
        // depending on the direction of the connection.

        let cp1x = fx;
        let cp1y = fy;
        let cp2x = tx;
        let cp2y = ty;

        if (Math.abs(dy) > Math.abs(dx)) {
            // Vertical connection: control points are offset horizontally
            cp1x = fx + sagX;
            cp2x = tx + sagX;
            // Add a bit of vertical 'spread' to the control points so it's not a flat U shape
            // For longer wires, we increase the spread to make it look more like a stiff loop.
            const verticalSpread = Math.min(Math.abs(dy) * 0.4, 40);
            if (fy < ty) {
                cp1y = fy + verticalSpread + sagY;
                cp2y = ty - verticalSpread + sagY;
            } else {
                cp1y = fy - verticalSpread + sagY;
                cp2y = ty + verticalSpread + sagY;
            }
        } else {
            // Horizontal connection: control points are offset vertically
            cp1y = fy + sagY;
            cp2y = ty + sagY;
            // Add horizontal spread
            const horizontalSpread = Math.min(Math.abs(dx) * 0.3, 20);
            if (fx < tx) {
                cp1x = fx + horizontalSpread + sagX;
                cp2x = tx - horizontalSpread + sagX;
            } else {
                cp1x = fx - horizontalSpread + sagX;
                cp2x = tx + horizontalSpread + sagX;
            }
        }

        // Final boundary clamping to ensure wires stay within the board
        const margin = 2; // Keep slightly inside the edge
        cp1x = Math.max(margin, Math.min(VW - margin, cp1x));
        cp1y = Math.max(margin, Math.min(VH - margin, cp1y));
        cp2x = Math.max(margin, Math.min(VW - margin, cp2x));
        cp2y = Math.max(margin, Math.min(VH - margin, cp2y));

        return `M ${fx} ${fy} C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${tx} ${ty}`;
    }

    function handleWireContextMenu(e: MouseEvent, wireId: string) {
        e.preventDefault();
        e.stopPropagation();
        onRemoveWire(wireId);
    }
</script>
<g class="wiring-layer">
    {#each wires as wire (wire.id)}
        {@const from = TERMINAL_POSITIONS[wire.fromTerminal]}
        {@const to = TERMINAL_POSITIONS[wire.toTerminal]}
        {#if from && to}
            <!-- Wire shadow for depth -->
            <path
                    class="wire-shadow"
                    d={wirePath(from.x, from.y + 0.4, to.x, to.y + 0.4, wire.lengthCm, wire.shapingPoints)}
            />
            <!-- Wire itself -->
            <path
                    class="wire"
                    stroke={wire.color}
                    d={wirePath(from.x, from.y, to.x, to.y, wire.lengthCm, wire.shapingPoints)}
                    role="button"
                    tabindex="0"
                    aria-label={`Wire from terminal ${wire.fromTerminal} to ${wire.toTerminal}`}
                    oncontextmenu={(e) => handleWireContextMenu(e, wire.id)}
            >
                <title>Wire {wire.fromTerminal}–{wire.toTerminal} (right-click to remove)</title>
            </path>
        {/if}
    {/each}
    {#if drag.active && drag.fromTerminal !== null}
        {@const from = TERMINAL_POSITIONS[drag.fromTerminal]}
        {#if from}
            <path
                    class="wire ghost"
                    d={wirePath(from.x, from.y, drag.currentX, drag.currentY, undefined, drag.shapingPoints)}
            />
        {/if}
    {/if}
</g>
<style>
    .wire {
        fill: none;
        stroke-width: 1.2;
        stroke-linecap: round;
        cursor: pointer;
        pointer-events: stroke;
    }

    .wire:hover {
        stroke-width: 2;
        filter: brightness(1.4);
    }

    .wire.ghost {
        stroke: #ffffff;
        stroke-width: 1;
        stroke-dasharray: 3 2;
        opacity: 0.7;
        pointer-events: none;
        cursor: none;
    }

    .wire-shadow {
        fill: none;
        stroke: rgba(0, 0, 0, 0.35);
        stroke-width: 1.6;
        stroke-linecap: round;
        pointer-events: none;
    }
</style>
