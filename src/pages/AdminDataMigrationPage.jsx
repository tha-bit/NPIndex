import { useEffect, useMemo, useState } from "react";
import { AdminLogin, AdminPageHeader, adminRequest, useAdminSession } from "../components/AdminAccess.jsx";


const TERMINAL_STATUSES = new Set(["completed", "completed_with_errors", "failed"]);
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

export default function AdminDataMigrationPage() {
  const { token, admin, authState, authenticate, signOut } = useAdminSession();
  const [files, setFiles] = useState({});
  const [sourceName, setSourceName] = useState("");
  const [annotatorName, setAnnotatorName] = useState("");
  const [validation, setValidation] = useState(null);
  const [validating, setValidating] = useState(false);
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");

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

  if (authState === "checking") {
    return <div className="npx-page npx-admin-page"><div className="npx-detail-loading">Checking administrator access…</div></div>;
  }
  if (authState !== "authenticated") {
    return <AdminLogin onAuthenticated={authenticate} description="Use an authorised NPIndex administrator account to access data migration." />;
  }

  const isRunning = job && !TERMINAL_STATUSES.has(job.status);
  const result = job?.result;
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
