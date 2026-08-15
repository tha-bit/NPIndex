import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminLogin, AdminPageHeader, adminRequest, useAdminSession } from "../components/AdminAccess.jsx";


const PAGE_SIZE = 25;

function fieldLabel(name) {
  return name.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function displayValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

export default function AdminDataManagementPage() {
  const { token, admin, authState, authenticate, signOut } = useAdminSession();
  const [tables, setTables] = useState([]);
  const [tableName, setTableName] = useState("phrases");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({});
  const [deleting, setDeleting] = useState(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [saving, setSaving] = useState(false);

  const selectedTable = useMemo(
    () => tables.find((table) => table.name === tableName) || null,
    [tables, tableName]
  );

  const handleRequestError = useCallback((requestError) => {
    if (requestError.status === 401 || requestError.status === 403) signOut();
    setError(requestError.message);
  }, [signOut]);

  useEffect(() => {
    if (authState !== "authenticated") return;
    adminRequest("/api/admin/data-management/tables", token)
      .then(({ tables: availableTables }) => {
        setTables(availableTables);
        setTableName((current) => (
          availableTables.some((table) => table.name === current) ? current : availableTables[0]?.name || ""
        ));
      })
      .catch(handleRequestError);
  }, [authState, token, handleRequestError]);

  useEffect(() => {
    if (authState !== "authenticated" || !selectedTable) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    const parameters = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    if (search) parameters.set("search", search);
    adminRequest(`/api/admin/data-management/${encodeURIComponent(tableName)}?${parameters}`, token)
      .then((payload) => {
        if (cancelled) return;
        setItems(payload.items || []);
        setTotal(payload.total || 0);
      })
      .catch((requestError) => {
        if (!cancelled) handleRequestError(requestError);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authState, token, selectedTable, tableName, search, offset, refreshKey, handleRequestError]);

  const changeTable = (event) => {
    setTableName(event.target.value);
    setSearchDraft("");
    setSearch("");
    setOffset(0);
    setEditing(null);
    setDeleting(null);
    setError("");
    setMessage("");
  };

  const submitSearch = (event) => {
    event.preventDefault();
    setSearch(searchDraft.trim());
    setOffset(0);
    setEditing(null);
    setDeleting(null);
    setMessage("");
    if (search === searchDraft.trim() && offset === 0) setRefreshKey((value) => value + 1);
  };

  const openEditor = (record) => {
    const editableValues = {};
    selectedTable.columns.forEach((column) => {
      if (column.editable) editableValues[column.name] = record[column.name] ?? "";
    });
    setEditing(record);
    setDraft(editableValues);
    setDeleting(null);
    setError("");
    setMessage("");
  };

  const saveRecord = async (event) => {
    event.preventDefault();
    const recordId = String(editing[selectedTable.key]);
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await adminRequest(
        `/api/admin/data-management/${encodeURIComponent(tableName)}/${encodeURIComponent(recordId)}`,
        token,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ values: draft }),
        }
      );
      setEditing(null);
      setMessage(`${selectedTable.label} record ${recordId} was updated.`);
      setRefreshKey((value) => value + 1);
    } catch (requestError) {
      handleRequestError(requestError);
    } finally {
      setSaving(false);
    }
  };

  const openDelete = (record) => {
    setDeleting(record);
    setDeleteConfirmation("");
    setEditing(null);
    setError("");
    setMessage("");
  };

  const deleteRecord = async () => {
    const recordId = String(deleting[selectedTable.key]);
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const result = await adminRequest(
        `/api/admin/data-management/${encodeURIComponent(tableName)}/${encodeURIComponent(recordId)}`,
        token,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmation: deleteConfirmation }),
        }
      );
      setDeleting(null);
      setDeleteConfirmation("");
      const relatedSummary = Object.entries(result.deleted_records || {})
        .filter(([name, count]) => name !== "phrases" && count > 0)
        .map(([name, count]) => `${count} ${name}`)
        .join(", ");
      setMessage(`Phrase ${recordId} was deleted${relatedSummary ? ` with ${relatedSummary}` : ""}. Sources, annotators, and shared records were preserved.`);
      if (items.length === 1 && offset > 0) setOffset(Math.max(0, offset - PAGE_SIZE));
      else setRefreshKey((value) => value + 1);
    } catch (requestError) {
      handleRequestError(requestError);
    } finally {
      setSaving(false);
    }
  };

  if (authState === "checking") {
    return <div className="npx-page npx-admin-page"><div className="npx-detail-loading">Checking administrator access…</div></div>;
  }
  if (authState !== "authenticated") {
    return <AdminLogin onAuthenticated={authenticate} description="Use an authorised NPIndex administrator account to manage database records." />;
  }

  const firstRecord = total ? offset + 1 : 0;
  const lastRecord = Math.min(offset + items.length, total);

  return (
    <div className="npx-page npx-admin-page">
      <AdminPageHeader
        admin={admin}
        title="Data management"
        description="Find, correct, or remove individual NPIndex database records."
        onSignOut={signOut}
        backTo="/admin"
      />

      <section className="npx-admin-panel">
        <div className="npx-admin-data-controls">
          <label className="npx-filter-group npx-admin-table-select">
            <span className="npx-filter-label">Database table</span>
            <select className="npx-select" value={tableName} onChange={changeTable} disabled={!tables.length || saving}>
              {tables.map((table) => <option key={table.name} value={table.name}>{table.label}</option>)}
            </select>
          </label>
          <form className="npx-admin-record-search" onSubmit={submitSearch}>
            <label className="npx-filter-group">
              <span className="npx-filter-label">Search records</span>
              <input className="npx-input" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="Search any displayed field" />
            </label>
            <button className="npx-btn npx-btn-ghost" type="submit" disabled={!selectedTable || loading}>Search</button>
          </form>
        </div>
        <p className="npx-admin-data-note">Primary keys cannot be edited. Delete is available only for Phrases and safely removes related records that are no longer shared.</p>
      </section>

      {editing && selectedTable && (
        <section className="npx-admin-panel npx-admin-record-editor">
          <div className="npx-admin-section-heading">
            <h2 className="npx-h3">Edit {selectedTable.label} record</h2>
            <code>{String(editing[selectedTable.key])}</code>
          </div>
          <form onSubmit={saveRecord}>
            <div className="npx-admin-edit-grid">
              {selectedTable.columns.filter((column) => column.editable).map((column) => (
                <label className={`npx-filter-group${column.multiline ? " is-wide" : ""}`} key={column.name}>
                  <span className="npx-filter-label">{fieldLabel(column.name)}{column.nullable ? " (optional)" : ""}</span>
                  {column.multiline ? (
                    <textarea className="npx-input npx-admin-textarea" value={draft[column.name] ?? ""} onChange={(event) => setDraft((current) => ({ ...current, [column.name]: event.target.value }))} />
                  ) : (
                    <input
                      className="npx-input"
                      type={column.type === "integer" ? "number" : column.type === "date" ? "date" : "text"}
                      value={draft[column.name] ?? ""}
                      onChange={(event) => setDraft((current) => ({ ...current, [column.name]: event.target.value }))}
                    />
                  )}
                </label>
              ))}
            </div>
            <div className="npx-admin-actions">
              <button className="npx-btn npx-btn-ghost" type="button" onClick={() => setEditing(null)} disabled={saving}>Cancel</button>
              <button className="npx-btn npx-btn-primary" type="submit" disabled={saving}>{saving ? "Saving…" : "Save corrections"}</button>
            </div>
          </form>
        </section>
      )}

      {deleting && selectedTable && (
        <section className="npx-admin-panel npx-admin-delete-panel">
          <h2 className="npx-h3">Delete Phrase record</h2>
          <p>
            This permanently deletes phrase <code>{String(deleting[selectedTable.key])}</code>, its annotations and tokens,
            plus related glosses, lexicon entries, contexts, and session when they are not used elsewhere. Sources and annotators remain.
            Type the complete phrase ID to confirm.
          </p>
          <label className="npx-filter-group">
            <span className="npx-filter-label">Record ID confirmation</span>
            <input className="npx-input" value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} autoComplete="off" />
          </label>
          <div className="npx-admin-actions">
            <button className="npx-btn npx-btn-ghost" type="button" onClick={() => setDeleting(null)} disabled={saving}>Cancel</button>
            <button
              className="npx-btn npx-btn-danger"
              type="button"
              onClick={deleteRecord}
              disabled={saving || deleteConfirmation !== String(deleting[selectedTable.key])}
            >
              {saving ? "Deleting…" : "Delete record"}
            </button>
          </div>
        </section>
      )}

      {error && <div className="npx-admin-message is-error">{error}</div>}
      {message && <div className="npx-admin-message is-success">{message}</div>}

      <section className="npx-admin-panel npx-admin-records-panel">
        <div className="npx-admin-section-heading">
          <h2 className="npx-h3">{selectedTable?.label || "Records"}</h2>
          <span className="npx-admin-record-count">{loading ? "Loading…" : `${total} record${total === 1 ? "" : "s"}`}</span>
        </div>
        <div className="npx-table-wrap">
          <table className="npx-table npx-admin-data-table">
            <thead>
              <tr>
                {(selectedTable?.columns || []).map((column) => <th key={column.name}>{fieldLabel(column.name)}</th>)}
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {!loading && items.map((record) => (
                <tr key={String(record[selectedTable.key])}>
                  {selectedTable.columns.map((column) => (
                    <td key={column.name}><span title={displayValue(record[column.name])}>{displayValue(record[column.name])}</span></td>
                  ))}
                  <td>
                    <div className="npx-admin-row-actions">
                      <button className="npx-btn npx-btn-ghost npx-btn-small" type="button" onClick={() => openEditor(record)}>Edit</button>
                      {selectedTable.deletable && (
                        <button className="npx-btn npx-btn-danger npx-btn-small" type="button" onClick={() => openDelete(record)}>Delete</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && items.length === 0 && (
                <tr><td className="npx-admin-empty-records" colSpan={(selectedTable?.columns.length || 0) + 1}>No matching records.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="npx-admin-pagination">
          <span>Showing {firstRecord}–{lastRecord} of {total}</span>
          <div>
            <button className="npx-btn npx-btn-ghost npx-btn-small" onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0 || loading}>Previous</button>
            <button className="npx-btn npx-btn-ghost npx-btn-small" onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total || loading}>Next</button>
          </div>
        </div>
      </section>
    </div>
  );
}
