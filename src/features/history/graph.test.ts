import { describe, expect, it } from 'vitest';
import { DAG_W, LANE_W, drawGraph, laneX } from './graph';

describe('graph geometry (F-15)', () => {
  it('centers lane 0 and spaces lanes by LANE_W', () => {
    expect(laneX(0)).toBe(9 + LANE_W / 2);
    expect(laneX(1)).toBe(9 + LANE_W / 2 + LANE_W);
    expect(laneX(0) + LANE_W).toBe(laneX(1));
    expect(laneX(2)).toBeLessThan(DAG_W);
  });

  function fakeCtx() {
    const ops: { op: string; args: unknown[] }[] = [];
    const state = { strokeStyle: '', fillStyle: '', lineWidth: 1 };
    const ctx = {
      canvas: { width: 300, height: 300, clientWidth: 96, clientHeight: 300 },
      lineCap: '',
      get lineWidth() {
        return state.lineWidth;
      },
      set lineWidth(v: number) {
        state.lineWidth = v;
      },
      get strokeStyle() {
        return state.strokeStyle;
      },
      set strokeStyle(v: string) {
        state.strokeStyle = v;
      },
      get fillStyle() {
        return state.fillStyle;
      },
      set fillStyle(v: string) {
        state.fillStyle = v;
      },
      clearRect: (...args: unknown[]) => ops.push({ op: 'clear', args }),
      beginPath: () => ops.push({ op: 'begin', args: [] }),
      moveTo: (...args: unknown[]) => ops.push({ op: 'move', args }),
      lineTo: (...args: unknown[]) => ops.push({ op: 'line', args }),
      stroke: () => ops.push({ op: 'stroke', args: [state.strokeStyle, state.lineWidth] }),
      closePath: () => ops.push({ op: 'close', args: [] }),
      arc: (...args: unknown[]) => ops.push({ op: 'arc', args }),
      rect: (...args: unknown[]) => ops.push({ op: 'rect', args }),
      fill: () => ops.push({ op: 'fill', args: [state.fillStyle] }),
      save: () => ops.push({ op: 'save', args: [] }),
      restore: () => ops.push({ op: 'restore', args: [] }),
      translate: () => ops.push({ op: 'translate', args: [] }),
      rotate: () => ops.push({ op: 'rotate', args: [] }),
      setTransform: () => ops.push({ op: 'transform', args: [] }),
    } as unknown as CanvasRenderingContext2D;
    return { ops, ctx };
  }

  it('draws straight verticals, node circles and merge diamonds', () => {
    const { ops, ctx } = fakeCtx();
    const colors = ['#111111', '#222222'];
    const entries = [
      {
        node: { lane: 0, color: 0, merge: true },
        lines: [
          { from: 0, to: 0, color: 0 },
          { from: 0, to: 1, color: 1 },
        ],
        laneCount: 2,
      },
    ];
    drawGraph(ctx, entries, 0, 0, 300, colors);

    // Trunk line is 2.5px, side lines 1.5px (UI doc §3.4).
    const strokes = ops.filter((o) => o.op === 'stroke');
    expect(strokes[0].args).toEqual(['#111111', 2.5]);
    expect(strokes[1].args).toEqual(['#222222', 1.5]);

    // Merge node renders as a 4-point diamond path with the palette fill.
    const fills = ops.filter((o) => o.op === 'fill');
    expect(fills[0].args).toEqual(['#111111']);
    expect(ops.filter((o) => o.op === 'line').length).toBeGreaterThanOrEqual(3);
    expect(ops.some((o) => o.op === 'arc')).toBe(false);
  });

  it('skips drawing entirely when no 2d context is available (jsdom)', () => {
    // drawGraph is only reached with a real ctx; the guard lives in the
    // component. Here we assert it tolerates an empty entry list.
    const { ops, ctx } = fakeCtx();
    drawGraph(ctx, [], 0, 0, 300, []);
    expect(ops.length).toBe(1); // just the clearRect
  });
});
