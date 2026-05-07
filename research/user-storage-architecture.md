# User Storage Architecture — Saved Patches & Settings

A design for letting users save, manage, export, and import their work
locally today, with a clean migration path to accounts/cloud later.
Companion to `keyboard-instrument.md` and the in-progress patches panel.

---

## 1. What "saving" actually means here

Three different things have been conflated under "settings". They have
different shapes, different lifetimes, and (most importantly) different
*shareability*. We should treat them separately.

| Category        | Contents                                                                | Shareable? | Persists? | v1 priority |
|-----------------|-------------------------------------------------------------------------|------------|-----------|-------------|
| **Patch**       | Pitch material only: ratios + anchor (or freqs), name, author, notes    | Yes        | Yes       | **Primary** |
| **Snapshot**    | Full play state: freqs + volumes + routing + osc count                  | Yes        | Yes       | Secondary   |
| **Preferences** | UI/visual: staticMode, vizMode, kbdKeyMode, fineTune, etc.              | No         | Yes       | Light pass  |

The patches panel design already targets **Patch**. The URL-share flow
(`?f=…&v=…&r=…` in `App.jsx:14`) already covers a one-shot **Snapshot**.
This document focuses on Patch storage with hooks for the other two.

---

## 2. Goals and non-goals

**Goals**
- Users can save the current synth state as a named patch.
- Saved patches survive reload (localStorage v1).
- Users can rename, delete, duplicate, export, import patches.
- Export = a JSON file the user can email/store/share. Import = drop a
  file in or paste JSON.
- Schema is forward-/backward-compatible enough that v1 files keep
  loading after the format evolves.
- Architecture is repository-shaped so swapping localStorage for HTTP
  later doesn't require touching the UI.
- Built-in patches and user patches are presented in one unified list
  but distinguishable.

**Non-goals (explicitly punted)**
- Authentication, cloud sync, multi-device — designed for, not built.
- Sharing patches publicly via URL beyond the current `?f=&v=…` link.
- Encryption at rest. (localStorage is per-origin; we trust the origin.)
- Version history / undo of edits to a patch.
- Bundling audio recordings, MIDI loops, presets-of-presets.

---

## 3. Patch schema (v1)

Single canonical shape used everywhere — in localStorage, in export
files, and (later) in the API. JSON-serializable, no functions.

```jsonc
{
  "schema": "wavetuner.patch.v1",   // versioning anchor
  "id": "usr_01HZ…",                // ULID/UUID, never reused
  "name": "Well-Tuned Piano",
  "author": "La Monte Young",
  "description": "D# = 1/1. 7-limit JI ratios.",
  "source": "user",                 // 'builtin' | 'user' | 'imported' | 'remote'
  "createdAt": "2026-05-07T14:22:11.103Z",
  "updatedAt": "2026-05-07T14:22:11.103Z",

  // Pitch material. Both representations allowed; loader prefers ratios
  // when present (octave-invariant). Either may carry the patch.
  "ratios": [
    { "name": "1/1",     "ratio": 1,           "cents": 0 },
    { "name": "567/512", "ratio": 1.107421875, "cents": 176.65 }
    // …
  ],
  "anchorHz": 297.99,        // suggested Hz for ratio 1/1 at load time
  "rootMidi": 39,            // optional: MIDI note class of the 1/1

  // Optional snapshot fields. Present when the patch was saved from a
  // full session (vs. authored as a pure tuning). Loader uses these to
  // restore volumes/routing in addition to pitches.
  "snapshot": {
    "volumes": [0.5, 0.5, 0.3, 0.3],     // 0..1
    "muted":   [false, false, true, true],
    "routing": { "0": [0], "1": [1], "2": [0, 1], "3": [0, 1] }
  },

  // Free-form, never breaks loading if unknown keys appear.
  "tags": ["just-intonation", "piano"],
  "meta": {}
}
```

### Field policy
- **`schema`**: `wavetuner.<kind>.v<n>`. Always present. Loaders refuse
  records they can't migrate (see §8).
- **`id`**: ULID preferred (sortable by time, lex-comparable). Generated
  client-side. Built-in patches get stable string ids (`builtin_wtp`).
- **`source`**: drives UI grouping. `builtin` is read-only; `user` is
  editable; `imported` starts as a copy of someone else's patch
  (becomes `user` once edited or renamed).
- **`updatedAt`**: ISO 8601 UTC. Used for last-write-wins on later sync.
- **`ratios` vs `anchorHz`**: ratios is the canonical pitch
  representation. `anchorHz` lets the patch land in a specific octave
  on load. If the user only has Hz (e.g. captured from a free-form
  drone state), we serialize as a degenerate ratio list with `1/1` at
  the lowest pitch and ratios derived from the rest.
- **Unknown keys**: must be preserved through load → save round-trips
  (don't strip them). Future fields stay attached.

---

## 4. Storage layout

### 4.1 localStorage keys

Namespaced under `wavetuner.*` so we can wipe everything in one filter
without colliding with other origins on `localhost`/the dev box.

```
wavetuner.schema           "1"                    // top-level schema rev
wavetuner.patches.index    ["usr_…", "usr_…"]     // ordered ids, recent first
wavetuner.patches.<id>     { …Patch JSON… }       // one record per key
wavetuner.preferences      { vizMode: 0, … }      // UI prefs (single blob)
wavetuner.lastLoaded       "usr_…"                // optional, for "resume"
```

Why per-record keys instead of one giant array:
- Mutating one patch doesn't rewrite the whole list (smaller writes,
  less corruption blast radius if a write is interrupted).
- The 5 MB localStorage cap doesn't matter at our payload size, but
  per-key is friendlier to QuotaExceededError fallbacks.
- `storage` events on writes carry the key — cheap multi-tab sync.

The `index` array is the source of truth for ordering. On read, we
hydrate it and lazily fetch each record only when rendered.

### 4.2 Why not IndexedDB

- Patches are tiny (<10 KB each). IDB's async API and migration
  ceremony aren't justified yet.
- Migration to IDB later is straightforward — copy on first read.

### 4.3 Storage availability

localStorage can be disabled (Safari private mode used to wipe it,
embedded webviews sometimes lack it, content blockers can throw on
access). Detect once at boot:

```js
function probeStorage() {
  try {
    const k = '__wavetuner_probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return 'localStorage';
  } catch {
    return 'memory';   // session-only fallback
  }
}
```

When in `memory` fallback, the UI surfaces a passive "Saves won't
persist after reload" notice. Don't block save — users can still
download the file.

---

## 5. Repository abstraction

The single most important architectural piece: **the UI never touches
localStorage directly**. It calls a repository.

```ts
interface PatchRepository {
  list(): Promise<Patch[]>;                       // ordered, builtins included
  get(id: string): Promise<Patch | null>;
  save(patch: Patch): Promise<Patch>;             // creates or updates
  delete(id: string): Promise<void>;
  duplicate(id: string, newName: string): Promise<Patch>;

  // Bulk
  exportAll(): Promise<ExportEnvelope>;
  importEnvelope(env: ExportEnvelope, opts?: ImportOptions): Promise<ImportResult>;

  // Reactive
  subscribe(fn: () => void): () => void;
}
```

Implementations, composable:

- `BuiltinRepository` — read-only, ships with the bundle.
- `LocalStorageRepository` — read/write, wraps `wavetuner.patches.*`.
- `MemoryRepository` — fallback when storage is disabled.
- `RemoteRepository` — added later for cloud sync. Same interface.
- `CompositeRepository` — merges sources for `list()`, dispatches
  `save()` to the right backing store based on `source`/`ownerId`.

The patches panel binds to `useRepository()` (a small React hook
wrapping `subscribe`). Replacing the implementation when accounts ship
is a one-line swap at the provider level.

### Cross-tab consistency

`LocalStorageRepository` listens to `window.storage` events. When a key
under `wavetuner.patches.*` changes, it invalidates its in-memory cache
and notifies subscribers. So saving in tab A updates tab B's panel.

---

## 6. Export / import format

### 6.1 Envelope

A single export file can carry one or many records. Always wrapped:

```jsonc
{
  "schema": "wavetuner.export.v1",
  "exportedAt": "2026-05-07T14:30:00.000Z",
  "exportedBy": "wavetuner@<git-sha>",   // for debugging
  "records": [ /* …Patch v1 objects… */ ]
}
```

### 6.2 File extension and MIME

- Single patch: `<slug-of-name>.wavetuner-patch.json`
  e.g. `well-tuned-piano.wavetuner-patch.json`
- Bulk: `wavetuner-patches-<yyyy-mm-dd>.json`
- MIME: `application/json` (browsers won't add anything custom; that's
  fine).

The `.wavetuner-patch.json` double-suffix is so the file shows up as
"JSON" everywhere but is searchable/filterable as ours.

### 6.3 Importing

```ts
type ImportOptions = {
  // 'skip' | 'overwrite' | 'duplicate'
  // duplicate = generate new id, append " (imported)" to the name
  onConflict: 'skip' | 'overwrite' | 'duplicate';
};

type ImportResult = {
  imported: Patch[];
  skipped: Patch[];          // ids that already existed and onConflict='skip'
  errors: Array<{ index: number; message: string }>;
};
```

Three input paths:
- **File picker** — `<input type="file" accept=".json,application/json">`.
- **Drag-and-drop** onto the patches panel.
- **Paste JSON** — modal with a textarea (handy for sharing in chat).

Validation is layered: envelope shape → record schema → ratios sanity
(positive numbers, finite, ≤ a few hundred entries). Bad records are
collected and reported, not thrown.

### 6.4 ID conflicts

`id` is supposed to be globally unique, so a real conflict on import
means either re-importing the user's own export (legitimate), or two
people with the same id (unlikely with ULIDs). Default `onConflict =
'duplicate'` — never silently overwrite the user's local copy.

---

## 7. UI surface (sketch)

In the patches panel built in the prior plan:

- **Save current as patch** — button at the top. Opens a small inline
  form: name, optional author/description, then `Save`. Captures
  current osc state via `audioEngine.getAllFrequencies()` /
  `getAllVolumes()` / `getRoutingMap()`.
- **Yours** section — user patches sorted by `updatedAt` desc. Each
  row: name, ratio count, "Load", overflow menu (rename, duplicate,
  export, delete).
- **Built-in** section — read-only.
- **Bulk** menu (footer): `Export all…`, `Import…`.
- **Empty state** — "No saved patches yet. Hit *Save current as patch*
  to start your library."
- **Inline confirmations** — delete asks once; rename is in-place edit.
- **Toasts** for export/import results: "Imported 3 patches, skipped
  1 duplicate."

Keyboard shortcuts intentionally omitted in v1; the panel is mouse-led.

---

## 8. Schema migration policy

The biggest long-term risk: a v1 record sitting in someone's browser
becomes uninterpretable two iterations from now. Rules of the road:

1. **Every record carries `schema`.** Loader dispatches on it.
2. **Migrators are pure functions** `vN → vN+1`. We only ever write
   migrators forward; we never need to downgrade.
3. **Lazy migration on read.** When the loader sees an older schema,
   it migrates in memory and immediately writes back the upgraded
   record. No global "migrate everything at boot" pass — keeps cold
   start fast and avoids touching records the user never opens.
4. **Field additions are non-breaking.** Old loaders ignore unknown
   keys; new loaders default-fill missing keys.
5. **Field removals require a major bump.** Don't strip; just stop
   reading.
6. **Hard refusal** for records whose schema we don't recognize
   (`wavetuner.patch.v999` from the future) — surface in UI as
   "Saved with a newer version of Wavetuner."

Concrete file layout once we have multiple versions:

```
src/storage/
  schema.ts                 // current schema constants + types
  migrators/
    patch_v1_to_v2.ts
    patch_v2_to_v3.ts
  migrate.ts                // dispatcher
```

---

## 9. Identity and naming

- **id**: ULID (lexicographically sortable, 26 chars, no native dep
  needed — there are tiny libraries or we paste a 30-line generator).
  Built-ins: `builtin_<slug>`. Imported records keep their original
  id unless conflict resolution rewrites it.
- **slug** (derived for filenames): lowercased name, ASCII-only,
  hyphenated, capped at 60 chars. Not stored — recomputed on export.
- **Display name**: `name` field, free-form unicode, capped at maybe
  120 chars in the input (no length validation in storage).

---

## 10. Cloud-readiness checklist

The architecture is shaped so that flipping the cloud switch later is
mechanical:

- [x] Records carry `id`, `createdAt`, `updatedAt` from day one — the
      fields a sync engine needs.
- [x] Records carry `source` — distinguishes local-only vs synced.
- [x] Repository interface unchanged whether backing store is local
      or HTTP.
- [ ] **Add later:** `ownerId` field on records, populated when
      authenticated. Local records before sign-in get rewritten with
      the new owner on first login.
- [ ] **Add later:** `syncState: 'local' | 'syncing' | 'synced' |
      'conflict'` (UI badge).
- [ ] **Add later:** conflict-resolution UI for `updatedAt` collisions
      across devices. v0 strategy: last-write-wins by `updatedAt`,
      with a "view conflict copy" affordance.

### Sign-in merge strategy

When a previously-anonymous user logs in:
1. Read all local user-source patches.
2. POST them to `/api/patches/bulk` as new records owned by the
   account, generating fresh ids server-side.
3. On success, rewrite local copies with the returned ids and
   `source: 'remote'`.
4. Local-only fallback survives if upload fails — never destroy
   local data.

Sign-out leaves local copies in place. Different account on same
machine: namespace localStorage by `ownerId` (`wavetuner.patches.<owner>.<id>`).

---

## 11. Edge cases and pitfalls

- **QuotaExceededError**: catch on `save`, surface "Storage full —
  export and delete some patches." Don't crash.
- **Corrupted JSON in storage**: wrap each `JSON.parse` in try/catch.
  Log and skip — never let one bad record break `list()`.
- **Race conditions** between tabs: writes are last-write-wins by
  wall-clock. The `storage` event invalidates other tabs; if two
  tabs save the *same* patch within milliseconds, one overwrite is
  acceptable for v1. Optimistic locking via `version` counter is
  punted to the cloud era.
- **Time skew**: `updatedAt` from the client is fine for local-only.
  Server-authoritative timestamps come with the sync layer.
- **Privacy**: patches contain no PII by design. Author/description
  are user-entered free text — when we ship sharing, we should warn
  on first share that those fields will be public.
- **Imported file masquerading as ours**: validate `schema` field
  early. A random JSON file should produce "Not a Wavetuner export."
  not a half-applied import.
- **Built-in id collision**: built-ins use the `builtin_*` prefix.
  Imports with that prefix get rewritten to `usr_*` to prevent
  shadowing the bundled patch.

---

## 12. Phased rollout

**Phase 1 — Local save + the patches panel (the immediate scope)**
- Repository interface + `LocalStorageRepository` + `BuiltinRepository`.
- Save / load / rename / delete / duplicate.
- Built-in WTP patch + 1–2 others.
- Schema versioning anchored at `v1`.

**Phase 2 — Portability**
- Export single, export all, import (file picker + drag-drop).
- Conflict resolution UI.
- Filename slugger.

**Phase 3 — Polish**
- Cross-tab sync via `storage` events.
- Memory-fallback notice when storage is unavailable.
- Patch tags + filtering in the panel.

**Phase 4 — Accounts (much later)**
- `RemoteRepository` + auth.
- Sign-in merge flow.
- Sync state UI.
- Conflict resolution.

Phases 1–3 are all pure client-side work — no server, no auth, no
schema redesign required to unlock them.

---

## 13. Open questions to resolve before coding Phase 1

1. **Snapshot scope** — does "save current state" capture *only* pitch
   material (becomes a Patch) or also volumes/routing/osc count
   (becomes a full Snapshot)? Proposal: save *both* into one record;
   `snapshot` block is optional and the loader honors whichever fields
   are present. This avoids splitting the UI between "save patch" and
   "save snapshot" before we know users want the distinction.
2. **Built-in editing** — is "Duplicate to edit" the right pattern, or
   should the built-in WTP be directly editable (becoming a user copy
   on first save)? Proposal: explicit "Duplicate" — keeps the bundled
   list pristine and obvious.
3. **Preferences** — out of scope for this doc, but worth deciding
   soon: do UI prefs live in the same export envelope as patches?
   Proposal: separate. Preferences are per-device, never shared.
4. **Naming** — "patch" is the term used throughout this doc. The user
   wrote "patches" in the panel design and "settings" in the storage
   ask. We should land on one user-facing word. Proposal: **patch**
   for the saveable unit, **preferences** for UI-only state.
