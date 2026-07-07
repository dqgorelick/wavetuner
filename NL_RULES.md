# Natural-Language Rules — Spec / Plan (prototype)

Type a musical heuristic in plain English — "two ascending notes transition
together", "the bass always leaves last", "big jumps step instead of glide" —
and it becomes a **rule-set** the GenerativeConductor obeys. Rule-sets are made
of inspectable **building blocks**, live in a **library**, and can be toggled
and composed per transition.

Sibling spec to GENERATIVE.md (the conductor this drives) and PARAMETER_LOCK.md.
Ownership: same as generative — user builds all of it.

---

## 1. The lingo (what this pattern is called)

This is **not** a runtime agent. The LLM never plays music, never runs during a
transition, and is never in the audio path. The established names for the
pattern:

- **LLM-as-compiler** (also "generate-then-execute" / "semantic compilation") —
  the model translates natural language into a machine-checkable artifact
  ONCE, at authoring time. The artifact — not the model — runs at playback.
- **DSL (domain-specific language)** — the artifact's target: our building-block
  vocabulary is a tiny declarative DSL for transition heuristics.
- **Structured outputs** — the Claude API feature that forces the model's reply
  to validate against a JSON Schema (`output_config.format`, or
  `client.messages.parse()` + a zod schema in the TS SDK). This is what makes
  the compile step reliable: the response IS the rule JSON, guaranteed parseable.
- **Tool use / function calling** — the sibling mechanism (model "calls" a
  function whose args match a schema). For a single-shot compile, structured
  outputs is the simpler fit; tool use becomes relevant later if the authoring
  flow turns conversational ("make it subtler" → model edits the rule-set).

So the one-line pitch: *a natural-language front door onto a rule DSL, compiled
by Claude via structured outputs, executed by a deterministic rule engine
inside the conductor.*

```
AUTHORING (LLM, seconds, once per rule)          PLAYBACK (deterministic, every plan)
┌─────────────────────────────────────┐          ┌──────────────────────────────┐
│ user types NL rule                  │          │ conductor.plan()             │
│   ↓                                 │          │   ↓ hooks H1–H5              │
│ Claude (structured outputs)         │  saved   │ RuleEngine.apply(blocks,     │
│   ↓ validates against block schema  │ ───────▶ │   facts) — pure function,    │
│ rule-set JSON (building blocks)     │  to lib  │   no network, no LLM         │
│   ↓ shown as chips, user approves   │          │   ↓                          │
└─────────────────────────────────────┘          │ plan rows show which rules   │
                                                 │ fired (peek under the hood)  │
                                                 └──────────────────────────────┘
```

---

## 2. Building blocks — the DSL (v0)

A **rule-set** is a named list of **rules**; a rule is `when` (conditions over
facts) → `then` (actions on hooks). Everything is plain JSON — inspectable,
hand-editable, diffable. The NL source string is kept on the rule so the
library stays human-readable.

### 2.1 Hook points (where actions land)

These are exactly the five decisions `plan()` already makes
(GenerativeConductor.js:175 — filter → order → depart → mode → duration):

| Hook | plan() decision | Example action |
|---|---|---|
| `H1 select` | which voices move / are excluded | "never move voice 0" |
| `H2 order`  | `_orderMovers` — who leaves in what order | "bass leaves last" |
| `H3 depart` | departure offsets across `spreadMs` | "risers leave together" |
| `H4 mode`   | glide \| step coin (`stepProbability`) | "big jumps always step" |
| `H5 duration` | glide/step time from the distance ranges | "far notes take 2× longer" |

### 2.2 Facts (what conditions can read)

Per-mover facts, all already computed in `plan()`:

| Fact | Type | Source |
|---|---|---|
| `direction` | `up \| down` | `sign(Δ)` |
| `distanceCents` | number | `1200·|Δ|` |
| `voice` | 0..3 | mover index |
| `isLowestTarget` / `isHighestTarget` | bool | rank of `toHz` |
| `fromSlot` / `toSlot` | `I..V` | staged/current slot names |

Aggregate facts (whole-transition): `moverCount`, `riserCount`, `fallerCount`.

### 2.3 Actions (v0 — keep it to six)

| Action | Hook | Payload |
|---|---|---|
| `exclude` | H1 | — (voice never departs; conductor's silent-retune guard still applies) |
| `setOrder` | H2 | `first \| last` (relative position among movers) |
| `group` | H3 | `together \| opposed` (same depart slot / opposite ends of spread) |
| `setMode` | H4 | `glide \| step` (overrides the coin for matching movers) |
| `scaleDuration` | H5 | factor 0.25–4 (multiplies the distance-mapped time) |
| `setDuration` | H5 | absolute ms (clamped to the knob range) |

### 2.4 Rule shape

```json
{
  "id": "r_ascend_together",
  "source": "two ascending notes should transition together",
  "when": [
    { "fact": "direction", "op": "eq", "value": "up" },
    { "fact": "riserCount", "op": "gte", "value": 2 }
  ],
  "then": [ { "action": "group", "value": "together" } ],
  "priority": 50
}
```

- `when` is AND-only in v0 (the compiler splits an OR into two rules).
- `op` ∈ `eq | neq | gt | gte | lt | lte`.
- **Conflicts**: higher `priority` wins per (voice, hook); ties → later rule in
  the set wins; a conflict is logged, never an error. The plan's debug rows get
  a `rules: [ids]` annotation per move so the visualizer can show exactly which
  blocks fired — the "peek under the hood" requirement.

### 2.5 Rule-set + library

```json
{
  "id": "rs_01",
  "name": "gentle voice-leading",
  "createdAt": 1780000000000,
  "enabled": true,
  "rules": [ ... ]
}
```

Persisted as `nlRuleSets` in localStorage (same pattern as save slots / the
conductor config). Multiple sets can be enabled at once — the engine
concatenates enabled sets' rules and resolves by priority. Later: export/import
with patches, so rule-sets travel with a saved patch.

---

## 3. The compiler call (Claude API)

One request per authored rule (or per edit). Model: `claude-opus-4-8`.

- **System prompt** = the DSL spec: the facts table, actions table, JSON shape,
  and 4–6 worked examples (NL → blocks). This is static → prompt-cached.
- **User turn** = the typed rule + live context (voice count, slot names,
  current knob ranges) so "the bass" or "save III" resolve to facts.
- **Structured outputs** (`client.messages.parse()` + `zodOutputFormat`, or raw
  `output_config: {format: {type: "json_schema", schema}}`) — the response
  validates against the rule-set schema before we ever touch it.
- The schema includes an `unsupported: string[]` field: anything the request
  asks for that the vocabulary can't express comes back named ("wants volume
  changes — no volume hook yet") instead of silently mis-compiled. That list is
  the roadmap for growing the DSL.
- Cost/latency: one call, a few seconds, ~1–2k tokens. Zero runtime cost —
  transitions stay fully offline/deterministic.

## 4. Front-end ↔ API wiring

Two stages:

1. **Prototype (now)** — call the API directly from the browser with
   `@anthropic-ai/sdk`: `new Anthropic({ apiKey, dangerouslyAllowBrowser: true })`.
   The key is pasted by the user into a settings field and kept in
   localStorage. Fine for a personal instrument on localhost; the flag exists
   precisely because shipping a key to arbitrary visitors is unsafe.
2. **Later** — a thin proxy (a single serverless function or a Vite/Express
   endpoint) that holds the key server-side and forwards `{nl, context}` →
   compile call → rule JSON. The front-end code barely changes (swap the SDK
   call for a `fetch('/api/compile-rule')`).

## 5. UI surface (throw-away, like GenerativePanel)

A **Rules** section in the GenerativePanel (or a sibling panel):

- Text input + "Compile" → spinner → the returned blocks render as **chips**
  (`direction=up ∧ riserCount≥2 → group:together`) under the original NL text.
  Accept adds it to the active set; nothing is applied without approval.
- Library list: rule-sets with enable toggles, expand to see rules → blocks;
  per-rule enable; delete; rename.
- Plan rows (§4.4b visualizer) gain a rule annotation: `▶ v0 … glide 6.0s
  [r_ascend_together]` — every generative decision traceable to a block or to
  the base knobs.
- `unsupported` items from the compiler render as a yellow note on the rule.

## 6. Prototype build order

0. ✅ (2026-07-04) **Hand-built rules v0, simplified**: no engine yet — each
   rule is a config-level probability slider in a "rules" section of the
   GenerativePanel (below Step time; becomes a tab if the list grows). One
   coin per rule per plan(); fired rules recorded on `plan.rules` and shown in
   the plan header/log. Rule #1: `ruleDirProb` "group ↑/↓ together" (absorbed
   the old `order: same-direction` option; default 100%). The full when/then
   block engine below replaces this shape once rules need conditions.
1. **RuleEngine** (pure JS, no LLM): types + `apply(rules, facts) → overrides`,
   wired into `plan()` at H1–H5 behind a feature flag. Test with 2–3
   hand-written rule-sets — this proves the DSL before any AI exists.
2. **Panel library UI** — render/toggle hand-written sets; rule annotations in
   plan rows.
3. **Compiler** — schema + system prompt + browser SDK call; NL input in the
   panel. (First moment a key is needed.)
4. Grow vocabulary from real `unsupported` feedback; consider conversational
   editing (tool use) once single-shot compiles feel limiting.

## 7. Open decisions (recommended defaults in **bold**)

- **D1 rule scope** — v0 rules apply to every transition; **defer** per-slot-pair
  scoping (`fromSlot`/`toSlot` facts exist, so it's free to add later).
- **D2 conflict UX** — **log-and-win-by-priority** (visible in the event log);
  no blocking conflict dialogs.
- **D3 where rules sit vs knobs** — rules **override** the knob-derived values
  per matching mover; knobs stay the base layer. (Alternative — rules *modulate*
  knobs — revisit if overrides feel too absolute.)
- **D4 compile model** — **claude-opus-4-8**; revisit only if compile latency
  bothers.
