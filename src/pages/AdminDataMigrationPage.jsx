import { useEffect, useMemo, useState } from "react";
import { AdminLogin, AdminPageHeader, adminRequest, useAdminSession } from "../components/AdminAccess.jsx";


const TERMINAL_STATUSES = new Set(["completed", "completed_with_errors", "failed", "canceled"]);
const FILE_ROLES = [
  { key: "lexicon", label: "Lexicon table" },
  { key: "phrases", label: "Phrases table" },
  { key: "tokens", label: "Tokens table" },
  { key: "annotations", label: "Annotations table" },
];

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function filesFormData(files, metadata = {}) {
  const form = new FormData();
  FILE_ROLES.forEach(({ key }) => {
    if (files[key]) form.append(key, files[key]);
  });
  Object.entries(metadata).forEach(([key, value]) => form.append(key, value));
  return form;
}

function IssueList({ issues }) {
  if (!issues?.length) return null;
  return (
    <ul className="npx-admin-issues">
      {issues.map((issue, index) => (
        <li key={`${issue.table || "bundle"}-${issue.row || 0}-${index}`} className={issue.level === "error" ? "is-error" : "is-warning"}>
          {issue.table && <strong>{issue.table}{issue.row ? ` row ${issue.row}` : ""}: </strong>}
          {issue.message}
        </li>
      ))}
    </ul>
  );
}

function reviewFieldLabel(name) {
  return name.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ReviewRecord({ title, fields, matchedOn }) {
  return (
    <div className="npx-admin-review-record">
      <div className="npx-admin-review-record-title">
        <strong>{title}</strong>
        {matchedOn && <span>{matchedOn}</span>}
      </div>
      <dl>
        {Object.entries(fields || {}).map(([name, value]) => (
          <div key={name}>
            <dt>{reviewFieldLabel(name)}</dt>
            <dd>{value === null || value === undefined || value === "" ? "—" : String(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function AdminDataMigrationPage() {
  const { token, admin, authState, authenticate, signOut } = useAdminSession();
  const [files, setFiles] = useState({});
  const [sourceName, setSourceName] = useState("");
  const [annotatorName, setAnnotatorName] = useState("");
  const [validation, setValidation] = useState(null);
  const [validating, setValidating] = useState(false);
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [selectedMatchId, setSelectedMatchId] = useState("");
  const [applyToAll, setApplyToAll] = useState(false);

  const pendingReviewItems = useMemo(
    () => (job?.review?.items || []).filter((item) => !item.decision),
    [job?.review?.items]
  );
  const currentReviewItem = pendingReviewItems[0] || null;

  useEffect(() => {
    setSelectedMatchId(currentReviewItem?.matches?.[0]?.id || "");
    setApplyToAll(false);
  }, [currentReviewItem?.id]);

  useEffect(() => {
    if (!job?.id || TERMINAL_STATUSES.has(job.status)) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const nextJob = await adminRequest(`/api/admin/migrations/${job.id}`, token);
        if (!cancelled) setJob(nextJob);
      } catch (pollError) {
        if (!cancelled) setError(pollError.message);
      }
    };
    const interval = window.setInterval(poll, 1000);
    poll();
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [job?.id, job?.status, token]);

  const fileSummary = useMemo(() => ({
    count: FILE_ROLES.filter(({ key }) => files[key]).length,
    size: FILE_ROLES.reduce((total, { key }) => total + (files[key]?.size || 0), 0),
  }), [files]);
  const hasAllFiles = fileSummary.count === FILE_ROLES.length;

  const chooseFile = (role, event) => {
    const file = event.target.files?.[0] || null;
    setFiles((current) => ({ ...current, [role]: file }));
    setValidation(null);
    setJob(null);
    setError("");
  };

  const validateFiles = async () => {
    setValidating(true);
    setError("");
    setValidation(null);
    try {
      const report = await adminRequest("/api/admin/migrations/validate", token, {
        method: "POST",
        body: filesFormData(files),
      });
      setValidation(report);
    } catch (validationError) {
      if (validationError.status === 401 || validationError.status === 403) {
        signOut();
      }
      setError(validationError.message);
      const serverValidation = validationError.payload?.detail?.validation;
      if (serverValidation) setValidation(serverValidation);
    } finally {
      setValidating(false);
    }
  };

  const startMigration = async () => {
    setError("");
    try {
      const nextJob = await adminRequest("/api/admin/migrations", token, {
        method: "POST",
        body: filesFormData(files, {
          source_name: sourceName.trim(),
          annotator_name: annotatorName.trim(),
        }),
      });
      setJob(nextJob);
    } catch (migrationError) {
      setError(migrationError.message);
      const serverValidation = migrationError.payload?.detail?.validation;
      if (serverValidation) setValidation(serverValidation);
    }
  };

  const submitReviewDecision = async (action) => {
    if (!currentReviewItem) return;
    if (action === "cancel" && !window.confirm("Cancel this migration? No records from this migration will be imported.")) return;
    setReviewSubmitting(true);
    setError("");
    try {
      const nextJob = await adminRequest(`/api/admin/migrations/${job.id}/review`, token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          review_id: currentReviewItem.id,
          action,
          match_id: action === "use_existing" ? selectedMatchId : null,
          apply_to_all: currentReviewItem.kind === "exact_duplicate" && applyToAll,
        }),
      });
      setJob(nextJob);
    } catch (reviewError) {
      if (reviewError.status === 401 || reviewError.status === 403) signOut();
      setError(reviewError.message);
    } finally {
      setReviewSubmitting(false);
    }
  };

  if (authState === "checking") {
    return <div className="npx-page npx-admin-page"><div className="npx-detail-loading">Checking administrator access…</div></div>;
  }
  if (authState !== "authenticated") {
    return <AdminLogin onAuthenticated={authenticate} description="Use an authorised NPIndex administrator account to access data migration." />;
  }

  const isRunning = job && !TERMINAL_STATUSES.has(job.status);
  const result = job?.result;
  const reviewSummary = result?.review_summary || job?.review_summary;
  const progress = job?.progress || { percent: 0, processed: 0, total: 0, message: "Ready." };

  return (
    <div className="npx-page npx-admin-page">
      <AdminPageHeader
        admin={admin}
        title="Data migration"
        description="Validate and import a four-file NPIndex CSV bundle."
        onSignOut={signOut}
        backTo="/admin"
      />

      <section className="npx-admin-panel">
        <h2 className="npx-h3">1. Dataset metadata</h2>
        <div className="npx-admin-metadata">
          <label className="npx-filter-group">
            <span className="npx-filter-label">Source / corpus name</span>
            <input className="npx-input" value={sourceName} onChange={(event) => setSourceName(event.target.value)} disabled={isRunning} placeholder="e.g. Corpus or publication title" />
          </label>
          <label className="npx-filter-group">
            <span className="npx-filter-label">Annotator name</span>
            <input className="npx-input" value={annotatorName} onChange={(event) => setAnnotatorName(event.target.value)} disabled={isRunning} placeholder="Full name" />
          </label>
        </div>
      </section>

      <section className="npx-admin-panel">
        <h2 className="npx-h3">2. Upload data</h2>
        <p className="npx-muted">Select the CSV file that belongs to each pipeline table. Validation checks every file against its assigned role.</p>
        <div className="npx-admin-role-files">
          {FILE_ROLES.map(({ key, label }) => {
            const file = files[key];
            return (
              <label className={`npx-admin-upload${file ? " has-files" : ""}`} key={key}>
                <input type="file" accept=".csv,text/csv" onChange={(event) => chooseFile(key, event)} disabled={isRunning} />
                <strong>Select file for: {label}</strong>
                <span>{file ? file.name : "Choose CSV file"}</span>
                {file && <small>{formatBytes(file.size)}</small>}
              </label>
            );
          })}
        </div>
        {fileSummary.count > 0 && (
          <div className="npx-admin-file-summary">
            {fileSummary.count} of {FILE_ROLES.length} files selected · {formatBytes(fileSummary.size)} combined
          </div>
        )}
        <div className="npx-admin-actions">
          <button className="npx-btn npx-btn-ghost" onClick={validateFiles} disabled={!hasAllFiles || validating || isRunning}>
            {validating ? "Validating…" : "Validate files"}
          </button>
          <button
            className="npx-btn npx-btn-primary"
            onClick={startMigration}
            disabled={!validation?.valid || !sourceName.trim() || !annotatorName.trim() || isRunning}
          >
            {isRunning ? "Migration running…" : "Start Migration / Import Data"}
          </button>
        </div>
        {error && <div className="npx-admin-message is-error">{error}</div>}
      </section>

      {validation && (
        <section className="npx-admin-panel">
          <div className="npx-admin-section-heading">
            <h2 className="npx-h3">Validation</h2>
            <span className={`npx-admin-status ${validation.valid ? "is-success" : "is-error"}`}>
              {validation.valid ? "Ready to import" : "Invalid bundle"}
            </span>
          </div>
          <div className="npx-admin-summary-grid">
            {Object.entries(validation.row_counts || {}).map(([table, count]) => (
              <div className="npx-admin-summary-card" key={table}><strong>{count}</strong><span>{table}</span></div>
            ))}
          </div>
          {validation.languages?.length > 0 && <p className="npx-muted">Languages: {validation.languages.join(", ")}</p>}
          <IssueList issues={validation.issues} />
        </section>
      )}

      {job?.status === "review_required" && currentReviewItem && (
        <section className="npx-admin-panel npx-admin-review-panel">
          <div className="npx-admin-section-heading">
            <div>
              <p className="npx-eyebrow">Manual confirmation required</p>
              <h2 className="npx-h3">{currentReviewItem.reason_label}</h2>
            </div>
            <span className="npx-admin-status is-review_required">
              {pendingReviewItems.length} pending
            </span>
          </div>
          <p className="npx-admin-review-intro">
            Review the incoming {currentReviewItem.record_type} beside the closest existing database record{currentReviewItem.matches.length === 1 ? "" : "s"}.
            No automatic merge or insert will occur until you decide.
          </p>
          <div className="npx-admin-review-comparison">
            <ReviewRecord title="Incoming value" fields={currentReviewItem.incoming} />
            <div className="npx-admin-review-matches">
              {currentReviewItem.matches.map((match, index) => (
                <label className={`npx-admin-review-match${selectedMatchId === match.id ? " is-selected" : ""}${currentReviewItem.kind === "similarity" ? "" : " is-static"}`} key={`${match.id}-${index}`}>
                  {currentReviewItem.kind === "similarity" && (
                    <input
                      type="radio"
                      name={`review-match-${currentReviewItem.id}`}
                      value={match.id}
                      checked={selectedMatchId === match.id}
                      onChange={() => setSelectedMatchId(match.id)}
                    />
                  )}
                  <ReviewRecord
                    title={currentReviewItem.kind === "similarity" ? `Existing suggestion · ${Math.round((match.similarity || 0) * 100)}% similar` : "Existing database record"}
                    fields={match.fields}
                    matchedOn={match.matched_on}
                  />
                </label>
              ))}
            </div>
          </div>

          {currentReviewItem.kind === "similarity" ? (
            <>
              <p className="npx-admin-review-note">
                Skipping source or annotator metadata also skips its dependent import records because sessions require both values.
              </p>
              <div className="npx-admin-review-actions">
                <button className="npx-btn npx-btn-primary" onClick={() => submitReviewDecision("use_existing")} disabled={reviewSubmitting || !selectedMatchId}>Use Existing Value</button>
                <button className="npx-btn npx-btn-ghost" onClick={() => submitReviewDecision("use_imported")} disabled={reviewSubmitting}>Use Imported Value</button>
                <button className="npx-btn npx-btn-ghost" onClick={() => submitReviewDecision("skip_record")} disabled={reviewSubmitting}>Skip Record</button>
                <button className="npx-btn npx-btn-danger" onClick={() => submitReviewDecision("cancel")} disabled={reviewSubmitting}>Cancel Migration</button>
              </div>
            </>
          ) : (
            <>
              {currentReviewItem.kind === "exact_duplicate" && pendingReviewItems.filter((item) => item.kind === "exact_duplicate").length > 1 && (
                <label className="npx-admin-review-batch">
                  <input type="checkbox" checked={applyToAll} onChange={(event) => setApplyToAll(event.target.checked)} />
                  Apply this decision to all {pendingReviewItems.filter((item) => item.kind === "exact_duplicate").length} pending exact duplicates
                </label>
              )}
              <div className="npx-admin-review-actions">
                <button className="npx-btn npx-btn-ghost" onClick={() => submitReviewDecision("skip_duplicate")} disabled={reviewSubmitting}>Skip Duplicate and Continue</button>
                <button className="npx-btn npx-btn-primary" onClick={() => submitReviewDecision("import_anyway")} disabled={reviewSubmitting}>Import Anyway</button>
                <button className="npx-btn npx-btn-danger" onClick={() => submitReviewDecision("cancel")} disabled={reviewSubmitting}>Cancel Migration</button>
              </div>
            </>
          )}
        </section>
      )}

      {job && (
        <section className="npx-admin-panel">
          <div className="npx-admin-section-heading">
            <h2 className="npx-h3">Migration status</h2>
            <span className={`npx-admin-status is-${job.status}`}>{job.status.replaceAll("_", " ")}</span>
          </div>
          <div className="npx-admin-progress" aria-label={`Migration ${progress.percent}% complete`}>
            <div style={{ width: `${progress.percent || 0}%` }} />
          </div>
          <div className="npx-admin-progress-label">
            <span>{progress.message}</span>
            <span>{progress.percent || 0}%</span>
          </div>
          <div className="npx-admin-summary-grid">
            <div className="npx-admin-summary-card"><strong>{result?.processed ?? progress.processed ?? 0}</strong><span>processed</span></div>
            <div className="npx-admin-summary-card"><strong>{result?.successful ?? 0}</strong><span>successful</span></div>
            <div className="npx-admin-summary-card"><strong>{result?.skipped ?? 0}</strong><span>skipped</span></div>
            <div className="npx-admin-summary-card"><strong>{result?.failed ?? 0}</strong><span>failed</span></div>
          </div>
          {reviewSummary?.total_flagged > 0 && (
            <div className="npx-admin-review-summary">
              <h3 className="npx-h3">Review summary</h3>
              <div className="npx-admin-summary-grid">
                <div className="npx-admin-summary-card"><strong>{reviewSummary.total_flagged}</strong><span>flagged</span></div>
                <div className="npx-admin-summary-card"><strong>{reviewSummary.resolved}</strong><span>resolved</span></div>
                <div className="npx-admin-summary-card"><strong>{reviewSummary.actions?.skip_duplicate || 0}</strong><span>duplicates skipped</span></div>
                <div className="npx-admin-summary-card"><strong>{reviewSummary.actions?.import_anyway || 0}</strong><span>overrides imported</span></div>
              </div>
              <p className="npx-muted">
                Existing values used: {reviewSummary.actions?.use_existing || 0} · Imported values confirmed: {reviewSummary.actions?.use_imported || 0} · Metadata records skipped: {reviewSummary.actions?.skip_record || 0}
              </p>
            </div>
          )}
          {job.error && <div className="npx-admin-message is-error">{job.error}</div>}
          {result?.tables && (
            <div className="npx-table-wrap">
              <table className="npx-table npx-admin-results-table">
                <thead><tr><th>Table</th><th>Processed</th><th>Successful</th><th>Skipped</th><th>Failed</th></tr></thead>
                <tbody>
                  {Object.entries(result.tables).map(([table, counts]) => (
                    <tr key={table}><td>{table}</td><td>{counts.processed}</td><td>{counts.successful}</td><td>{counts.skipped}</td><td>{counts.failed}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {result?.errors?.length > 0 && (
            <div className="npx-admin-failures">
              <h3 className="npx-h3">Failed rows</h3>
              <ul className="npx-admin-issues">
                {result.errors.map((item, index) => (
                  <li className="is-error" key={`${item.table}-${item.row}-${index}`}>
                    <strong>{item.table}{item.row ? ` row ${item.row}` : ""}: </strong>{item.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
