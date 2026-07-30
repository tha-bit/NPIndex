# AI Coding Agent Instructions

## Project Context

Noun Phrase Index is a React 18 single-page research application built with Vite. It explores cross-linguistic noun phrase data stored in Supabase and exposes the data through several client-side views.

Most application behavior is intentionally concentrated in `src/app.jsx`. Read the nearest relevant component and helper before making changes. The project has no application server and no automated test script; `npm run build` is the primary executable validation.

## Architecture Rules

- Keep Supabase access in the existing `sb` data helper. Do not introduce a second data-access abstraction for a local feature.
- Preserve the existing Supabase REST/PostgREST query style, encoding values with `enc` before inserting them into paths.
- Reuse shared helpers and components:
  - `buildSearchFilter` owns search-operator parsing for both phrase search and Sequence Query token search.
  - `SearchTips` owns the shared search-operator help content and popover behavior.
  - `SequenceBuilder` owns slot editing and ordering.
  - `moveSlot` is the common reorder path for both pointer drag and Up/Down controls.
- Keep page navigation in `App` and `go`; do not add a separate router unless the application architecture is deliberately being changed.
- Keep styling consistent with the CSS in the `Style` component and existing `npx-*` naming. Use `src/index.css` only for genuinely global rules.
- Preserve the existing view boundaries: Home, Languages, Explore, Detail, and Statistics.
- Treat the public Supabase key as client configuration, but do not add privileged keys, secrets, or server-only credentials to the frontend.

## Coding Conventions

- Use the existing React function-component style and hooks.
- Keep state local to the component that owns the behavior. Lift state only when a parent already coordinates that workflow.
- Use descriptive variable names and existing naming conventions such as `npx-*`, `languageById`, `annotationMeta`, and `seqSlots`.
- Prefer small, focused changes over broad rewrites of `src/app.jsx`.
- Preserve existing public behavior, loading states, error handling, pagination, and responsive layout unless the task explicitly changes them.
- Reuse existing visual primitives such as `Dots`, `ErrorBox`, `Tag`, and existing button/input classes before creating new variants.
- Keep UI controls accessible: use real buttons, meaningful `aria-label` values, disabled states, and titles where an icon is not self-explanatory.
- Avoid adding comments for obvious code. Add a short comment only when a non-obvious data or interaction decision needs orientation.
- Default to ASCII when editing source and documentation unless existing content or the feature requires another character set.

## Common Mistakes To Avoid

- Do not duplicate search parsing in Explore, Sequence Query, export logic, or another component. All supported operators must continue to behave consistently.
- Do not reimplement slot reordering separately for drag-and-drop and arrow buttons. Route both interactions through `moveSlot` so the same `seqSlots` state drives filtering.
- Do not attach drag behavior to the entire slot card if the change could interfere with selects, inputs, clear buttons, or the search tips control. The dedicated handle owns pointer dragging.
- Do not remove `touch-action: none` from the drag handle without checking touch and pointer behavior.
- Do not render the search tips popover inside an overflow-clipped sidebar. It uses a portal and fixed positioning intentionally.
- Do not assume PostgREST regex and `or=(...)` syntax accepts arbitrary capture groups. Validate exact-search patterns against the live API when changing them.
- Do not use unencoded user search terms, language IDs, phrase IDs, or sequence filter values in REST paths.
- Do not add a backend framework or database client without a clear architectural need; the current app is a direct Supabase REST client.
- Do not refactor unrelated views, styling, or data schema while fixing a local Explore issue.

## Areas Requiring Care

- `buildSearchFilter` affects main phrase search, Sequence Query word filters, and CSV export. Changes can alter exact, prefix, contains, malformed-input, and default-search behavior.
- `SequenceBuilder` affects ordered query semantics. Reordering must update the slot array immediately and preserve category, subcategory, type, and optional word values.
- `resolveSequence` verifies both candidate intersection and strict annotation order. Preserve that ordering logic when changing sequence filters.
- `SearchTips` uses a React portal, viewport positioning, pointer/focus behavior, and outside-click dismissal. Test it around sticky and scrollable containers.
- `sb` maps HTTP failures into user-facing errors. Preserve retry behavior and do not swallow errors in new data paths without a reason.
- The inline `Style` component contains most responsive rules. Check desktop and narrow layouts when changing controls, tables, sidebars, or popovers.
- CSV export must continue applying the same active search, language, and sequence filters as the visible Explore results.

## Testing And Validation

Before editing, identify the narrowest relevant component or helper and state the behavior being tested. After the first substantive edit, run the cheapest focused check available before making more changes.

At minimum, run:

```bash
npm run build
```

Also use VS Code diagnostics for changed files. For data/query changes, perform a focused live Supabase request when practical, especially for PostgREST operators and encoded filters. For interaction changes, manually verify the affected workflow in a browser at desktop and narrow/mobile widths when a browser session is available.

Check these regression cases when relevant:

- Main search: default text, exact quoted text, prefix wildcard, contains wildcard, whitespace, and malformed operators.
- Sequence Query: slot editing, token operators, drag reorder, Up/Down boundaries, and immediate result refresh.
- Help popover: hover/focus/click, outside dismissal, scrolling, and visibility above the results area.
- Explore pagination, sorting, language filters, empty results, retry errors, and CSV export.

There is currently no `npm test` or lint script in `package.json`. Do not report tests as run unless a real command was executed; distinguish build/diagnostic validation from browser verification.

## Change Workflow

1. Read the nearest owning code path and one relevant call site or neighboring style rule.
2. Make the smallest focused edit that preserves existing state and component boundaries.
3. Run `npm run build` or a narrower available check immediately after the first edit.
4. Repair local failures before broadening the change.
5. Review the diff for accidental formatting, unrelated refactors, duplicated logic, or changed public behavior.
