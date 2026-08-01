/* Solver worker for the Atlas Selector.
   Deliberately has no `/// <reference lib="webworker" />`: it is compiled under
   the app tsconfig, whose DOM lib would clash with the webworker one. */
import type { Graph } from './graph';
import { solveSteiner, type SteinerResult } from './steiner';

export type SolverRequest =
  | { type: 'init'; n: number; offsets: ArrayBuffer; adjacency: ArrayBuffer }
  | { type: 'solve'; id: number; terminals: number[]; heuristicMs?: number; exactMs?: number };

export type SolverResponse =
  | { type: 'ready' }
  | { type: 'progress'; id: number; phase: string; fraction: number }
  | { type: 'result'; id: number; result: SteinerResult };

let graph: Graph | null = null;
let latest = 0;

addEventListener('message', (ev: MessageEvent<SolverRequest>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    graph = {
      n: msg.n,
      offsets: new Int32Array(msg.offsets),
      adjacency: new Int32Array(msg.adjacency),
    };
    post({ type: 'ready' });
    return;
  }
  if (msg.type === 'solve') {
    if (!graph) return;
    latest = msg.id;
    const result = solveSteiner(graph, msg.terminals, {
      heuristicMs: msg.heuristicMs,
      exactMs: msg.exactMs,
      onProgress: (phase, fraction) => {
        // A newer request arrived — stop reporting for the stale one.
        if (msg.id === latest) post({ type: 'progress', id: msg.id, phase, fraction });
      },
    });
    post({ type: 'result', id: msg.id, result });
  }
});

function post(m: SolverResponse): void {
  // typed through Worker because the app tsconfig also pulls in the DOM lib,
  // where the bare postMessage signature is window's two-argument one
  (self as unknown as Worker).postMessage(m);
}
