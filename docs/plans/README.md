# Plans

Point-in-time implementation plans. Unlike specs (living contracts in
`../specs/`), a plan is **ephemeral**: it describes a rollout and is expected to
go stale once the work ships.

- **Active plan** → lives here at the top level.
- **Shipped / abandoned plan** → move to `archive/`. It stays for the historical
  record but must never be mistaken for a current contract.

Do not treat anything in this folder as a source of truth. The canonical spec is
`../SPEC.md`; per-capability contracts live in `../specs/`.
