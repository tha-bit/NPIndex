import { Link } from "react-router-dom";
import { AdminLogin, AdminPageHeader, useAdminSession } from "../components/AdminAccess.jsx";


export default function AdminPage() {
  const { admin, authState, authenticate, signOut } = useAdminSession();

  if (authState === "checking") {
    return <div className="npx-page npx-admin-page"><div className="npx-detail-loading">Checking administrator access…</div></div>;
  }
  if (authState !== "authenticated") {
    return <AdminLogin onAuthenticated={authenticate} />;
  }

  return (
    <div className="npx-page npx-admin-page">
      <AdminPageHeader
        admin={admin}
        title="Administration"
        description="Manage protected NPIndex data and maintenance workflows."
        onSignOut={signOut}
      />

      <section className="npx-admin-tools" aria-label="Administration tools">
        <Link className="npx-admin-tool-card" to="/admin/data-migration">
          <span className="npx-eyebrow">Data management</span>
          <h2 className="npx-h3">Data Migration</h2>
          <p>Validate source CSV files and import lexicon, phrase, token, and annotation data into NPIndex.</p>
          <strong>Open Data Migration →</strong>
        </Link>
      </section>
    </div>
  );
}
