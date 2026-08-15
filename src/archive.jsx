import React, { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";

/* ============================================================
   CONFIG
   ============================================================ */
const SUPABASE_URL = "https://yaqsnzcwbiwefpiojnih.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlhcXNuemN3Yml3ZWZwaW9qbmloIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwOTYwNTYsImV4cCI6MjA5ODY3MjA1Nn0.d33njOfbTMY7XnGZVNMBNwGNpiEnrDLm7MJYZI6DoCI";
const PAGE_SIZES = [20, 50, 100];

/* ============================================================
   DATA LAYER
   ============================================================ */
export async function sb(path, { range, count } = {}) {
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
  };
  if (range) headers["Range"] = range;
  if (count) headers["Prefer"] = "count=exact";
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).message || ""; } catch (_) {}
    throw new Error(
      `${res.status === 401 || res.status === 403
        ? "Access denied — check your RLS policies."
        : `Request failed (${res.status})`}${detail ? `: ${detail}` : ""}`
    );
  }
  const data = await res.json();
  let total = null;
  const cr = res.headers.get("content-range");
  if (cr && cr.includes("/")) {
    const t = cr.split("/")[1];
    total = t === "*" ? null : parseInt(t, 10);
  }
  return { data, total };
}

export async function signInWithPassword(email, password) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.msg || payload.message || "Sign-in failed.");
  }
  return payload;
}

const enc = (v) => encodeURIComponent(v);

function buildSearchFilter(value) {
  const query = String(value || "").trim();
  if (!query) return null;

  if (query.length >= 2 && query.startsWith('"') && query.endsWith('"')) {
    const phrase = query.slice(1, -1).trim();
    if (phrase && !phrase.includes('"')) {
      const escaped = escapeRegExp(phrase);
      const pattern = `^${escaped}$|^${escaped}[^[:alnum:]_-]|[^[:alnum:]_-]${escaped}$|[^[:alnum:]_-]${escaped}[^[:alnum:]_-]`;
      return { operator: "imatch", value: enc(pattern) };
    }
  }

  if (query.endsWith("*") && !query.startsWith("*")) {
    const prefix = query.slice(0, -1).trim();
    if (prefix && !prefix.includes("*")) return { operator: "ilike", value: enc(prefix + "*") };
  }
  if (query.startsWith("*") && query.endsWith("*") && query.length > 2) {
    const contains = query.slice(1, -1).trim();
    if (contains && !contains.includes("*")) {
      return { operator: "ilike", value: enc("*" + contains + "*") };
    }
  }

  return { operator: "ilike", value: enc("*" + query + "*") };
}

/* ============================================================
   PRIMITIVES
   ============================================================ */
function Dots() {
  return (
    <span className="npx-dots" aria-label="Loading">
      <span /><span /><span />
    </span>
  );
}

function ErrorBox({ message, onRetry }) {
  return (
    <div className="npx-error">
      <div className="npx-error-title">Couldn't load this data</div>
      <div className="npx-error-body">{message}</div>
      {onRetry && <button className="npx-btn npx-btn-ghost" onClick={onRetry}>Try again</button>}
    </div>
  );
}

function SearchTips() {
  const [open, setOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState({});
  const ref = useRef(null);
  const popoverRef = useRef(null);
  const closeTimer = useRef(null);

  const updatePopoverPosition = useCallback(() => {
    const button = ref.current?.querySelector(".npx-search-tips-button");
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const width = Math.min(250, window.innerWidth - 48);
    const left = Math.min(rect.left, window.innerWidth - width - 24);
    setPopoverStyle({ top: rect.bottom + 8, left, width });
  }, []);

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };

  useEffect(() => {
    if (!open) return undefined;
    updatePopoverPosition();
    const close = (event) => {
      if (!ref.current?.contains(event.target) && !popoverRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("resize", updatePopoverPosition);
    window.addEventListener("scroll", updatePopoverPosition, true);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("resize", updatePopoverPosition);
      window.removeEventListener("scroll", updatePopoverPosition, true);
    };
  }, [open, updatePopoverPosition]);

  useEffect(() => () => cancelClose(), []);

  return (
    <span
      className="npx-search-tips"
      ref={ref}
      onMouseEnter={() => { cancelClose(); setOpen(true); }}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className="npx-search-tips-button"
        aria-label="Show search operator tips"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onFocus={() => setOpen(true)}
        onBlur={(event) => {
          if (!ref.current?.contains(event.relatedTarget) && !popoverRef.current?.contains(event.relatedTarget)) scheduleClose();
        }}
      >
        ?
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          className="npx-search-tips-popover"
          role="tooltip"
          style={popoverStyle}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <strong>Search tips:</strong>
          <div>1. <code>word</code> for similar match (e.g., old → old, gold, mold, fold)</div>          
          <div>2. <code>"word"</code> for exact match (e.g., "cat" → cat)</div>
          <div>3. <code>word*</code> for words starting with "word" (e.g. old* → old, older, oldest)</div>
          <div>4. <code>*word*</code> for words containing "word" (e.g., *cat* → cat, concatenate, scat)</div>
        </div>,
        document.body
      )}
    </span>
  );
}

function IGT({ tokens, translation, size = "md" }) {
  const hasTokens = tokens && tokens.length > 0;
  return (
    <div className={`npx-igt npx-igt-${size}`}>
      {hasTokens ? (
        <div className="npx-igt-grid" style={{ gridTemplateColumns: `repeat(${tokens.length}, auto)` }}>
          {tokens.map((t, i) => (
            <div className="npx-igt-col" key={i}>
              <div className="npx-igt-token">{t.token || "—"}</div>
              <div className="npx-igt-gloss">{t.gloss || "—"}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="npx-igt-empty">No token-level glosses recorded.</div>
      )}
      {translation && <div className="npx-igt-translation">'{translation}'</div>}
    </div>
  );
}

function Tag({ children, tone = "indigo" }) {
  return <span className={`npx-tag npx-tag-${tone}`}>{children}</span>;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function HighlightPhrase({ text, phrase }) {
  if (!text) return null;
  const rawPhrase = String(phrase || "").trim();
  if (!rawPhrase) return <>{text}</>;

  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(rawPhrase)}(?![\\p{L}\\p{N}])`, "giu");
  const parts = [];
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<React.Fragment key={`text-${lastIndex}`}>{text.slice(lastIndex, match.index)}</React.Fragment>);
    }
    parts.push(<strong key={`match-${match.index}`}>{match[0]}</strong>);
    lastIndex = match.index + match[0].length;
  }

  if (parts.length === 0) return <>{text}</>;
  if (lastIndex < text.length) {
    parts.push(<React.Fragment key={`tail-${lastIndex}`}>{text.slice(lastIndex)}</React.Fragment>);
  }
  return <>{parts}</>;
}

/* ============================================================
   HEADER
   ============================================================ */
export function Header({ view, go }) {
  return (
    <header className="npx-header">
      <div className="npx-header-inner">
        <button className="npx-brand" onClick={() => go("home")}>
          <span className="npx-brand-mark">NP</span>
          <span className="npx-brand-text">
            Noun Phrase DB
            <span className="npx-brand-sub">a cross-linguistic archive</span>
          </span>
        </button>
        <nav className="npx-nav">
          {["home", "languages", "explore", "statistics"].map((v) => (
            <button
              key={v}
              className={`npx-nav-link ${view === v ? "is-active" : ""}`}
              onClick={() => go(v)}
            >
              {v === "home" ? "About" : v === "statistics" ? "Statistics" : v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </nav>
      </div>
    </header>
  );
}

/* ============================================================
   HOME
   ============================================================ */
export function Home({ go, languageById }) {
  const [stats, setStats] = useState(null);
  const [statsErr, setStatsErr] = useState(null);

  // Hero carousel: pool of phrases + enriched current entry
  const poolRef = useRef([]);
  const [heroIdx, setHeroIdx] = useState(0);
  const [hero, setHero] = useState(null);   // { phrase, tokens }
  const [heroFade, setHeroFade] = useState(true);
  const timerRef = useRef(null);

  // Count only languages that actually have at least one phrase
  const loadStats = useCallback(async () => {
    setStatsErr(null);
    try {
      const [phr, tok, langRows] = await Promise.all([
        sb("phrases?select=phrase_id", { range: "0-0", count: true }),
        sb("tokens?select=token_id", { range: "0-0", count: true }),
        sb("phrases?select=language_id&limit=10000"),
      ]);
      const activeLangs = new Set(langRows.data.map((r) => r.language_id)).size;
      setStats({ languages: activeLangs, phrases: phr.total, tokens: tok.total });
    } catch (e) { setStatsErr(e.message); }
  }, []);

  // Load a pool of phrases spread across languages, then enrich one-by-one on demand
  const loadPool = useCallback(async () => {
    try {
      const { data: sample } = await sb(
        "phrases?select=phrase_id,phrase_main,phrase_translation,language_id,tag_sequence&limit=100&order=language_id.asc"
      );
      if (!sample?.length) return;
      // Shuffle so different languages interleave
      const shuffled = sample.slice().sort(() => Math.random() - 0.5);
      poolRef.current = shuffled;
      setHeroIdx(0);
    } catch (_) {}
  }, []);

  // Fetch tokens for whichever phrase is current
  const loadTokens = useCallback(async (phrase) => {
    try {
      const { data: toks } = await sb(
        `tokens?select=token,gloss&phrase_id=eq.${enc(phrase.phrase_id)}&order=token_id.asc`
      );
      setHero({ phrase, tokens: toks });
    } catch (_) {
      setHero({ phrase, tokens: [] });
    }
  }, []);

  // Advance to the next card with a fade
  const advance = useCallback(() => {
    setHeroFade(false);
    setTimeout(() => {
      setHeroIdx((i) => {
        const next = poolRef.current.length ? (i + 1) % poolRef.current.length : 0;
        return next;
      });
      setHeroFade(true);
    }, 300);
  }, []);

  useEffect(() => { loadStats(); loadPool(); }, [loadStats, loadPool]);

  // When heroIdx changes, load tokens for that phrase
  useEffect(() => {
    const phrase = poolRef.current[heroIdx];
    if (phrase) loadTokens(phrase);
  }, [heroIdx, loadTokens]);

  // Auto-rotate every 3 seconds
  useEffect(() => {
    timerRef.current = setInterval(advance, 3000);
    return () => clearInterval(timerRef.current);
  }, [advance]);

  const heroLang = hero && languageById[hero.phrase.language_id];

  return (
    <div className="npx-page">
      <section className="npx-hero">
        <div className="npx-hero-text">
          <p className="npx-eyebrow">Cross-linguistic noun phrase archive</p>
          <h1 className="npx-h1">Noun phrases across languages</h1>
          <p className="npx-lede">This database brings together noun phrases from languages around the world, drawn from natural speech and text and annotated word by word. It supports cross-linguistic comparison of the forms and structures that occur within the noun phrase.</p>
          <button className="npx-btn npx-btn-primary" onClick={() => go("explore")}>Browse the collection →</button>
        </div>
        <div className="npx-hero-example">
          <div className="npx-hero-card-header">
            <div className="npx-card-label">A record from the archive</div>
            <div className="npx-hero-dots">
              {poolRef.current.slice(0, 8).map((_, i) => (
                <button
                  key={i}
                  className={"npx-hero-dot" + (i === heroIdx % Math.min(poolRef.current.length, 8) ? " is-active" : "")}
                  onClick={() => { clearInterval(timerRef.current); setHeroFade(false); setTimeout(() => { setHeroIdx(i); setHeroFade(true); }, 300); }}
                  aria-label={`Go to example ${i + 1}`}
                />
              ))}
            </div>
          </div>
          {hero ? (
            <div className={"npx-hero-fade" + (heroFade ? " is-visible" : "")}>
              <div className="npx-hero-igt-wrap">
                <IGT tokens={hero.tokens} translation={hero.phrase.phrase_translation} size="lg" />
              </div>
              <div className="npx-hero-meta-footer">
                {heroLang && (
                  <div className="npx-hero-meta-lang">
                    <Tag tone="indigo">{heroLang.language_name}</Tag>
                  </div>
                )}
                {hero.phrase.tag_sequence && (
                  <span className="npx-hero-meta-seq" title={hero.phrase.tag_sequence}>
                    {hero.phrase.tag_sequence}
                  </span>
                )}
                <button
                  className="npx-btn npx-btn-ghost npx-btn-small npx-hero-view-btn"
                  onClick={() => go("detail", hero.phrase.phrase_id)}
                >
                  View this record →
                </button>
              </div>
            </div>
          ) : (
            <div className="npx-hero-example-loading"><Dots /> fetching a record…</div>
          )}
        </div>
      </section>

      <section className="npx-stats">
        {statsErr ? <ErrorBox message={statsErr} onRetry={loadStats} /> : (
          <>
            {[["languages", stats?.languages], ["noun phrases", stats?.phrases], ["glossed tokens", stats?.tokens]].map(([label, val]) => (
              <div className="npx-stat" key={label}>
                <div className="npx-stat-num">{val != null ? val : <Dots />}</div>
                <div className="npx-stat-label">{label}</div>
              </div>
            ))}
          </>
        )}
      </section>

      <section className="npx-about">
        <div className="npx-about-col">
          <h2 className="npx-h2">What is in a record</h2>
          <p>Every noun phrase is drawn from a linguistic <em>corpus</em>, a structured collection of recorded or transcribed language data. Each phrase is linked to source and reviewed by a native-speaking <em>annotator</em>. Each phrase is broken into <em>tokens</em>, and each token carries its own <em>gloss</em> and <em>categorical type</em> so you can read the internal grammar of the phrase with the <em>translation</em>.</p>
        </div>
        <div className="npx-about-col">
          <h2 className="npx-h2">How the data is organized</h2>
          <ul className="npx-tree">
            <li>language<ul><li>source</li><li>session<ul><li>context</li><li>phrase<ul><li>token</li><li>annotation (category → subcategory → type)</li></ul></li></ul></li></ul></li>
          </ul>
        </div>
      </section>

      <section className="npx-cta">
        <h2 className="npx-h2">Start exploring</h2>
        <p>Search by wording, filter by language, or build a structural sequence query.</p>
        <button className="npx-btn npx-btn-primary" onClick={() => go("explore")}>Open the explorer →</button>
      </section>
    </div>
  );
}

/* ============================================================
   SEQUENCE QUERY BUILDER
   Each slot = { category, subcategory, type }
   Users add/remove/reorder slots; query finds phrases whose
   annotations contain a matching subsequence in order.
   ============================================================ */
function SequenceBuilder({ slots, setSlots, annotationMeta }) {
  const { categories, subcategoriesByCategory, typesByCategory, typesByCategoryAndSubcategory } = annotationMeta;
  const dragIdx = useRef(null);
  const dragPointerId = useRef(null);
  const [dragging, setDragging] = useState(false);

  const addSlot = () => setSlots((s) => [...s, { category: "", subcategory: "", type: "", word: "" }]);
  const removeSlot = (i) => setSlots((s) => s.filter((_, j) => j !== i));
  const moveSlot = (from, to) => {
    if (from === to || from < 0 || to < 0) return;
    setSlots((s) => {
      if (from >= s.length || to >= s.length) return s;
      const arr = [...s];
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      return arr;
    });
  };
  const updateSlot = (i, field, val) =>
    setSlots((s) => s.map((slot, j) => {
      if (j !== i) return slot;
      const updated = { ...slot, [field]: val };
      if (field === "category") {
        updated.subcategory = "";
        updated.type = "";
        updated.word = "";
      } else if (field === "subcategory") {
        updated.type = "";
      }
      return updated;
    }));

  const onPointerDown = (event, i) => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    dragIdx.current = i;
    dragPointerId.current = event.pointerId;
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return undefined;

    const onPointerMove = (event) => {
      if (event.pointerId !== dragPointerId.current || dragIdx.current == null) return;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-seq-slot-index]");
      if (!target) return;
      const targetIdx = Number(target.dataset.seqSlotIndex);
      if (targetIdx === dragIdx.current || Number.isNaN(targetIdx)) return;

      moveSlot(dragIdx.current, targetIdx);
      dragIdx.current = targetIdx;
    };

    const finishDrag = (event) => {
      if (event.pointerId !== dragPointerId.current) return;
      dragIdx.current = null;
      dragPointerId.current = null;
      setDragging(false);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
    };
  }, [dragging, setSlots]);

  return (
    <div className={`npx-seqbuilder${slots.length ? " has-slots" : ""}`}>
      <div className="npx-seqbuilder-head">
        <div className="npx-filter-label">Sequence query</div>
      </div>
      <button className="npx-btn npx-btn-ghost npx-btn-small npx-seq-add" onClick={addSlot}>
        + Add slot
      </button>
      <p className="npx-filter-hint">Build a sequence of annotation slots. Phrases matching this ordered pattern will be returned.</p>

      {slots.length === 0 && (
        <div className="npx-seq-empty">No slots yet — add one to start querying by structure.</div>
      )}

      <div className="npx-seq-slots">
        {slots.map((slot, i) => {
          const subcatOptions = (subcategoriesByCategory[slot.category] || []);
          const typeOptions = slot.subcategory
            ? (typesByCategoryAndSubcategory[slot.category]?.[slot.subcategory] || [])
            : (typesByCategory[slot.category] || []);
          return (
            <div
              key={i}
              className={`npx-seq-slot${dragging && dragIdx.current === i ? " is-dragging" : ""}`}
              data-seq-slot-index={i}
            >
              <div
                className="npx-seq-slot-handle"
                title="Drag to reorder"
                onPointerDown={(e) => onPointerDown(e, i)}
              >⠿</div>
              <div className="npx-seq-slot-num">{i + 1}</div>
              <div className="npx-seq-slot-arrows" aria-label={`Reorder slot ${i + 1}`}>
                <button
                  type="button"
                  className="npx-seq-arrow"
                  onClick={() => moveSlot(i, i - 1)}
                  disabled={i === 0}
                  aria-label="Move slot up"
                  title="Move up"
                >↑</button>
                <button
                  type="button"
                  className="npx-seq-arrow"
                  onClick={() => moveSlot(i, i + 1)}
                  disabled={i === slots.length - 1}
                  aria-label="Move slot down"
                  title="Move down"
                >↓</button>
              </div>
              <div className="npx-seq-slot-fields">
                <select
                  className="npx-select npx-select-sm"
                  value={slot.category}
                  onChange={(e) => updateSlot(i, "category", e.target.value)}
                >
                  <option value="">Any category</option>
                  {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <select
                  className="npx-select npx-select-sm"
                  value={slot.subcategory}
                  onChange={(e) => updateSlot(i, "subcategory", e.target.value)}
                  disabled={!slot.category || subcatOptions.length === 0}
                >
                  <option value="">Any subcategory</option>
                  {subcatOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <select
                  className="npx-select npx-select-sm"
                  value={slot.type}
                  onChange={(e) => updateSlot(i, "type", e.target.value)}
                  disabled={!slot.category || typeOptions.length === 0}
                >
                  <option value="">Any type</option>
                  {typeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <div className="npx-seq-word-row">
                  <input
                    className="npx-input npx-select-sm npx-seq-word-input"
                    placeholder="word (optional)"
                    value={slot.word || ""}
                    onChange={(e) => updateSlot(i, "word", e.target.value)}
                    title="Filter this slot to annotations whose token matches this word (case-insensitive, partial match)"
                  />
                  <SearchTips />
                  {slot.word && (
                    <button className="npx-seq-remove" style={{ fontSize: 13 }} onClick={() => updateSlot(i, "word", "")} title="Clear word">×</button>
                  )}
                </div>
              </div>
              <button className="npx-seq-remove" onClick={() => removeSlot(i)} title="Remove slot">×</button>
            </div>
          );
        })}
      </div>

    </div>
  );
}

/* ============================================================
   EXPLORE
   ============================================================ */
export function Explore({ go, languages, languageById, annotationMeta, initialLangFilter = "" }) {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [langFilters, setLangFilters] = useState(
    initialLangFilter ? new Set([initialLangFilter]) : new Set()
  );
  const [seqSlots, setSeqSlots] = useState([]);
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(0);
  const [sortField, setSortField] = useState("phrase_main");
  const [sortDir, setSortDir] = useState("asc");

  const [results, setResults] = useState(null);
  const [total, setTotal] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);
  const languageDropdownRef = useRef(null);

  useEffect(() => {
    const closeLanguageDropdown = (event) => {
      if (!languageDropdownRef.current?.contains(event.target)) {
        languageDropdownRef.current?.removeAttribute("open");
      }
    };
    const closeLanguageDropdownOnEscape = (event) => {
      if (event.key !== "Escape" || !languageDropdownRef.current?.open) return;
      languageDropdownRef.current.removeAttribute("open");
      languageDropdownRef.current.querySelector("summary")?.focus();
    };
    document.addEventListener("mousedown", closeLanguageDropdown);
    document.addEventListener("keydown", closeLanguageDropdownOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeLanguageDropdown);
      document.removeEventListener("keydown", closeLanguageDropdownOnEscape);
    };
  }, []);

  /* --- sequence matching ---
     For each slot, fetch phrase_ids from annotations matching that slot's
     criteria. Then intersect across slots (a phrase must appear in all sets),
     and also verify ordering — the matching annotation orders must be
     strictly increasing across slots.
     We do this client-side after fetching annotation rows for the matched ids.
  */
  const resolveSequence = useCallback(async (slots) => {
    if (!slots.length) return null;

    // Fetch annotations for each slot
    const slotRows = await Promise.all(slots.map(async (slot) => {
      // Build annotation query for this slot
      let path = "annotations?select=phrase_id,order&limit=5000";
      if (slot.category) path += `&category=eq.${enc(slot.category)}`;
      if (slot.subcategory) path += `&subcategory=eq.${enc(slot.subcategory)}`;
      if (slot.type) path += `&type=eq.${enc(slot.type)}`;
      const { data: annRows } = await sb(path);

      // If no word filter, return annotation rows directly
      if (!slot.word || !slot.word.trim()) return annRows;

      // Word filter: fetch annotations matching the shared search pattern and intersect
      // by (phrase_id, order) — annotations and tokens share the same order
      // within a phrase via the annotations.token field (denormalized copy)
      // We use the `token` column on annotations directly.
      let wordPath = "annotations?select=phrase_id,order&limit=5000";
      if (slot.category) wordPath += `&category=eq.${enc(slot.category)}`;
      if (slot.subcategory) wordPath += `&subcategory=eq.${enc(slot.subcategory)}`;
      if (slot.type) wordPath += `&type=eq.${enc(slot.type)}`;
      const { operator, value } = buildSearchFilter(slot.word);
      wordPath += `&token=${operator}.${value}`;
      const { data: wordRows } = await sb(wordPath);

      // Build a set of valid (phrase_id, order) pairs from the word-filtered rows
      const wordSet = new Set(wordRows.map((r) => r.phrase_id + "|||" + r.order));

      // Return only annotation rows whose (phrase_id, order) pair matches
      return annRows.filter((r) => wordSet.has(r.phrase_id + "|||" + r.order));
    }));

    // Group each slot's rows by phrase_id → sorted list of orders
    const slotMaps = slotRows.map((rows) => {
      const map = {};
      rows.forEach(({ phrase_id, order }) => {
        if (!map[phrase_id]) map[phrase_id] = [];
        map[phrase_id].push(order);
      });
      Object.values(map).forEach((arr) => arr.sort((a, b) => a - b));
      return map;
    });

    // Candidate phrase_ids = intersection across all slots
    const candidateIds = Object.keys(slotMaps[0]).filter((id) =>
      slotMaps.every((m) => m[id])
    );

    // Verify strict ordering: find a valid assignment of orders across slots
    // using a greedy approach (for each phrase, walk slots left to right,
    // picking the smallest order > previous chosen order)
    const matched = candidateIds.filter((id) => {
      let minOrder = -Infinity;
      for (const m of slotMaps) {
        const orders = m[id];
        const picked = orders.find((o) => o > minOrder);
        if (picked == null) return false;
        minOrder = picked;
      }
      return true;
    });

    return matched.length ? matched : [];
  }, []);

  const runSearch = useCallback(async () => {
    const myId = ++reqId.current;
    setLoading(true);
    setErr(null);
    try {
      // Resolve sequence query
      const activeSlots = seqSlots.filter((s) => s.category || s.subcategory || s.type || s.word?.trim());
      let seqIds = null;
      if (activeSlots.length > 0) {
        seqIds = await resolveSequence(activeSlots);
        if (myId !== reqId.current) return;
        if (seqIds && seqIds.length === 0) {
          setResults([]); setTotal(0); setLoading(false);
          return;
        }
      }

      let path = "phrases?select=phrase_id,phrase_main,phrase_translation,language_id,tag_sequence,session_id";
      const filters = [];

      if (langFilters.size > 0) {
        const ids = [...langFilters].join(",");
        filters.push(`language_id=in.(${ids})`);
      }
      if (search.trim()) {
        const { operator, value } = buildSearchFilter(search);
        filters.push(`or=(phrase_main.${operator}.${value},phrase_translation.${operator}.${value})`);
      }
      if (seqIds) {
        filters.push(`phrase_id=in.(${seqIds.map((id) => `"${id}"`).join(",")})`);
      }

      if (filters.length) path += "&" + filters.join("&");
      path += `&order=${sortField}.${sortDir}`;

      const from = page * pageSize;
      const to = from + pageSize - 1;
      const { data, total: t } = await sb(path, { range: `${from}-${to}`, count: true });

      if (myId === reqId.current) {
        setResults(data);
        setTotal(t);
      }
    } catch (e) {
      if (myId === reqId.current) setErr(e.message);
    } finally {
      if (myId === reqId.current) setLoading(false);
    }
  }, [search, langFilters, seqSlots, sortField, sortDir, page, pageSize, resolveSequence]);

  useEffect(() => { runSearch(); }, [runSearch]);
  useEffect(() => { setPage(0); }, [search, langFilters, seqSlots, sortField, sortDir, pageSize]);

  const submitSearch = (e) => { e.preventDefault(); setSearch(searchInput); };
  const totalPages = total != null ? Math.max(1, Math.ceil(total / pageSize)) : null;

  const toggleLang = (id) => {
    setLangFilters((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const changeSort = (field) => {
    if (sortField === field) {
      setSortDir((direction) => direction === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const hasFilters = langFilters.size > 0 || search || seqSlots.length > 0;

  const exportCSV = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch ALL matching rows (no pagination) for export
      const activeSlots = seqSlots.filter((s) => s.category || s.subcategory || s.type || s.word?.trim());
      let seqIds = null;
      if (activeSlots.length > 0) {
        seqIds = await resolveSequence(activeSlots);
        if (seqIds && seqIds.length === 0) { setLoading(false); return; }
      }
      let path = "phrases?select=phrase_id,phrase_main,phrase_translation,language_id,tag_sequence,session_id&order=" + sortField + "." + sortDir + "&limit=10000";
      const filters = [];
      if (langFilters.size > 0) filters.push("language_id=in.(" + [...langFilters].join(",") + ")");
      if (search.trim()) {
        const { operator, value } = buildSearchFilter(search);
        filters.push("or=(phrase_main." + operator + "." + value + ",phrase_translation." + operator + "." + value + ")");
      }
      if (seqIds) filters.push("phrase_id=in.(" + seqIds.map((id) => '"' + id + '"').join(",") + ")");
      if (filters.length) path += "&" + filters.join("&");

      const { data: rows } = await sb(path);

      // Fetch contexts for all session_ids in one batch
      const sessionIds = [...new Set(rows.map((r) => r.session_id).filter(Boolean))];
      let ctxMap = {};
      if (sessionIds.length > 0) {
        const { data: ctxRows } = await sb(
          "contexts?select=session_id,context_full&session_id=in.(" + sessionIds.map((id) => '"' + id + '"').join(",") + ")&limit=10000"
        );
        ctxRows.forEach((c) => { ctxMap[c.session_id] = c.context_full; });
      }

      const csvRows = [
        ["phrase_id", "phrase", "translation", "language", "iso_code", "tag_sequence", "context"],
        ...rows.map((r) => {
          const lang = languageById[r.language_id];
          return [
            r.phrase_id,
            r.phrase_main || "",
            r.phrase_translation || "",
            lang?.language_name || "",
            lang?.iso_code || "",
            r.tag_sequence || "",
            (ctxMap[r.session_id] || "").replace(/\n/g, " "),
          ].map((v) => '"' + String(v).replace(/"/g, '""') + '"');
        }),
      ];
      const csv = csvRows.map((r) => r.join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "noun_phrases_export.csv"; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { console.error("Export failed", e); }
    finally { setLoading(false); }
  }, [search, langFilters, seqSlots, sortField, sortDir, resolveSequence, languageById]);

  return (
    <div className="npx-page">
      <div className="npx-explore-header">
        <h1 className="npx-h1-sm">Explore the collection</h1>
        <p className="npx-lede-sm">Search by wording, filter by language, or build a structural sequence query.</p>
      </div>

      <div className="npx-explore-layout">
        <section className="npx-filter-bar" aria-label="Explore filters">
          <div className="npx-filter-row">
            {/* Search */}
            <form onSubmit={submitSearch} className="npx-filter-group npx-search-filter">
              <label className="npx-filter-label" htmlFor="npx-search">
                Search wording <SearchTips />
              </label>
              <div className="npx-search-row">
                <input id="npx-search" className="npx-input" placeholder="e.g. the house…" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
                <button type="submit" className="npx-btn npx-btn-ghost npx-btn-small">Search</button>
              </div>
              <p className="npx-filter-hint">Matches phrase text or its translation.</p>
            </form>

            {/* Language multi-select */}
            <div className="npx-filter-group npx-language-filter">
              <div className="npx-filter-label">
                Language
                {langFilters.size > 0 && <span className="npx-filter-badge">{langFilters.size}</span>}
              </div>
              <details className="npx-language-dropdown" ref={languageDropdownRef}>
                <summary className="npx-language-dropdown-toggle">
                  <span>{langFilters.size > 0 ? `${langFilters.size} selected` : "All languages"}</span>
                  <span className="npx-language-dropdown-arrow" aria-hidden="true">▾</span>
                </summary>
                <div className="npx-lang-checks npx-language-dropdown-panel">
                  {languages.map((l) => (
                    <label key={l.language_id} className="npx-check-row">
                      <input
                        type="checkbox"
                        className="npx-checkbox"
                        checked={langFilters.has(String(l.language_id))}
                        onChange={() => toggleLang(String(l.language_id))}
                      />
                      <span className="npx-check-label">{l.language_name}</span>
                      {l.iso_code && <span className="npx-check-iso">{l.iso_code}</span>}
                    </label>
                  ))}
                </div>
              </details>
            </div>

            {hasFilters && (
              <div className="npx-filter-actions">
                <button className="npx-btn npx-btn-ghost npx-btn-small npx-clear" onClick={() => {
                  setLangFilters(new Set()); setSeqSlots([]); setSearch(""); setSearchInput("");
                }}>Clear all</button>
              </div>
            )}
          </div>

          {/* Sequence query builder */}
          <SequenceBuilder slots={seqSlots} setSlots={setSeqSlots} annotationMeta={annotationMeta} />
        </section>

        {/* RESULTS */}
        <main className="npx-results">
          <div className="npx-results-bar">
            <div className="npx-results-count">
              {loading ? <span><Dots /> searching…</span>
                : total != null ? <span>{total.toLocaleString()} {total === 1 ? "phrase" : "phrases"} found</span>
                : <span>&nbsp;</span>}
            </div>
            <div className="npx-results-controls">
              <label className="npx-filter-label" style={{margin:0}}>Rows</label>
              {PAGE_SIZES.map((n) => (
                <button key={n} className={`npx-pagesize-btn ${pageSize === n ? "is-active" : ""}`} onClick={() => setPageSize(n)}>{n}</button>
              ))}
              <button
                className="npx-btn npx-btn-ghost npx-btn-small npx-export-btn"
                onClick={exportCSV}
                disabled={!results || results.length === 0}
                title="Export current results as CSV"
              >
                ↓ Export CSV
              </button>
            </div>
          </div>

          {err && <ErrorBox message={err} onRetry={runSearch} />}
          {!err && results && results.length === 0 && !loading && (
            <div className="npx-empty">
              <div className="npx-empty-title">No phrases match these filters</div>
              <div className="npx-empty-body">Try broadening your search, removing a sequence slot, or clearing language filters.</div>
            </div>
          )}

          {results && results.length > 0 && (
            <div className="npx-table-wrap">
              <table className="npx-results-table">
                <thead>
                  <tr>
                    <th aria-sort={sortField === "phrase_main" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                      <button className="npx-table-sort" onClick={() => changeSort("phrase_main")}>
                        Phrase <span aria-hidden="true">{sortField === "phrase_main" ? (sortDir === "asc" ? "↑" : "↓") : "↕"}</span>
                      </button>
                    </th>
                    <th>Translation</th>
                    <th aria-sort={sortField === "language_id" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                      <button className="npx-table-sort" onClick={() => changeSort("language_id")}>
                        Language <span aria-hidden="true">{sortField === "language_id" ? (sortDir === "asc" ? "↑" : "↓") : "↕"}</span>
                      </button>
                    </th>
                    <th>Structure</th>
                    <th>Context</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => (
                    <ResultRow
                      key={r.phrase_id}
                      row={r}
                      languageById={languageById}
                      go={go}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {total != null && total > 0 && (
            <div className="npx-pagination">
              <button className="npx-btn npx-btn-ghost" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← Previous</button>
              <span className="npx-pagination-status">Page {page + 1} of {totalPages}</span>
              <button className="npx-btn npx-btn-ghost" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>Next →</button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

/* ============================================================
   RESULT ROW — lazy-loads context + category sequence
   ============================================================ */
function ResultRow({ row, languageById, go }) {
  const [context, setContext] = useState(null);
  const [ctxLoading, setCtxLoading] = useState(false);
  const [catSeq, setCatSeq] = useState(null);
  const [catLoading, setCatLoading] = useState(false);

  useEffect(() => {
    if (!row.session_id) return;
    setCtxLoading(true);
    sb(`contexts?select=context_full&session_id=eq.${enc(row.session_id)}&limit=1`)
      .then(({ data }) => setContext(data?.[0]?.context_full || null))
      .catch(() => setContext(null))
      .finally(() => setCtxLoading(false));
  }, [row.session_id]);

  useEffect(() => {
    if (!row.phrase_id) return;
    setCatLoading(true);
    sb(`annotations?select=category,order&phrase_id=eq.${enc(row.phrase_id)}&order=order.asc`)
      .then(({ data }) => {
        if (!data?.length) { setCatSeq(null); return; }
        const cats = data.map((a) => a.category).filter(Boolean);
        setCatSeq(cats.join(" › "));
      })
      .catch(() => setCatSeq(null))
      .finally(() => setCatLoading(false));
  }, [row.phrase_id]);

  const lang = languageById[row.language_id];

  return (
    <tr className="npx-result-row" onClick={() => go("detail", row.phrase_id)}>
      <td className="npx-result-main">{row.phrase_main || "—"}</td>
      <td className="npx-result-translation">{row.phrase_translation ? `'${row.phrase_translation}'` : "—"}</td>
      <td>{lang ? <Tag tone="indigo">{lang.language_name}</Tag> : "—"}</td>
      <td className="npx-result-catseq">
        {catLoading ? <Dots /> : catSeq
          ? <span className="npx-catseq">{catSeq}</span>
          : <span className="npx-ctx-none">—</span>}
      </td>
      <td className="npx-result-context">
        {ctxLoading ? <Dots /> : context ? <span className="npx-ctx-text">{context}</span> : <span className="npx-ctx-none">—</span>}
      </td>
    </tr>
  );
}

/* ============================================================
   DETAIL
   ============================================================ */
export function Detail({ phraseId, go, languageById }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const { data: phraseRows } = await sb(`phrases?select=*&phrase_id=eq.${enc(phraseId)}`);
      const phrase = phraseRows[0];
      if (!phrase) throw new Error("This record no longer exists.");

      const [{ data: annRows }, { data: tokRows }, sessionRes] = await Promise.all([
        sb(`annotations?select=*&phrase_id=eq.${enc(phraseId)}&order=order.asc`),
        sb(`tokens?select=*&phrase_id=eq.${enc(phraseId)}&order=token_id.asc`),
        phrase.session_id ? sb(`sessions?select=*&session_id=eq.${enc(phrase.session_id)}`) : Promise.resolve({ data: [] }),
      ]);
      const session = sessionRes.data[0] || null;

      let source = null, annotator = null, context = null;
      const extras = [];
      if (session?.source_id != null) extras.push(sb(`sources?select=*&source_id=eq.${enc(session.source_id)}`));
      if (session?.annotator_id != null) extras.push(sb(`annotators?select=*&annotator_id=eq.${enc(session.annotator_id)}`));
      if (phrase.session_id) extras.push(sb(`contexts?select=context_full&session_id=eq.${enc(phrase.session_id)}&limit=1`));

      const extResults = await Promise.all(extras);
      let ei = 0;
      if (session?.source_id != null) { source = extResults[ei++].data[0] || null; }
      if (session?.annotator_id != null) { annotator = extResults[ei++].data[0] || null; }
      if (phrase.session_id) { context = extResults[ei++].data[0]?.context_full || null; }

      const { data: related } = await sb(`phrases?select=phrase_id,phrase_main,phrase_translation&language_id=eq.${enc(phrase.language_id)}&phrase_id=neq.${enc(phraseId)}&limit=5`);

      setData({ phrase, annotations: annRows, tokens: tokRows, session, source, annotator, context, related });
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [phraseId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="npx-page"><div className="npx-detail-loading"><Dots /> loading record…</div></div>;
  if (err) return <div className="npx-page"><ErrorBox message={err} onRetry={load} /></div>;
  if (!data) return null;

  const { phrase, annotations, tokens, session, source, annotator, context, related } = data;
  const lang = languageById[phrase.language_id];

  return (
    <div className="npx-page">
      <button className="npx-back" onClick={() => go("explore")}>← Back to results</button>
      <div className="npx-detail-layout">
        <div className="npx-detail-main">
          <div className="npx-card-label">Record {phrase.phrase_id}</div>
          {phrase.phrase_main && <h1 className="npx-detail-title">{phrase.phrase_main}</h1>}
          <IGT tokens={tokens} translation={phrase.phrase_translation} size="lg" />
          <div className="npx-detail-tags">
            {lang && <Tag tone="indigo">{lang.language_name}</Tag>}
            {phrase.tag_sequence && <Tag tone="amber">{phrase.tag_sequence}</Tag>}
          </div>

          {context && (
            <section className="npx-section">
              <h2 className="npx-h3">Context</h2>
              <blockquote className="npx-context-block">
                <HighlightPhrase text={context} phrase={phrase.phrase_main} />
              </blockquote>
            </section>
          )}

          <section className="npx-section">
            <h2 className="npx-h3">Structural annotation</h2>
            {annotations?.length > 0 ? (
              <table className="npx-table">
                <thead>
                  <tr><th>#</th><th>Token</th><th>Tag</th><th>Category</th><th>Subcategory</th><th>Type</th></tr>
                </thead>
                <tbody>
                  {annotations.map((a) => (
                    <tr key={a.annotation_id}>
                      <td>{a.order}</td>
                      <td className="npx-mono">{a.token}</td>
                      <td>{a.tag}</td>
                      <td>{a.category}</td>
                      <td>{a.subcategory}</td>
                      <td>{a.type}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="npx-muted">No structural annotation recorded for this phrase.</p>
            )}
          </section>
        </div>

        <aside className="npx-detail-side">
          <h2 className="npx-h3">Provenance</h2>
          <dl className="npx-meta-list">
            <dt>Language</dt><dd>{lang?.language_name || "Unknown"}</dd>
            {lang?.iso_code && <><dt>ISO code</dt><dd className="npx-mono">{lang.iso_code}</dd></>}
            <dt>Source</dt><dd>{source?.source_name || "—"}</dd>
            <dt>Session date</dt><dd>{session?.session_date || "—"}</dd>
            <dt>Annotator</dt><dd>{annotator?.annotator_name || "—"}</dd>
          </dl>

          {related?.length > 0 && (
            <>
              <h2 className="npx-h3">More from {lang?.language_name || "this language"}</h2>
              <ul className="npx-related-list">
                {related.map((r) => (
                  <li key={r.phrase_id}>
                    <button className="npx-related-link" onClick={() => go("detail", r.phrase_id)}>
                      {r.phrase_main}
                      {r.phrase_translation && <span className="npx-related-translation"> '{r.phrase_translation}'</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

/* ============================================================
   LANGUAGES
   ============================================================ */
export function Languages({ go, languages }) {
  const [langStats, setLangStats] = useState({});
  const [loadingStats, setLoadingStats] = useState(true);
  const [langSearch, setLangSearch] = useState("");

  useEffect(() => {
    if (!languages?.length) return;
    Promise.all(
      languages.map((l) =>
        sb(`phrases?select=phrase_id&language_id=eq.${enc(l.language_id)}&limit=1`, { range: "0-0", count: true })
          .then(({ total }) => ({ id: l.language_id, count: total ?? 0 }))
          .catch(() => ({ id: l.language_id, count: null }))
      )
    ).then((results) => {
      const map = {};
      results.forEach(({ id, count }) => (map[id] = count));
      setLangStats(map);
      setLoadingStats(false);
    });
  }, [languages]);

  const filtered = languages.filter((l) => {
    if (!langSearch.trim()) return true;
    const q = langSearch.toLowerCase();
    return l.language_name?.toLowerCase().includes(q) || l.iso_code?.toLowerCase().includes(q);
  });

  return (
    <div className="npx-page">
      <div className="npx-explore-header">
        <h1 className="npx-h1-sm">Languages</h1>
        <p className="npx-lede-sm">{languages.length} language{languages.length !== 1 ? "s" : ""} in the archive.</p>
      </div>
      <input className="npx-input npx-lang-search-input" placeholder="Filter by name or ISO code…" value={langSearch} onChange={(e) => setLangSearch(e.target.value)} style={{ marginBottom: 24, maxWidth: 320 }} />
      <div className="npx-lang-grid">
        {filtered.map((l) => {
          const count = langStats[l.language_id];
          return (
            <button key={l.language_id} className="npx-lang-card" onClick={() => go("explore", null, { language: l.language_id })}>
              <div className="npx-lang-card-top">
                <div className="npx-lang-name">{l.language_name}</div>
                {l.iso_code && <span className="npx-lang-iso">{l.iso_code}</span>}
              </div>
              <div className="npx-lang-card-count">
                {loadingStats ? <Dots /> : count != null ? <><span className="npx-lang-count-num">{count}</span><span className="npx-lang-count-label"> phrase{count !== 1 ? "s" : ""}</span></> : "—"}
              </div>
            </button>
          );
        })}
        {filtered.length === 0 && langSearch && (
          <div className="npx-empty" style={{ gridColumn: "1/-1" }}>
            <div className="npx-empty-title">No languages match "{langSearch}"</div>
          </div>
        )}
      </div>
    </div>
  );
}


/* ============================================================
   STATISTICS PAGE
   Compares distribution of annotation categories across up to
   4 languages selected by the user.
   ============================================================ */

const STAT_COLORS = ["#2F4468", "#4B5D45", "#93591D", "#6B3A6B"];
const STAT_COLORS_LIGHT = ["#DCE3EE", "#D8E4D6", "#EFE0C4", "#E8D8E8"];
const MAX_LANGS = 4;

export function normalizeAnnotationValue(value) {
  if (!value) return value;
  const trimmed = String(value).trim();
  if (!trimmed) return value;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

function MiniBar({ value, max, color, colorLight, pct, showPct }) {
  const barPct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="npx-minibar-wrap" title={value + " occurrences" + (showPct ? " (" + pct + "%)" : "")}>
      <div className="npx-minibar-track" style={{ background: colorLight }}>
        <div className="npx-minibar-fill" style={{ width: barPct + "%", background: color }} />
      </div>
      <span className="npx-minibar-val">{value}</span>
      {showPct && <span className="npx-minibar-pct">{pct}%</span>}
    </div>
  );
}

/* Sequence heatmap cell */
function HeatCell({ value, max, color }) {
  const alpha = max > 0 ? 0.08 + (value / max) * 0.82 : 0;
  return (
    <td className="npx-heat-cell" style={{ background: value > 0 ? color + Math.round(alpha * 255).toString(16).padStart(2,"0") : "transparent" }}>
      {value > 0 ? value : <span className="npx-heat-zero">·</span>}
    </td>
  );
}

export function Statistics({ languages, languageById, annotationMeta }) {
  const [selected, setSelected] = useState([]);
  // rawData: { langId: [ {category, subcategory, type, phrase_id, order} ] }
  const [rawData, setRawData] = useState({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  // Tab: "categories" | "subcategories" | "types" | "sequences"
  const [tab, setTab] = useState("categories");

  // Language search for sidebar
  const [langSearch, setLangSearch] = useState("");

  // Filters for subcategory/type tabs
  const [filterCat, setFilterCat] = useState("");
  const [filterSubcat, setFilterSubcat] = useState("");

  // Filters for sequences tab: level to display and optional narrowing
  const [seqLevel, setSeqLevel] = useState("category"); // "category" | "subcategory" | "type"
  const [seqFilterCat, setSeqFilterCat] = useState("");
  const [seqFilterSubcat, setSeqFilterSubcat] = useState("");

  const toggleLang = (id) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_LANGS) return prev;
      return [...prev, id];
    });
  };

  const loadData = useCallback(async () => {
    if (selected.length === 0) { setRawData({}); return; }
    setLoading(true); setErr(null);
    try {
      const results = await Promise.all(
        selected.map(async (langId) => {
          const { data: phrases } = await sb(
            "phrases?select=phrase_id&language_id=eq." + enc(langId) + "&limit=10000"
          );
          if (!phrases.length) return { langId, anns: [] };
          const ids = phrases.map((p) => p.phrase_id);
          const { data: anns } = await sb(
            "annotations?select=phrase_id,category,subcategory,type,order&phrase_id=in.(" +
            ids.map((id) => '"' + id + '"').join(",") +
            ")&order=phrase_id.asc,order.asc&limit=50000"
          );
          return { langId, anns };
        })
      );
      // Normalise case: capitalise first letter, lowercase the rest
      // so "NOUN" and "Noun" and "noun" all merge into "Noun"
      const map = {};
      results.forEach(({ langId, anns }) => {
        map[langId] = anns.map((a) => ({
          ...a,
          category: normalizeAnnotationValue(a.category),
          subcategory: normalizeAnnotationValue(a.subcategory),
          type: normalizeAnnotationValue(a.type),
        }));
      });
      setRawData(map);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [selected]);

  useEffect(() => { loadData(); }, [loadData]);

  // Reset sub-filters when tab changes
  useEffect(() => { setFilterCat(""); setFilterSubcat(""); }, [tab]);
  useEffect(() => { setFilterSubcat(""); }, [filterCat]);
  useEffect(() => { setSeqFilterCat(""); setSeqFilterSubcat(""); }, [seqLevel]);
  useEffect(() => { setSeqFilterSubcat(""); }, [seqFilterCat]);

  // ── Derived data ─────────────────────────────────────────────

  const metadataCategories = annotationMeta?.categories || [];
  const metadataSubcatsByCat = annotationMeta?.subcategoriesByCategory || {};
  const metadataTypesByCat = annotationMeta?.typesByCategory || {};
  const metadataTypesByCatAndSubcat = annotationMeta?.typesByCategoryAndSubcategory || {};

  const dataCats = [...new Set(
    selected.flatMap((id) => (rawData[id] || []).map((a) => a.category).filter(Boolean))
  )].sort();

  // All categories available for the current selection, using shared metadata as the source of truth.
  const allCats = [...new Set([...(metadataCategories || []), ...dataCats])].sort();

  // All subcategories under filterCat, combining metadata and observed rows.
  const allSubcats = filterCat ? [...new Set([
    ...(metadataSubcatsByCat[filterCat] || []),
    ...selected.flatMap((id) => (rawData[id] || [])
      .filter((a) => a.category === filterCat)
      .map((a) => a.subcategory).filter(Boolean))
  ])].sort() : [];

  function getAvailableTypes(cat, subcat) {
    const fromMeta = subcat
      ? (metadataTypesByCatAndSubcat[cat]?.[subcat] || [])
      : (metadataTypesByCat[cat] || []);
    const fromRows = selected.flatMap((id) => (rawData[id] || [])
      .filter((a) => (!cat || a.category === cat) && (!subcat || a.subcategory === subcat))
      .map((a) => a.type).filter(Boolean));
    return [...new Set([...(fromMeta || []), ...fromRows])].sort();
  }

  // Build counts for the active tab
  function getCatCounts(langId) {
    const rows = rawData[langId] || [];
    const counts = {};
    rows.forEach(({ category }) => {
      if (category) counts[category] = (counts[category] || 0) + 1;
    });
    return counts;
  }

  function getSubcatCounts(langId, cat) {
    const rows = (rawData[langId] || []).filter((a) => !cat || a.category === cat);
    const counts = {};
    rows.forEach(({ subcategory }) => {
      if (subcategory) counts[subcategory] = (counts[subcategory] || 0) + 1;
    });
    return counts;
  }

  function getTypeCounts(langId, cat, subcat) {
    const rows = (rawData[langId] || []).filter((a) =>
      (!cat || a.category === cat) && (!subcat || a.subcategory === subcat)
    );
    const counts = {};
    rows.forEach(({ type }) => {
      if (type) counts[type] = (counts[type] || 0) + 1;
    });
    return counts;
  }

  // Sequence pairs: for every annotation at position i, count a pair with every
  // annotation at position j > i within the same phrase (all ordered pairs,
  // not just adjacent ones). Repeats of the same label in different positions
  // are treated as separate occurrences.
  function getSeqCounts(langId, level, catFilter, subcatFilter) {
    const rows = rawData[langId] || [];
    const byPhrase = {};
    rows.forEach((a) => {
      if (!a.phrase_id) return;
      if (catFilter && a.category !== catFilter) return;
      if (subcatFilter && a.subcategory !== subcatFilter) return;
      let label = null;
      if (level === "category") label = a.category;
      else if (level === "subcategory") label = a.subcategory;
      else if (level === "type") label = a.type;
      if (!label) return;
      if (!byPhrase[a.phrase_id]) byPhrase[a.phrase_id] = [];
      byPhrase[a.phrase_id].push({ ...a, _label: label });
    });
    const pairs = {};
    Object.values(byPhrase).forEach((annRows) => {
      const sorted = annRows.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      // All ordered pairs (i, j) where j > i
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const from = sorted[i]._label;
          const to = sorted[j]._label;
          if (from && to) {
            pairs[from + "|||" + to] = (pairs[from + "|||" + to] || 0) + 1;
          }
        }
      }
    });
    return pairs;
  }

  // ── Render helpers ───────────────────────────────────────────

  function renderDistTable(getCountsFn, keyLabel, allKeys) {
    if (!allKeys.length) return (
      <div className="npx-empty"><div className="npx-empty-title">No data for these filters</div></div>
    );

    const langCounts = selected.map((id) => getCountsFn(id));
    const langTotals = langCounts.map((c) => Object.values(c).reduce((a, b) => a + b, 0));

    return (
      <>
        <div className="npx-stat-table-wrap">
          <table className="npx-stat-table">
            <thead>
              <tr>
                <th className="npx-stat-th-label" rowSpan={2}>{keyLabel}</th>
                {selected.map((id, i) => (
                  <th key={id} colSpan={2} className="npx-stat-th-lang" style={{ color: STAT_COLORS[i], borderBottom: "2px solid " + STAT_COLORS[i] }}>
                    {languageById[id]?.language_name || id}
                  </th>
                ))}
              </tr>
              <tr>
                {selected.map((id) => (
                  <React.Fragment key={id}>
                    <th className="npx-stat-subth">Count</th>
                    <th className="npx-stat-subth">%Pct.</th>
                  </React.Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {allKeys.map((key) => (
                <tr key={key} className="npx-stat-row">
                  <td className="npx-stat-key">{key}</td>
                  {selected.map((id, i) => {
                    const val = langCounts[i][key] || 0;
                    const total = langTotals[i];
                    const pct = total > 0 ? ((val / total) * 100).toFixed(1) : "—";
                    return (
                      <React.Fragment key={id}>
                        <td className="npx-stat-count">{val > 0 ? val : <span className="npx-heat-zero">·</span>}</td>
                        <td className="npx-stat-pct" style={{ color: val > 0 ? STAT_COLORS[i] : "var(--rule)" }}>{val > 0 ? pct + "%" : "—"}</td>
                      </React.Fragment>
                    );
                  })}
                </tr>
              ))}
              <tr className="npx-stat-total-row">
                <td className="npx-stat-key">Total</td>
                {selected.map((id, i) => (
                  <React.Fragment key={id}>
                    <td className="npx-stat-count" style={{ color: STAT_COLORS[i], fontWeight: 700 }}>{langTotals[i]}</td>
                    <td className="npx-stat-pct">100%</td>
                  </React.Fragment>
                ))}
              </tr>
            </tbody>
          </table>
        </div>

        {/* Proportional stacked bar */}
        <div className="npx-stat-bars-section">
          <div className="npx-h3" style={{ marginTop: 36, marginBottom: 16 }}>Proportional breakdown</div>
          <div className="npx-stackbar-list">
            {selected.map((id, li) => {
              const counts = langCounts[li];
              const total = langTotals[li];
              if (total === 0) return null;
              const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
              const color = STAT_COLORS[li];
              return (
                <div key={id} className="npx-stackbar-row">
                  <div className="npx-stackbar-label">{languageById[id]?.language_name}</div>
                  <div className="npx-stackbar-track">
                    {sorted.map(([key, val], ki) => {
                      const pct = (val / total) * 100;
                      const alpha = Math.max(0.18, 1 - ki * (0.7 / Math.max(sorted.length - 1, 1)));
                      return (
                        <div key={key} className="npx-stackbar-seg"
                          style={{ width: pct + "%", background: color, opacity: alpha }}
                          title={key + ": " + val + " (" + pct.toFixed(1) + "%)"}
                        />
                      );
                    })}
                  </div>
                  <div className="npx-stackbar-breakdown">
                    {sorted.slice(0, 6).map(([key, val]) => (
                      <span key={key} className="npx-stackbar-item">
                        <span style={{ color: color, fontWeight: 600 }}>{key}</span>
                        {" "}{((val / total) * 100).toFixed(1)}%
                      </span>
                    ))}
                    {sorted.length > 6 && <span className="npx-stackbar-item" style={{ color: "var(--ink-soft)" }}>+{sorted.length - 6} more</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </>
    );
  }

  function renderSequenceTab() {
    // Collect all labels across selected languages for current level+filters
    function getSeqLabelValue(a) {
      if (seqLevel === "category") return a.category;
      if (seqLevel === "subcategory") return a.subcategory;
      return a.type;
    }

    const rowsFromSelection = selected.flatMap((id) => (rawData[id] || []).filter((a) => {
      if (seqFilterCat && a.category !== seqFilterCat) return false;
      if (seqFilterSubcat && a.subcategory !== seqFilterSubcat) return false;
      return true;
    }));

    const metadataLabels = (() => {
      if (seqLevel === "category") return metadataCategories;
      if (seqLevel === "subcategory") return seqFilterCat ? (metadataSubcatsByCat[seqFilterCat] || []) : [];
      return seqFilterCat
        ? (seqFilterSubcat
          ? (metadataTypesByCatAndSubcat[seqFilterCat]?.[seqFilterSubcat] || [])
          : (metadataTypesByCat[seqFilterCat] || []))
        : [];
    })();

    const allSeqLabels = [...new Set([
      ...metadataLabels,
      ...rowsFromSelection.map((a) => getSeqLabelValue(a)).filter(Boolean)
    ])].sort();

    // Derive available cats/subcats for the filter dropdowns from shared metadata and observed rows
    const seqAllCats = [...new Set([...(metadataCategories || []), ...selected.flatMap((id) => (rawData[id] || []).map((a) => a.category).filter(Boolean))])].sort();
    const seqAllSubcats = seqFilterCat ? [...new Set([
      ...(metadataSubcatsByCat[seqFilterCat] || []),
      ...selected.flatMap((id) => (rawData[id] || [])
        .filter((a) => a.category === seqFilterCat)
        .map((a) => a.subcategory).filter(Boolean))
    ])].sort() : [];

    return (
      <div>
        {/* Controls row */}
        <div className="npx-seq-controls">
          <div className="npx-seq-control-group">
            <span className="npx-filter-label">Show sequences of</span>
            <div className="npx-seg-btns">
              {["category", "subcategory", "type"].map((lvl) => (
                <button key={lvl}
                  className={"npx-pagesize-btn" + (seqLevel === lvl ? " is-active" : "")}
                  onClick={() => setSeqLevel(lvl)}
                >{lvl}</button>
              ))}
            </div>
          </div>
          <div className="npx-seq-control-group">
            <span className="npx-filter-label">Narrow by category</span>
            <select className="npx-select npx-select-sm" value={seqFilterCat} onChange={(e) => setSeqFilterCat(e.target.value)}>
              <option value="">All</option>
              {seqAllCats.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          {seqFilterCat && (
            <div className="npx-seq-control-group">
              <span className="npx-filter-label">Narrow by subcategory</span>
              <select className="npx-select npx-select-sm" value={seqFilterSubcat} onChange={(e) => setSeqFilterSubcat(e.target.value)}>
                <option value="">All</option>
                {seqAllSubcats.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          )}
          {(seqFilterCat || seqFilterSubcat) && (
            <button className="npx-clear-filter-link" onClick={() => { setSeqFilterCat(""); setSeqFilterSubcat(""); }}>× clear filters</button>
          )}
        </div>

        <p className="npx-filter-hint" style={{ marginBottom: 20 }}>
          Each cell shows how many times the <em>row</em> {seqLevel} precedes the <em>column</em> {seqLevel} anywhere within a phrase — not just in adjacent positions.
          For a phrase A › B › C, this counts A→B, A→C, and B→C.
          {seqFilterCat && <> Filtered to <strong>{seqFilterCat}</strong>{seqFilterSubcat ? <> › <strong>{seqFilterSubcat}</strong></> : ""} annotations only.</>}
          {" "}Repeated labels (e.g. two Nouns) are counted as separate occurrences.
        </p>

        {allSeqLabels.length === 0 && (
          <div className="npx-empty"><div className="npx-empty-title">No {seqLevel} data for these filters</div></div>
        )}

        {allSeqLabels.length > 0 && selected.map((id, li) => {
          const bigrams = getSeqCounts(id, seqLevel, seqFilterCat, seqFilterSubcat);
          const matMax = Math.max(1, ...Object.values(bigrams).filter((v) => isFinite(v)));
          const langName = languageById[id]?.language_name || id;
          const color = STAT_COLORS[li];

          return (
            <div key={id} className="npx-seq-matrix-block">
              <div className="npx-seq-matrix-title" style={{ color }}>
                <span className="npx-legend-swatch" style={{ background: color, display: "inline-block", marginRight: 8 }} />
                {langName}
              </div>
              <div className="npx-heat-wrap">
                <table className="npx-heat-table">
                  <thead>
                    <tr>
                      <th className="npx-heat-corner">from ↓ / to →</th>
                      {allSeqLabels.map((lbl) => (
                        <th key={lbl} className="npx-heat-th">{lbl}</th>
                      ))}
                      <th className="npx-heat-th npx-heat-total">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allSeqLabels.map((from) => {
                      const rowTotal = allSeqLabels.reduce((s, to) => s + (bigrams[from + "|||" + to] || 0), 0);
                      return (
                        <tr key={from}>
                          <td className="npx-heat-rowlabel">{from}</td>
                          {allSeqLabels.map((to) => (
                            <HeatCell key={to} value={bigrams[from + "|||" + to] || 0} max={matMax} color={color} />
                          ))}
                          <td className="npx-heat-cell npx-heat-rowtotal">{rowTotal > 0 ? rowTotal : <span className="npx-heat-zero">·</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // ── Main render ──────────────────────────────────────────────

  return (
    <div className="npx-page">
      <div className="npx-explore-header">
        <h1 className="npx-h1-sm">Distribution statistics</h1>
        <p className="npx-lede-sm">Compare annotation distributions across up to {MAX_LANGS} languages.</p>
      </div>

      <div className="npx-stat-layout">
        <aside className="npx-stat-sidebar">
          <div className="npx-filter-label">
            Select languages
            <span className="npx-filter-badge">{selected.length}/{MAX_LANGS}</span>
          </div>
          <input
            className="npx-input"
            placeholder="Type to find a language…"
            value={langSearch}
            onChange={(e) => setLangSearch(e.target.value)}
            style={{ fontSize: 13, padding: "6px 10px" }}
          />
          <div className="npx-lang-checks" style={{ maxHeight: 260 }}>
            {languages
              .filter((l) => {
                if (!langSearch.trim()) return true;
                const q = langSearch.toLowerCase();
                return l.language_name?.toLowerCase().includes(q) || l.iso_code?.toLowerCase().includes(q);
              })
              .map((l) => {
                const sel = selected.includes(String(l.language_id));
                const disabled = !sel && selected.length >= MAX_LANGS;
                const idx = selected.indexOf(String(l.language_id));
                return (
                  <label key={l.language_id}
                    className={"npx-check-row" + (disabled ? " npx-check-disabled" : "")}
                    style={sel ? { borderLeft: "3px solid " + STAT_COLORS[idx], paddingLeft: 6 } : {}}
                  >
                    <input type="checkbox" className="npx-checkbox" checked={sel} disabled={disabled}
                      onChange={() => toggleLang(String(l.language_id))} />
                    <span className="npx-check-label">{l.language_name}</span>
                    {l.iso_code && <span className="npx-check-iso">{l.iso_code}</span>}
                  </label>
                );
              })}
          </div>

          {selected.length > 0 && (
            <button className="npx-btn npx-btn-ghost npx-btn-small npx-clear" onClick={() => setSelected([])}>
              Clear selection
            </button>
          )}

          {selected.length > 0 && (
            <div className="npx-stat-legend">
              {selected.map((id, i) => (
                <div key={id} className="npx-legend-row">
                  <div className="npx-legend-swatch" style={{ background: STAT_COLORS[i] }} />
                  <span>{languageById[id]?.language_name || id}</span>
                </div>
              ))}
            </div>
          )}
        </aside>

        <main className="npx-stat-main">
          {selected.length === 0 && (
            <div className="npx-empty">
              <div className="npx-empty-title">Select up to 4 languages to compare</div>
              <div className="npx-empty-body">Choose languages from the panel on the left.</div>
            </div>
          )}

          {selected.length > 0 && (
            <>
              <div className="npx-stat-tabs">
                {["categories", "subcategories", "types", "sequences"].map((t) => (
                  <button key={t} className={"npx-stat-tab" + (tab === t ? " is-active" : "")} onClick={() => setTab(t)}>
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>

              {loading && <div style={{ padding: "32px 0", color: "var(--ink-soft)" }}><Dots /> loading annotation data…</div>}
              {err && <ErrorBox message={err} onRetry={loadData} />}

              {!loading && !err && tab === "categories" && (
                renderDistTable(getCatCounts, "category", allCats)
              )}

              {!loading && !err && tab === "subcategories" && (() => {
                const keys = [...new Set(
                  selected.flatMap((id) => Object.keys(getSubcatCounts(id, filterCat)))
                )].sort();
                return (
                  <>
                    <div className="npx-seq-controls">
                      <div className="npx-seq-control-group">
                        <span className="npx-filter-label">Filter by category</span>
                        <select className="npx-select npx-select-sm" value={filterCat} onChange={(e) => setFilterCat(e.target.value)}>
                          <option value="">All categories</option>
                          {allCats.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                      {filterCat && (
                        <button className="npx-clear-filter-link" onClick={() => setFilterCat("")}>× clear</button>
                      )}
                    </div>
                    {filterCat && (
                      <div className="npx-stat-context-label">
                        Showing subcategories within <strong>{filterCat}</strong>
                      </div>
                    )}
                    {renderDistTable((id) => getSubcatCounts(id, filterCat), "subcategory", keys)}
                  </>
                );
              })()}

              {!loading && !err && tab === "types" && (() => {
                const keys = getAvailableTypes(filterCat, filterSubcat);
                return (
                  <>
                    <div className="npx-seq-controls">
                      <div className="npx-seq-control-group">
                        <span className="npx-filter-label">Filter by category</span>
                        <select className="npx-select npx-select-sm" value={filterCat} onChange={(e) => setFilterCat(e.target.value)}>
                          <option value="">All categories</option>
                          {allCats.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                      {filterCat && (
                        <div className="npx-seq-control-group">
                          <span className="npx-filter-label">Filter by subcategory</span>
                          <select className="npx-select npx-select-sm" value={filterSubcat} onChange={(e) => setFilterSubcat(e.target.value)}>
                            <option value="">All subcategories</option>
                            {allSubcats.map((s) => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </div>
                      )}
                      {(filterCat || filterSubcat) && (
                        <button className="npx-clear-filter-link" onClick={() => { setFilterCat(""); setFilterSubcat(""); }}>× clear</button>
                      )}
                    </div>
                    {(filterCat || filterSubcat) && (
                      <div className="npx-stat-context-label">
                        Showing types
                        {filterCat && <> within <strong>{filterCat}</strong></>}
                        {filterSubcat && <> › <strong>{filterSubcat}</strong></>}
                      </div>
                    )}
                    {renderDistTable((id) => getTypeCounts(id, filterCat, filterSubcat), "type", keys)}
                  </>
                );
              })()}

              {!loading && !err && tab === "sequences" && renderSequenceTab()}
            </>
          )}
        </main>
      </div>
    </div>
  );
}


/* ============================================================
   STYLES
   ============================================================ */
export function Style() {
  return (
    <style>{`
      .npx-root {
        --ink: #1B2430;
        --ink-soft: #5B6472;
        --paper: #EEEBE1;
        --paper-raised: #F8F6EF;
        --paper-dark: #E2DECD;
        --rule: #CFC8B4;
        --indigo: #2F4468;
        --indigo-light: #55719C;
        --moss: #4B5D45;
        --amber: #93591D;
        --amber-bg: #EFE0C4;
        --indigo-bg: #DCE3EE;
        --font-display: 'Fraunces', Georgia, serif;
        --font-body: 'IBM Plex Sans', -apple-system, sans-serif;
        --font-mono: 'IBM Plex Mono', ui-monospace, monospace;
        background: var(--paper); color: var(--ink);
        font-family: var(--font-body); min-height: 100vh; line-height: 1.5;
      }
      .npx-root * { box-sizing: border-box; }
      .npx-root button, .npx-root input, .npx-root select { font-family: inherit; color: inherit; }

      /* Header */
      .npx-header { border-bottom: 1px solid var(--rule); background: var(--paper-raised); position: sticky; top: 0; z-index: 10; }
      .npx-header-inner { max-width: 1200px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; padding: 14px 24px; }
      .npx-brand { background: none; border: none; cursor: pointer; display: flex; align-items: center; gap: 12px; text-align: left; padding: 0; }
      .npx-brand-mark { font-family: var(--font-mono); font-weight: 600; font-size: 13px; border: 1px solid var(--ink); width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; border-radius: 3px; }
      .npx-brand-text { font-family: var(--font-display); font-weight: 600; font-size: 18px; display: flex; flex-direction: column; line-height: 1.2; }
      .npx-brand-sub { font-family: var(--font-body); font-weight: 400; font-size: 11.5px; color: var(--ink-soft); }
      .npx-nav { display: flex; gap: 4px; }
      .npx-nav-link { background: none; border: none; cursor: pointer; font-size: 14.5px; padding: 8px 14px; border-radius: 3px; color: var(--ink-soft); }
      .npx-nav-link:hover { color: var(--ink); background: var(--paper-dark); }
      .npx-nav-link.is-active { color: var(--ink); font-weight: 600; background: var(--paper-dark); }

      .npx-page { max-width: 1200px; margin: 0 auto; padding: 0 24px 80px; }

      /* Hero */
      .npx-hero { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 56px; padding: 64px 0 56px; border-bottom: 1px solid var(--rule); }
      .npx-eyebrow { font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.08em; font-size: 12px; color: var(--moss); margin: 0 0 14px; }
      .npx-h1 { font-family: var(--font-display); font-size: 40px; font-weight: 600; line-height: 1.15; margin: 0 0 20px; max-width: 20ch; }
      .npx-lede { font-size: 16px; color: var(--ink-soft); max-width: 46ch; margin: 0 0 28px; }
      .npx-lede-sm { font-size: 15px; color: var(--ink-soft); margin: 4px 0 0; }
      .npx-hero-example { background: var(--paper-raised); border: 1px solid var(--rule); border-radius: 6px; padding: 24px; align-self: start; width: 100%; min-width: 0; height: 320px; min-height: 320px; max-height: 320px; overflow: hidden; display: flex; flex-direction: column; }
      .npx-hero-card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; flex-shrink: 0; }
      .npx-hero-card-header .npx-card-label { margin-bottom: 0; }
      .npx-hero-dots { display: flex; gap: 5px; align-items: center; }
      .npx-hero-dot { width: 7px; height: 7px; border-radius: 50%; border: none; cursor: pointer; background: var(--rule); padding: 0; transition: background 0.2s; }
      .npx-hero-dot.is-active { background: var(--indigo); }
      .npx-hero-dot:hover { background: var(--indigo-light); }
      .npx-hero-fade { opacity: 0; transition: opacity 0.3s ease; flex: 1; display: flex; flex-direction: column; min-height: 0; }
      .npx-hero-fade.is-visible { opacity: 1; }
      .npx-hero-igt-wrap { flex: 1; min-width: 0; min-height: 0; overflow: auto; }
      .npx-hero-meta-footer { flex-shrink: 0; margin-top: 12px; display: flex; flex-direction: column; gap: 5px; }
      .npx-hero-meta-lang { display: flex; align-items: center; }
      .npx-hero-meta-seq { align-self: flex-start; width: fit-content; font-family: var(--font-mono); font-size: 11px; color: var(--amber); background: var(--amber-bg); padding: 3px 9px; border-radius: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; display: inline-block; }
      .npx-hero-view-btn { margin-top: 8px; font-size: 13px; padding: 7px 14px; flex-shrink: 0; align-self: flex-start; }
      .npx-card-label { font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-soft); margin-bottom: 14px; }
      .npx-hero-example-loading { color: var(--ink-soft); font-size: 14px; padding: 20px 0; }

      /* IGT */
      .npx-igt-grid { display: grid; gap: 18px 20px; overflow-x: auto; padding-bottom: 4px; }
      .npx-igt-col { display: flex; flex-direction: column; gap: 4px; }
      .npx-igt-token { font-family: var(--font-mono); font-weight: 500; font-size: 15px; white-space: nowrap; }
      .npx-igt-gloss { font-family: var(--font-mono); font-size: 12.5px; color: var(--indigo); white-space: nowrap; border-top: 1px solid var(--rule); padding-top: 4px; }
      .npx-igt-translation { margin-top: 14px; font-style: italic; color: var(--ink-soft); font-size: 15px; }
      .npx-igt-empty { color: var(--ink-soft); font-size: 13.5px; font-style: italic; }
      .npx-igt-lg .npx-igt-token { font-size: 17px; }

      /* Tags */
      .npx-tag { display: inline-block; font-family: var(--font-mono); font-size: 11.5px; padding: 3px 9px; border-radius: 20px; white-space: nowrap; }
      .npx-tag-indigo { background: var(--indigo-bg); color: var(--indigo); }
      .npx-tag-amber { background: var(--amber-bg); color: var(--amber); }

      /* Buttons */
      .npx-btn { font-family: var(--font-body); font-size: 14px; font-weight: 600; cursor: pointer; border-radius: 4px; border: 1px solid transparent; padding: 11px 18px; transition: background 0.15s; }
      .npx-btn-primary { background: var(--ink); color: var(--paper-raised); }
      .npx-btn-primary:hover { background: var(--indigo); }
      .npx-btn-ghost { background: transparent; color: var(--ink); border-color: var(--rule); }
      .npx-btn-ghost:hover { background: var(--paper-dark); }
      .npx-btn-ghost:disabled { opacity: 0.4; cursor: not-allowed; }
      .npx-btn-small { padding: 8px 12px; font-size: 13px; }

      /* Stats */
      .npx-stats { display: flex; gap: 56px; padding: 36px 0; border-bottom: 1px solid var(--rule); }
      .npx-stat-num { font-family: var(--font-display); font-size: 30px; font-weight: 600; }
      .npx-stat-label { font-size: 13px; color: var(--ink-soft); margin-top: 2px; }

      /* About */
      .npx-about { display: grid; grid-template-columns: 1fr 1fr; gap: 56px; padding: 56px 0; border-bottom: 1px solid var(--rule); }
      .npx-h2 { font-family: var(--font-display); font-size: 22px; font-weight: 600; margin: 0 0 14px; }
      .npx-h3 { font-family: var(--font-display); font-size: 18px; font-weight: 600; margin: 0 0 12px; }
      .npx-about-col p { color: var(--ink-soft); font-size: 15px; margin: 0; }
      .npx-about-col em { color: var(--ink); font-style: normal; font-weight: 600; }
      .npx-tree, .npx-tree ul { list-style: none; margin: 0; padding-left: 18px; font-family: var(--font-mono); font-size: 13.5px; }
      .npx-tree { padding-left: 0; }
      .npx-tree li { border-left: 1px solid var(--rule); padding-left: 14px; margin: 6px 0; }
      .npx-tree > li { border-left: none; padding-left: 0; }
      .npx-cta { padding: 56px 0 20px; text-align: center; }
      .npx-cta p { color: var(--ink-soft); margin: 8px 0 24px; }

      /* Explore layout */
      .npx-explore-header { padding: 40px 0 24px; }
      .npx-h1-sm { font-family: var(--font-display); font-size: 30px; font-weight: 600; margin: 0; }
      .npx-explore-layout { display: flex; flex-direction: column; gap: 24px; }

      /* Explore filters */
      .npx-filter-bar { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid var(--rule); border-radius: 6px; background: rgba(248, 246, 239, 0.55); }
      .npx-filter-row { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 12px; }
      .npx-filter-group { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      .npx-search-filter { flex: 1 1 280px; max-width: 420px; order: 1; }
      .npx-language-filter { flex: 0 1 190px; width: 190px; margin-left: auto; order: 3; }
      .npx-filter-label { font-family: var(--font-mono); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-soft); display: flex; align-items: center; gap: 6px; }
      .npx-filter-badge { background: var(--indigo); color: white; border-radius: 10px; font-size: 10px; padding: 1px 6px; }
      .npx-filter-hint { font-size: 12px; color: var(--ink-soft); margin: 1px 0 0; }
      .npx-search-row { display: flex; gap: 6px; }
      .npx-search-tips { position: relative; display: inline-flex; align-items: center; flex-shrink: 0; }
      .npx-search-tips-button { width: 16px; height: 16px; padding: 0; border: 1px solid var(--ink-soft); border-radius: 50%; background: transparent; color: var(--ink-soft); cursor: help; font-family: var(--font-mono); font-size: 10px; line-height: 14px; text-align: center; }
      .npx-search-tips-button:hover, .npx-search-tips-button:focus-visible { color: var(--ink); border-color: var(--ink); outline: 2px solid var(--indigo); outline-offset: 2px; }
      .npx-search-tips-popover { position: fixed; z-index: 1000; padding: 10px 12px; border: 1px solid var(--rule); border-radius: 4px; background: #F8F6EF; opacity: 1; box-shadow: 0 5px 16px rgba(27, 36, 48, 0.14); color: #1B2430; font-family: var(--font-body); font-size: 12px; font-weight: 400; line-height: 1.6; white-space: normal; }
      .npx-search-tips-popover strong { display: block; margin-bottom: 2px; font-weight: 600; }
      .npx-search-tips-popover code { font-family: var(--font-mono); color: var(--indigo); }
      .npx-input, .npx-select { border: 1px solid var(--rule); background: var(--paper-raised); border-radius: 4px; padding: 8px 10px; font-size: 14px; width: 100%; }
      .npx-filter-bar .npx-input, .npx-filter-bar .npx-select { padding: 6px 8px; }
      .npx-filter-bar .npx-btn-small { padding: 5px 9px; white-space: nowrap; }
      .npx-filter-bar .npx-filter-row .npx-filter-hint { display: none; }
      .npx-search-filter .npx-search-row { gap: 6px; }
      .npx-select-sm { font-size: 12.5px; padding: 6px 8px; }
      .npx-input:focus, .npx-select:focus { outline: 2px solid var(--indigo); outline-offset: 2px; }
      .npx-filter-actions { align-self: flex-end; order: 2; }
      .npx-clear { align-self: flex-start; }

      /* Language checkboxes */
      .npx-lang-checks { display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; border: 1px solid var(--rule); border-radius: 4px; padding: 8px; background: var(--paper-raised); }
      .npx-language-dropdown { position: relative; min-width: 0; }
      .npx-language-dropdown-toggle { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 32px; padding: 6px 8px; border: 1px solid var(--rule); border-radius: 4px; background: var(--paper-raised); color: var(--ink); cursor: pointer; font-size: 13.5px; list-style: none; }
      .npx-language-dropdown-toggle::-webkit-details-marker { display: none; }
      .npx-language-dropdown-toggle:focus-visible { outline: 2px solid var(--indigo); outline-offset: 2px; }
      .npx-language-dropdown-arrow { color: var(--ink-soft); transition: transform 0.15s ease; }
      .npx-language-dropdown[open] .npx-language-dropdown-arrow { transform: rotate(180deg); }
      .npx-language-dropdown-panel { position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; width: 220px; max-height: 260px; box-shadow: 0 5px 16px rgba(27, 36, 48, 0.14); }
      .npx-check-row { display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 3px 4px; border-radius: 3px; font-size: 13.5px; }
      .npx-check-row:hover { background: var(--paper-dark); }
      .npx-checkbox { width: 14px; height: 14px; cursor: pointer; accent-color: var(--indigo); flex-shrink: 0; }
      .npx-check-label { flex: 1; }
      .npx-check-iso { font-family: var(--font-mono); font-size: 10.5px; color: var(--ink-soft); border: 1px solid var(--rule); border-radius: 2px; padding: 1px 4px; }

      /* Sequence builder */
      .npx-seqbuilder { display: flex; flex-direction: column; gap: 8px; }
      .npx-seqbuilder-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 18px; }
      .npx-filter-bar .npx-seqbuilder { gap: 4px; min-width: 0; border-top: 1px solid var(--rule); padding-top: 8px; }
      .npx-filter-bar .npx-seqbuilder:not(.has-slots) > .npx-filter-hint,
      .npx-filter-bar .npx-seqbuilder:not(.has-slots) > .npx-seq-empty { display: none; }
      .npx-filter-bar .npx-seqbuilder.has-slots > .npx-filter-hint { margin-top: -2px; }
      .npx-seq-empty { font-size: 12.5px; color: var(--ink-soft); font-style: italic; padding: 8px 0; }
      .npx-seq-slots { display: flex; flex-direction: column; gap: 6px; }
      .npx-filter-bar .npx-seq-slots { flex-direction: column; flex-wrap: nowrap; }
      .npx-seq-slot { display: flex; align-items: flex-start; gap: 6px; background: var(--paper-raised); border: 1px solid var(--rule); border-radius: 5px; padding: 8px; }
      .npx-filter-bar .npx-seq-slot { flex: none; width: 100%; }
      .npx-seq-slot.is-dragging { border-color: var(--indigo-light); box-shadow: 0 3px 10px rgba(47, 68, 104, 0.16); }
      .npx-seq-slot-handle { color: var(--ink-soft); font-size: 14px; padding-top: 4px; user-select: none; cursor: grab; touch-action: none; }
      .npx-seq-slot-handle:active { cursor: grabbing; }
      .npx-seq-slot-num { font-family: var(--font-mono); font-size: 11px; color: var(--indigo); background: var(--indigo-bg); border-radius: 3px; padding: 2px 6px; margin-top: 4px; white-space: nowrap; }
      .npx-seq-slot-arrows { display: flex; flex-direction: column; gap: 2px; margin-top: 1px; }
      .npx-seq-arrow { width: 20px; height: 17px; padding: 0; border: 1px solid var(--rule); border-radius: 3px; background: transparent; color: var(--ink-soft); cursor: pointer; font-size: 13px; line-height: 14px; }
      .npx-seq-arrow:hover:not(:disabled) { background: var(--paper-dark); color: var(--ink); }
      .npx-seq-arrow:disabled { opacity: 0.3; cursor: not-allowed; }
      .npx-seq-slot-fields { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
      .npx-filter-bar .npx-seq-slot-fields { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
      .npx-seq-remove { background: none; border: none; cursor: pointer; color: var(--ink-soft); font-size: 18px; line-height: 1; padding: 2px 4px; border-radius: 3px; }
      .npx-seq-remove:hover { color: #9C3B2E; background: #F5E8E6; }
      .npx-seq-add { align-self: flex-start; font-size: 12.5px; padding: 6px 12px; }
      .npx-seq-word-row { display: flex; align-items: center; gap: 4px; margin-top: 2px; }
      .npx-seq-word-input { font-style: italic; color: var(--moss); border-color: var(--rule); }
      .npx-seq-word-input::placeholder { color: var(--ink-soft); font-style: italic; }
      .npx-seq-word-input:not(:placeholder-shown) { border-color: var(--moss); background: #F2F6F2; font-style: normal; }

      /* Results area */
      .npx-results { min-width: 0; }
      .npx-results-bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; gap: 12px; flex-wrap: wrap; }
      .npx-results-count { font-size: 13.5px; color: var(--ink-soft); }
      .npx-results-controls { display: flex; align-items: center; gap: 6px; }
      .npx-pagesize-btn { background: none; border: 1px solid var(--rule); border-radius: 3px; cursor: pointer; font-size: 13px; padding: 4px 10px; color: var(--ink-soft); }
      .npx-pagesize-btn:hover { background: var(--paper-dark); color: var(--ink); }
      .npx-pagesize-btn.is-active { background: var(--ink); color: var(--paper-raised); border-color: var(--ink); }

      /* Results table */
      .npx-table-wrap { overflow-x: auto; border: 1px solid var(--rule); border-radius: 6px; }
      .npx-results-table { width: 100%; border-collapse: collapse; font-size: 14px; }
      .npx-results-table th { text-align: left; font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-soft); border-bottom: 1px solid var(--rule); padding: 10px 14px; background: var(--paper-raised); white-space: nowrap; }
      .npx-table-sort { display: inline-flex; align-items: center; gap: 5px; margin: -4px -6px; padding: 4px 6px; border: 0; border-radius: 3px; background: transparent; color: inherit; cursor: pointer; font: inherit; text-transform: inherit; letter-spacing: inherit; }
      .npx-table-sort:hover { background: var(--paper-dark); color: var(--ink); }
      .npx-table-sort:focus-visible { outline: 2px solid var(--indigo); outline-offset: 1px; }
      .npx-table-sort span { color: var(--indigo); font-size: 12px; }
      .npx-results-table td { padding: 11px 14px; border-bottom: 1px solid var(--paper-dark); vertical-align: top; }
      .npx-result-row { cursor: pointer; transition: background 0.1s; }
      .npx-result-row:hover { background: var(--paper-raised); }
      .npx-result-row:last-child td { border-bottom: none; }
      .npx-result-main { font-family: var(--font-display); font-size: 15px; font-weight: 500; }
      .npx-result-translation { font-style: italic; color: var(--ink-soft); font-size: 13.5px; }
      .npx-result-context { font-size: 13px; color: var(--ink-soft); max-width: 300px; }
      .npx-ctx-text { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .npx-ctx-none { opacity: 0.4; }

      .npx-empty, .npx-error { border: 1px dashed var(--rule); border-radius: 6px; padding: 28px; }
      .npx-empty-title, .npx-error-title { font-weight: 600; margin-bottom: 6px; }
      .npx-empty-body, .npx-error-body { color: var(--ink-soft); font-size: 14px; margin-bottom: 12px; }

      .npx-pagination { display: flex; align-items: center; gap: 16px; justify-content: center; margin-top: 24px; }
      .npx-pagination-status { font-size: 13.5px; color: var(--ink-soft); font-family: var(--font-mono); }

      /* Detail */
      .npx-back { background: none; border: none; cursor: pointer; color: var(--ink-soft); font-size: 13.5px; padding: 20px 0 8px; display: block; }
      .npx-back:hover { color: var(--ink); }
      .npx-detail-loading { padding: 60px 0; color: var(--ink-soft); }
      .npx-detail-layout { display: grid; grid-template-columns: 1fr 280px; gap: 48px; padding-bottom: 40px; }
      .npx-detail-title { font-family: var(--font-display); font-size: 32px; font-weight: 600; line-height: 1.2; margin: 8px 0 20px; }
      .npx-detail-tags { display: flex; gap: 8px; margin: 18px 0 8px; flex-wrap: wrap; }
      .npx-section { margin-top: 36px; }
      .npx-muted { color: var(--ink-soft); font-size: 14px; }
      .npx-context-block { margin: 0; padding: 14px 18px; border-left: 3px solid var(--indigo-light); background: var(--paper-raised); border-radius: 0 4px 4px 0; font-size: 15px; color: var(--ink-soft); font-style: italic; }

      .npx-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
      .npx-table th { text-align: left; font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-soft); border-bottom: 1px solid var(--rule); padding: 8px 10px; }
      .npx-table td { padding: 9px 10px; border-bottom: 1px solid var(--paper-dark); }
      .npx-mono { font-family: var(--font-mono); }

      .npx-detail-side { border-left: 1px solid var(--rule); padding-left: 32px; }
      .npx-meta-list { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; margin: 0 0 32px; }
      .npx-meta-list dt { font-size: 12px; color: var(--ink-soft); font-family: var(--font-mono); }
      .npx-meta-list dd { margin: 0; font-size: 13.5px; }
      .npx-related-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
      .npx-related-link { background: none; border: none; text-align: left; cursor: pointer; font-size: 13.5px; color: var(--indigo); padding: 0; font-family: var(--font-display); font-weight: 500; }
      .npx-related-link:hover { text-decoration: underline; }
      .npx-related-translation { color: var(--ink-soft); font-style: italic; font-family: var(--font-body); font-weight: 400; }

      /* Languages page */
      .npx-lang-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; padding-bottom: 48px; }
      .npx-lang-card { text-align: left; background: var(--paper-raised); border: 1px solid var(--rule); border-radius: 6px; padding: 18px 20px; cursor: pointer; display: flex; flex-direction: column; gap: 10px; transition: border-color 0.15s, transform 0.1s; }
      .npx-lang-card:hover { border-color: var(--indigo-light); transform: translateY(-1px); }
      .npx-lang-card-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
      .npx-lang-name { font-family: var(--font-display); font-size: 17px; font-weight: 600; }
      .npx-lang-iso { font-family: var(--font-mono); font-size: 11px; color: var(--ink-soft); border: 1px solid var(--rule); border-radius: 3px; padding: 2px 6px; }
      .npx-lang-count-num { font-family: var(--font-display); font-size: 22px; font-weight: 600; color: var(--indigo); }
      .npx-lang-count-label { font-size: 12.5px; color: var(--ink-soft); }

      /* Dots loader */
      .npx-dots { display: inline-flex; gap: 3px; vertical-align: middle; margin-right: 4px; }
      .npx-dots span { width: 4px; height: 4px; border-radius: 50%; background: var(--ink-soft); animation: npx-blink 1.1s infinite ease-in-out; }
      .npx-dots span:nth-child(2) { animation-delay: 0.15s; }
      .npx-dots span:nth-child(3) { animation-delay: 0.3s; }
      @keyframes npx-blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }


      /* Category sequence in table */
      .npx-result-catseq { max-width: 220px; }
      .npx-catseq { font-family: var(--font-mono); font-size: 11.5px; color: var(--amber); background: var(--amber-bg); padding: 3px 8px; border-radius: 3px; display: inline-block; line-height: 1.4; }

      /* Export button */
      .npx-export-btn { border-color: var(--moss); color: var(--moss); margin-left: 8px; }
      .npx-export-btn:hover:not(:disabled) { background: #D8E4D6; }
      .npx-export-btn:disabled { opacity: 0.35; cursor: not-allowed; }

      /* Statistics page */
      .npx-stat-layout { display: grid; grid-template-columns: 240px 1fr; gap: 40px; align-items: start; }
      .npx-stat-sidebar { position: sticky; top: 76px; display: flex; flex-direction: column; gap: 16px; max-height: calc(100vh - 90px); overflow-y: auto; padding-bottom: 16px; }
      .npx-stat-legend { display: flex; flex-direction: column; gap: 8px; padding: 12px 0; border-top: 1px solid var(--rule); }
      .npx-legend-row { display: flex; align-items: center; gap: 8px; font-size: 13.5px; }
      .npx-legend-swatch { width: 12px; height: 12px; border-radius: 2px; flex-shrink: 0; }
      .npx-check-disabled { opacity: 0.4; cursor: not-allowed; }

      .npx-stat-main { min-width: 0; }
      .npx-stat-tabs { display: flex; gap: 4px; margin-bottom: 24px; border-bottom: 1px solid var(--rule); }
      .npx-stat-tab { background: none; border: none; cursor: pointer; font-size: 14px; padding: 10px 16px; color: var(--ink-soft); border-bottom: 2px solid transparent; margin-bottom: -1px; border-radius: 3px 3px 0 0; }
      .npx-stat-tab:hover { color: var(--ink); background: var(--paper-dark); }
      .npx-stat-tab.is-active { color: var(--indigo); font-weight: 600; border-bottom-color: var(--indigo); }

      .npx-stat-context-label { font-size: 13.5px; color: var(--ink-soft); margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
      .npx-stat-context-label strong { color: var(--ink); }
      .npx-clear-filter-link { background: none; border: none; cursor: pointer; color: var(--ink-soft); font-size: 12px; padding: 2px 6px; border-radius: 3px; }
      .npx-clear-filter-link:hover { background: var(--paper-dark); color: var(--ink); }

      .npx-stat-table-wrap { overflow-x: auto; border: 1px solid var(--rule); border-radius: 6px; }
      .npx-stat-table { width: 100%; border-collapse: collapse; font-size: 13.5px; table-layout: auto; }
      .npx-stat-table th { text-align: center; font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid var(--rule); padding: 9px 14px; background: var(--paper-raised); white-space: nowrap; vertical-align: bottom; }
      .npx-stat-th-label { text-align: left; color: var(--ink-soft); vertical-align: middle; }
      .npx-stat-th-lang { text-align: center; border-bottom-width: 2px !important; }
      .npx-stat-subth { color: var(--ink-soft); font-size: 10px; font-weight: 400; border-top: none; padding-top: 4px; padding-bottom: 8px; text-align: center; }
      .npx-stat-table td { padding: 8px 14px; border-bottom: 1px solid var(--paper-dark); vertical-align: middle; text-align: center; }
      .npx-stat-row:last-of-type td { border-bottom: none; }
      .npx-stat-key { font-family: var(--font-mono); font-size: 12.5px; white-space: nowrap; min-width: 160px; text-align: left; }
      .npx-stat-count { font-family: var(--font-mono); font-size: 13px; min-width: 60px; }
      .npx-stat-pct { font-family: var(--font-mono); font-size: 12px; min-width: 64px; }
      .npx-stat-total-row { border-top: 2px solid var(--rule); }
      .npx-stat-total-row td { padding-top: 10px; padding-bottom: 10px; background: var(--paper-raised); }

      /* Mini bar (used in stacked breakdown only now) */
      .npx-minibar-wrap { display: flex; align-items: center; gap: 6px; }
      .npx-minibar-track { flex: 1; height: 10px; border-radius: 5px; overflow: hidden; min-width: 60px; }
      .npx-minibar-fill { height: 100%; border-radius: 5px; transition: width 0.3s ease; }
      .npx-minibar-val { font-family: var(--font-mono); font-size: 11.5px; color: var(--ink); min-width: 24px; text-align: right; }
      .npx-minibar-pct { font-family: var(--font-mono); font-size: 11px; color: var(--ink-soft); min-width: 40px; }

      /* Sequence tab controls */
      .npx-seq-controls { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 16px; margin-bottom: 20px; padding: 14px 16px; background: var(--paper-raised); border: 1px solid var(--rule); border-radius: 6px; }
      .npx-seq-control-group { display: flex; flex-direction: column; gap: 5px; }
      .npx-seg-btns { display: flex; gap: 4px; }

      /* Stacked proportion bars */
      .npx-stat-bars-section { padding-bottom: 20px; }
      .npx-stackbar-list { display: flex; flex-direction: column; gap: 20px; }
      .npx-stackbar-row { display: flex; flex-direction: column; gap: 6px; }
      .npx-stackbar-label { font-family: var(--font-display); font-size: 14px; font-weight: 600; }
      .npx-stackbar-track { display: flex; height: 28px; border-radius: 4px; overflow: hidden; width: 100%; }
      .npx-stackbar-seg { height: 100%; transition: width 0.3s ease; }
      .npx-stackbar-breakdown { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12px; }
      .npx-stackbar-item { display: flex; gap: 3px; align-items: center; }

      /* Sequence heatmap */
      .npx-seq-matrix-block { margin-bottom: 48px; }
      .npx-seq-matrix-title { font-family: var(--font-display); font-size: 16px; font-weight: 600; margin-bottom: 12px; display: flex; align-items: center; }
      .npx-heat-wrap { overflow-x: auto; border: 1px solid var(--rule); border-radius: 6px; }
      .npx-heat-table { border-collapse: collapse; font-size: 12.5px; }
      .npx-heat-corner { background: var(--paper-raised); border-bottom: 1px solid var(--rule); border-right: 1px solid var(--rule); padding: 8px 12px; font-family: var(--font-mono); font-size: 10px; color: var(--ink-soft); white-space: nowrap; }
      .npx-heat-th { background: var(--paper-raised); border-bottom: 1px solid var(--rule); border-right: 1px solid var(--paper-dark); padding: 8px 12px; font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; }
      .npx-heat-total { border-left: 2px solid var(--rule); font-weight: 600; }
      .npx-heat-rowlabel { background: var(--paper-raised); border-right: 1px solid var(--rule); border-bottom: 1px solid var(--paper-dark); padding: 8px 12px; font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; font-weight: 600; }
      .npx-heat-cell { text-align: center; border-right: 1px solid var(--paper-dark); border-bottom: 1px solid var(--paper-dark); padding: 7px 10px; font-family: var(--font-mono); font-size: 12px; min-width: 48px; transition: background 0.2s; }
      .npx-heat-rowtotal { background: var(--paper-raised) !important; border-left: 2px solid var(--rule); font-weight: 600; color: var(--ink-soft); }
      .npx-heat-zero { color: var(--rule); font-size: 16px; }

      /* Admin data migration */
      .npx-admin-page { padding-top: 40px; }
      .npx-admin-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 24px; }
      .npx-admin-header .npx-eyebrow, .npx-admin-login .npx-eyebrow { margin-bottom: 8px; }
      .npx-admin-account { display: flex; align-items: center; gap: 12px; color: var(--ink-soft); font-size: 13px; }
      .npx-admin-panel { margin-bottom: 18px; padding: 20px; border: 1px solid var(--rule); border-radius: 6px; background: var(--paper-raised); }
      .npx-admin-panel > .npx-h3 { margin-bottom: 14px; }
      .npx-admin-metadata { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
      .npx-admin-role-files { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
      .npx-admin-upload { display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 0; min-height: 104px; padding: 16px; border: 1px dashed var(--rule); border-radius: 6px; background: var(--paper); cursor: pointer; text-align: center; }
      .npx-admin-upload:hover, .npx-admin-upload.has-files { border-color: var(--indigo-light); background: var(--indigo-bg); }
      .npx-admin-upload input { position: absolute; width: 1px; height: 1px; overflow: hidden; opacity: 0; }
      .npx-admin-upload strong { font-family: var(--font-display); font-size: 15px; }
      .npx-admin-upload span { max-width: 100%; margin-top: 5px; overflow: hidden; color: var(--ink-soft); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
      .npx-admin-upload small { margin-top: 3px; color: var(--ink-soft); font-family: var(--font-mono); font-size: 10.5px; }
      .npx-admin-file-summary { margin-top: 10px; color: var(--ink-soft); font-family: var(--font-mono); font-size: 11.5px; }
      .npx-admin-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
      .npx-admin-actions .npx-btn:disabled { cursor: not-allowed; opacity: 0.4; }
      .npx-admin-message { margin-top: 14px; padding: 10px 12px; border: 1px solid var(--rule); border-radius: 4px; font-size: 13.5px; }
      .npx-admin-message.is-error { border-color: #C98F88; background: #F5E8E6; color: #7D2E24; }
      .npx-admin-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
      .npx-admin-section-heading .npx-h3 { margin: 0; }
      .npx-admin-status { padding: 3px 8px; border-radius: 20px; background: var(--paper-dark); color: var(--ink-soft); font-family: var(--font-mono); font-size: 10.5px; text-transform: uppercase; }
      .npx-admin-status.is-success, .npx-admin-status.is-completed { background: #D8E4D6; color: var(--moss); }
      .npx-admin-status.is-error, .npx-admin-status.is-failed, .npx-admin-status.is-completed_with_errors { background: #F5E8E6; color: #7D2E24; }
      .npx-admin-status.is-running { background: var(--indigo-bg); color: var(--indigo); }
      .npx-admin-summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 14px 0; }
      .npx-admin-summary-card { display: flex; flex-direction: column; padding: 12px; border: 1px solid var(--rule); border-radius: 4px; background: var(--paper); }
      .npx-admin-summary-card strong { font-family: var(--font-display); font-size: 22px; }
      .npx-admin-summary-card span { color: var(--ink-soft); font-family: var(--font-mono); font-size: 10.5px; text-transform: uppercase; }
      .npx-admin-issues { display: flex; flex-direction: column; gap: 6px; margin: 12px 0 0; padding: 0; list-style: none; }
      .npx-admin-issues li { padding: 8px 10px; border-left: 3px solid var(--rule); background: var(--paper); font-size: 13px; }
      .npx-admin-issues li.is-error { border-left-color: #9C3B2E; color: #7D2E24; }
      .npx-admin-issues li.is-warning { border-left-color: var(--amber); color: var(--amber); }
      .npx-admin-progress { height: 8px; overflow: hidden; border-radius: 4px; background: var(--paper-dark); }
      .npx-admin-progress > div { height: 100%; border-radius: inherit; background: var(--indigo); transition: width 0.25s ease; }
      .npx-admin-progress-label { display: flex; justify-content: space-between; gap: 12px; margin-top: 6px; color: var(--ink-soft); font-size: 12.5px; }
      .npx-admin-results-table td:not(:first-child), .npx-admin-results-table th:not(:first-child) { text-align: right; }
      .npx-admin-failures { margin-top: 20px; }
      .npx-admin-login { max-width: 440px; margin: 40px auto; padding: 28px; border: 1px solid var(--rule); border-radius: 6px; background: var(--paper-raised); }
      .npx-admin-login-form { display: flex; flex-direction: column; gap: 14px; margin-top: 24px; }
      .npx-admin-login-form .npx-btn { align-self: flex-start; }

      .npx-footer { text-align: center; font-size: 12.5px; color: var(--ink-soft); padding: 32px 24px; border-top: 1px solid var(--rule); }

      @media (prefers-reduced-motion: reduce) {
        .npx-dots span { animation: none; }
        .npx-lang-card { transition: none; }
      }
      @media (max-width: 900px) {
        .npx-hero { grid-template-columns: 1fr; padding-top: 40px; }
        .npx-about { grid-template-columns: 1fr; }
        .npx-filter-bar .npx-seq-slot-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .npx-detail-layout { grid-template-columns: 1fr; }
        .npx-detail-side { border-left: none; padding-left: 0; border-top: 1px solid var(--rule); padding-top: 24px; }
        .npx-h1 { font-size: 30px; }
      }
      @media (max-width: 600px) {
        .npx-filter-bar { padding: 14px; }
        .npx-filter-row { align-items: stretch; }
        .npx-search-filter { flex-basis: 100%; max-width: none; }
        .npx-language-filter { flex: 1 1 100%; width: 100%; margin-left: 0; order: 2; }
        .npx-filter-actions { align-self: flex-start; order: 3; }
        .npx-language-dropdown-panel { position: static; width: auto; max-height: 180px; margin-top: 4px; box-shadow: none; }
        .npx-filter-bar .npx-seq-slot-fields { grid-template-columns: 1fr; }
        .npx-results-controls { flex-wrap: wrap; }
        .npx-admin-header { flex-direction: column; }
        .npx-admin-account { width: 100%; justify-content: space-between; }
        .npx-admin-metadata, .npx-admin-role-files { grid-template-columns: 1fr; }
        .npx-admin-summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .npx-admin-actions { align-items: stretch; flex-direction: column; }
        .npx-admin-actions .npx-btn { width: 100%; }
      }
    `}</style>
  );
}
