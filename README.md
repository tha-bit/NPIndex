# Noun Phrase Index

A cross-linguistic archive for exploring noun phrases and their internal grammatical structure. The application presents phrases collected from natural speech and text, with token-level glosses, structural annotations, translations, language metadata, context, and provenance.

## 1. Project Overview

The Noun Phrase Index is a browser-based research tool for browsing and comparing noun phrase data across languages.

Key capabilities:

- Browse an overview of the archive and live collection statistics.
- Explore phrases by wording, translation, language, and annotation sequence.
- Use search operators for precise text and token searches:
  - `"word"` for exact whole-word matching.
  - `word*` for prefix matching.
  - `*word*` for contains matching.
  - Unqualified text keeps the default contains behavior.
- Reorder Sequence Query slots with pointer drag-and-drop or Up/Down controls.
- Inspect phrase details, token glosses, contexts, annotations, and provenance.
- Export the current Explore result set as CSV.
- Compare annotation distributions and ordered annotation sequences across languages.

## 2. Technology Stack

- **Frontend:** React 18
- **Build tool:** Vite 5 with `@vitejs/plugin-react`
- **Backend/API:** No application server. The frontend calls Supabase PostgREST directly.
- **Database/storage:** Supabase tables, including phrases, tokens, annotations, languages, sessions, contexts, sources, and annotators.
- **Browser APIs:** `fetch` for data access, React portals for help popovers, pointer events for slot reordering, and Blob/download APIs for CSV export.
- **Styling:** Component-local CSS emitted by the `Style` component in `src/app.jsx`, plus the global stylesheet in `src/index.css`.
- **Fonts:** Fraunces, IBM Plex Sans, and IBM Plex Mono loaded from Google Fonts at runtime.

## 3. Application Structure

```text
.
├── index.html          # Vite HTML entry point
├── package.json        # Dependencies and npm scripts
├── vite.config.js      # Vite and React plugin configuration
├── src/
│   ├── main.jsx        # React root and StrictMode bootstrap
│   ├── app.jsx         # Browser routing, shared data loading, and app shell
│   ├── archive.jsx     # Shared data helpers, view implementations, and styles
│   ├── pages/          # Route-level About, Languages, Explore, Statistics, and Detail pages
│   └── index.css       # Global base styles
└── README.md           # Project and coding-agent guide
```

Route definitions and shared application data loading live in `src/app.jsx`. Existing view behavior and reusable UI remain in `src/archive.jsx`, while `src/pages` provides a separate component for each route.

## 4. Main Features

### About / Home

- Explains the archive and its linguistic purpose.
- Displays live counts for languages with data, noun phrases, and glossed tokens.
- Shows a rotating example phrase with token-level interlinear glossing.
- Provides the archive data hierarchy and navigation into Explore.

### Languages

- Lists languages available in the archive.
- Supports filtering by language name or ISO code.
- Shows phrase counts per language.
- Opens Explore with a selected language filter.

### Explore

The main search and filtering workspace.

- **Search wording:** Searches phrase text and translations using the shared `buildSearchFilter` operator parser.
- **Language filter:** Multi-select language checkboxes.
- **Sequence Query:** Builds an ordered annotation pattern. Each slot can constrain category, subcategory, type, and an optional token word.
- **Sequence slot word search:** Uses the same operators as the main search field and matches annotation tokens.
- **Slot ordering:** Drag the handle to reorder slots, or use the Up and Down arrow buttons. Both paths update the same `slots` state used by sequence matching.
- **Sorting:** Sort by phrase, language, or ID, with ascending/descending direction.
- **Results:** Paginated phrase table with language, structure, and lazily loaded context.
- **CSV export:** Exports all rows matching the current language, text, and sequence filters, including language metadata and context.
- **Detail navigation:** Clicking a result opens the full record view.
- **Search help:** The small `?` controls explain supported search operators. The popover is rendered through a portal so it is not clipped by the sidebar overflow container.

### Phrase Detail

- Shows the phrase, translation, language, and structural tag sequence.
- Displays an interlinear gloss of tokens and glosses.
- Highlights the phrase inside its full context.
- Lists annotation category, subcategory, type, tag, token, and order.
- Shows provenance: source, session date, annotator, and language metadata.
- Links to related phrases from the same language.

### Statistics

- Select up to four languages for comparison.
- Compare category, subcategory, and type distributions with counts and percentages.
- Display proportional breakdown bars.
- Inspect ordered annotation-pair heatmaps at category, subcategory, or type level.
- Filter sequence statistics by category and subcategory.

## 5. AI Agent Guidance

Before changing behavior, inspect the nearest owning page in `src/pages`, its view implementation in `src/archive.jsx`, and any related styles in the same file. Avoid scanning or refactoring unrelated views unless the requested behavior crosses a shared boundary.

Important locations:

- `sb` and `buildSearchFilter`: Supabase REST access and shared search-operator construction.
- `SearchTips`: reusable search-operator help popover.
- `SequenceBuilder`: sequence slots, slot editing, drag reordering, and arrow reordering.
- `Explore`: search state, filtering, pagination, export, and sequence resolution.
- `Detail`, `Languages`, and `Statistics`: their corresponding page-level workflows.
- `Style`: the application’s component CSS and responsive layout rules.
- `src/app.jsx`: route definitions, shared metadata loading, and navigation mapping.
- `src/main.jsx`: application bootstrap only; it should rarely need changes.

Prefer reusing existing helpers, components, state, and CSS conventions. In particular, do not duplicate search parsing or reorder logic. Keep changes focused, preserve the current Supabase schema and public behavior, and avoid broad rewrites of `src/app.jsx` for local feature changes.

## Development

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Create a production build:

```bash
npm run build
```

Preview the production build locally:

```bash
npm run preview
```

The Supabase URL and anonymous API key are currently configured near the top of `src/app.jsx`. Supabase row-level security and table permissions determine which data the public application can read.
