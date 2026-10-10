# R1 — Adversarial security review (the other model)

> **給 Jeff**：第三輪（週六晚上，雲端過夜），**只審不改**。週日早上你只修 P0。
> 用「寫了大部分程式的那家」以外的模型來審（大多是 GPT 寫的，就用 Claude Code 跑這張），
> 避開「同一個模型自己寫、自己審」的盲點。

Branch: `review/r1` from `main` · Output: `docs/hackathon/REVIEW.md` only

## Prompt

```
You are a hostile security reviewer. Read AGENTS.md and docs/hackathon/SPEC.md (§3 invariants
I1–I11, §5 contracts, §6 limits). Review everything changed on main since commit c14496d.

Your job is to find ways money can move, or secrets can leak, that the spec says cannot.
For each finding write to docs/hackathon/REVIEW.md:
- severity: P0 (money can move without an approval, a secret can leak, chain can be forged
  undetected), P1 (fail-open on an error path, wrong decision under realistic input), P2 (other)
- invariant violated (I1–I11)
- file:line
- a concrete failing scenario (inputs → wrong outcome)
- the smallest fix

Specifically try: base58 vs base64 confusion at the checkpoint; batch JSON-RPC with mixed
methods; a tool argument that is a transaction encoded differently than configured; a v0
transaction whose program id index points into lookup keys; an approval signed by the right key
over a different hold's message; replaying an approval; a hold that expires while a forward is
in flight; host cancellation during approval; a downstream that writes to stdout garbage; a
config key that smuggles a secret; error messages that include the upstream URL; numbers like
"1e-3", "0.050000000000000001", "-0"; very large account lists in simulation.

Do not change any code. If you find no P0, say so explicitly and list what you tried.
```
