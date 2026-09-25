# Manual End-to-End Verification

This procedure is intentionally NOT part of automated CI — it exercises a real
agentic CLI (cost, non-determinism), matching the spec's Testing Strategy.

1. In a scratch git repository with a trivial Node project and a passing
   `npm test`, write a one-paragraph markdown request file describing a small,
   real change (e.g. "add a GET /health endpoint returning 200").
2. Set `sdlc.config.json`: `{ "verifyCommand": "npm test", "mergeMode": "manual" }`.
3. Run `sdlc autopilot --input request.md` with `providerCommand` pointed at a
   real agentic CLI (e.g. `claude`).
4. Confirm: a run directory appears under `.sdlc/<runId>/`; `sdlc status --run
   <runId>` shows at least one slice; the workspace worktree
   (`.sdlc/<runId>/workspace`) contains real code changes on a
   `sdlc/slice/<runId>/<sliceId>` branch; the command exits reporting either
   completion or a clear blocked reason (e.g. manual-mode `ready_to_merge`).
5. If blocked on `ready_to_merge`, manually merge the slice branch into `main`
   and run `sdlc resume --run <runId>`; confirm it detects the manual merge
   and either completes or advances to the next slice.
6. Record any prompt-quality issues (vague implement/review prompts, a
   reviewer that rubber-stamps) as follow-up work — this plan's prompts in
   `src/orchestrator/prompts.ts` and `review-step.ts` are a v1 starting point,
   not tuned.
