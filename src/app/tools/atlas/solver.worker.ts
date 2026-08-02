/* Solver worker for the Atlas Selector.
   Deliberately has no `/// <reference lib="webworker" />`: it is compiled under
   the app tsconfig, whose DOM lib would clash with the webworker one. */
import { withoutBlocked, type Graph } from './graph';
import { solveSteiner, type SteinerResult } from './steiner';

export type SolverRequest =
  | { type: 'init'; n: number; offsets: ArrayBuffer; adjacency: ArrayBuffer }
  | {
      type: 'solve';
      id: number;
      terminals: number[];
      /** nodes the route may not pass through */
      blocked?: number[];
      /** tie-break cost per node, only used to choose between equal-size trees */
      penalties?: number[];
      heuristicMs?: number;
      exactMs?: number;
    };

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
    let search = graph;
    if (msg.blocked?.length) {
      const mask = new Uint8Array(graph.n);
      for (const v of msg.blocked) mask[v] = 1;
      // Terminals win over exclusions; the UI keeps them mutually exclusive
      // anyway, but a stale message must not produce an unsolvable graph.
      for (const t of msg.terminals) mask[t] = 0;
      search = withoutBlocked(graph, mask);
    }
    const result = solveSteiner(search, msg.terminals, {
      heuristicMs: msg.heuristicMs,
      exactMs: msg.exactMs,
      penalties: msg.penalties ? Int32Array.from(msg.penalties) : undefined,
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
