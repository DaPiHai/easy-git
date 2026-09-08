/**
 * DAG canvas geometry (UI doc §6.7): 30px rows, 96px graph column, 8px nodes,
 * merge diamonds, 8-color branch palette. Pure helpers are unit-tested; the
 * canvas draw is guarded so jsdom (no 2d context) renders nothing.
 */

export const ROW_H = 30;
export const DAG_W = 96;
export const LANE_W = 13;
export const NODE_R = 4;
export const OVERSCAN_ROWS = 15;

/** Lane center X inside the 96px graph column. */
export function laneX(lane: number): number {
  return 9 + LANE_W / 2 + lane * LANE_W;
}

/** Resolves the 8 palette entries to concrete colors for the active theme. */
export function branchColors(): string[] {
  const styles = getComputedStyle(document.documentElement);
  return Array.from(
    { length: 8 },
    (_, i) => styles.getPropertyValue(`--eg-branch-${i + 1}`).trim() || '#5e6ad2',
  );
}

interface Node {
  lane: number;
  color: number;
  merge: boolean;
}

interface Line {
  from: number;
  to: number;
  color: number;
}

interface Entry {
  node: Node;
  lines: Line[];
  laneCount: number;
  isHead?: boolean;
}

function strokeStyle(ctx: CanvasRenderingContext2D, line: Line, colors: string[]): void {
  ctx.strokeStyle = colors[line.color % colors.length] ?? colors[0];
  // UI doc §3.4: the current-branch trunk (color 0) draws 2.5px, rest 1.5px.
  ctx.lineWidth = line.color === 0 ? 2.5 : 1.5;
}

/** Draws the graph for entries[offset..offset+count] at their absolute rows. */
export function drawGraph(
  ctx: CanvasRenderingContext2D,
  entries: Entry[],
  startIndex: number,
  viewportTop: number,
  viewportHeight: number,
  colors: string[],
): void {
  ctx.clearRect(0, 0, ctx.canvas.clientWidth, viewportHeight);

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const rowIndex = startIndex + i;
    const top = rowIndex * ROW_H - viewportTop;
    const bottom = top + ROW_H;
    if (bottom < 0 || top > viewportHeight) continue;
    const mid = top + ROW_H / 2;
    const nodeLaneX = laneX(entry.node.lane);

    ctx.lineCap = 'round';
    for (const line of entry.lines) {
      const xFrom = laneX(line.from);
      const xTo = laneX(line.to);
      strokeStyle(ctx, line, colors);
      ctx.beginPath();
      if (line.from === line.to) {
        // Straight vertical through the row.
        ctx.moveTo(xFrom, top);
        ctx.lineTo(xTo, bottom);
      } else if (line.to === entry.node.lane) {
        // Joins into the node from above (fork coalescing).
        ctx.moveTo(xFrom, top);
        ctx.lineTo(xTo, mid);
      } else if (line.from === entry.node.lane) {
        // Merge line from the node down to the parent lane.
        ctx.moveTo(xFrom, mid);
        ctx.lineTo(xTo, bottom);
      } else {
        // Lane slid left after termination: full-height diagonal.
        ctx.moveTo(xFrom, top);
        ctx.lineTo(xTo, bottom);
      }
      ctx.stroke();
    }

    // Node: 8px circle, 12px diamond for merges (visually distinct at row
    // scale), ink ring on HEAD (UI doc §6.7).
    const color = colors[entry.node.color % colors.length] ?? colors[0];
    ctx.fillStyle = color;
    ctx.beginPath();
    if (entry.node.merge) {
      const r = NODE_R + 2;
      ctx.moveTo(nodeLaneX, mid - r);
      ctx.lineTo(nodeLaneX + r, mid);
      ctx.lineTo(nodeLaneX, mid + r);
      ctx.lineTo(nodeLaneX - r, mid);
      ctx.closePath();
    } else {
      ctx.arc(nodeLaneX, mid, NODE_R, 0, Math.PI * 2);
    }
    ctx.fill();
    if (entry.isHead) {
      const ink =
        getComputedStyle(document.documentElement).getPropertyValue('--eg-ink').trim() || '#f0f0f0';
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (entry.node.merge) {
        // Halo matches the node shape so merges keep their diamond silhouette.
        const r = NODE_R + 5;
        ctx.moveTo(nodeLaneX, mid - r);
        ctx.lineTo(nodeLaneX + r, mid);
        ctx.lineTo(nodeLaneX, mid + r);
        ctx.lineTo(nodeLaneX - r, mid);
        ctx.closePath();
      } else {
        ctx.arc(nodeLaneX, mid, NODE_R + 3, 0, Math.PI * 2);
      }
      ctx.stroke();
    }
  }
}
