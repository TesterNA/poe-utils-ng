/* Search worker for the Voyage Builder.

   One worker runs one search, and the builder starts several at once — they
   walk the same recipes in different orders, so they agree on how many
   Voyages a stash is worth and differ on how to lay them out.

   Deliberately has no `/// <reference lib="webworker" />`: it is compiled
   under the app tsconfig, whose DOM lib would clash with the webworker one. */
import { Policy, recipes } from './voyage-rules';
import { Plan, planAttempt } from './voyage-solver';

export interface SearchRequest {
  /** which press this belongs to, so a stale answer can be dropped */
  id: number;
  /** which walk order to use; the same number always gives the same plan */
  attempt: number;
  stock: number[];
  policy: Policy;
  budgetMs: number;
}

export interface SearchResponse {
  id: number;
  attempt: number;
  plan: Plan;
}

addEventListener('message', (event: MessageEvent<SearchRequest>) => {
  const request = event.data;
  // the recipes are worked out once per worker and kept by `voyage-rules`
  const plan = planAttempt(
    request.stock,
    recipes(request.policy),
    request.attempt,
    request.budgetMs,
  );

  post({ id: request.id, attempt: request.attempt, plan });
});

function post(message: SearchResponse): void {
  // typed through Worker because the app tsconfig also pulls in the DOM lib,
  // where the bare postMessage signature is window's two-argument one
  (self as unknown as Worker).postMessage(message);
}
