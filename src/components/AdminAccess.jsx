import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { signInWithPassword } from "../archive.jsx";


const API_BASE = String(import.meta.env.VITE_MIGRATION_API_URL || "").replace(/\/$/, "");
const TOKEN_KEY = "npindex_admin_access_token";

export async function adminRequest(path, token, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload?.detail;
    const message = typeof detail === "string"
      ? detail
      : detail?.message || payload?.message || `Request failed (${response.status}).`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export function useAdminSession() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || "");
  const [admin, setAdmin] = useState(null);
  const [authState, setAuthState] = useState(token ? "checking" : "signed_out");

  const signOut = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken("");
    setAdmin(null);
    setAuthState("signed_out");
  }, []);

  const authenticate = useCallback(async (candidate) => {
    const profile = await adminRequest("/api/admin/me", candidate);
    sessionStorage.setItem(TOKEN_KEY, candidate);
    setToken(candidate);
    setAdmin(profile);
    setAuthState("authenticated");
  }, []);

  useEffect(() => {
    if (!token || authState !== "checking") return;
    authenticate(token).catch(signOut);
  }, [token, authState, authenticate, signOut]);

  return { token, admin, authState, authenticate, signOut };
}

export function AdminLogin({ onAuthenticated, description = "Use an authorised NPIndex administrator account to access administration." }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const session = await signInWithPassword(email.trim(), password);
      await onAuthenticated(session.access_token);
    } catch (authError) {
      setError(authError.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="npx-page npx-admin-page">
      <div className="npx-admin-login">
        <p className="npx-eyebrow">Restricted administration</p>
        <h1 className="npx-h1-sm">Admin sign in</h1>
        <p className="npx-lede-sm">{description}</p>
        <form className="npx-admin-login-form" onSubmit={submit}>
          <label className="npx-filter-group">
            <span className="npx-filter-label">Email</span>
            <input className="npx-input" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label className="npx-filter-group">
            <span className="npx-filter-label">Password</span>
            <input className="npx-input" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {error && <div className="npx-admin-message is-error">{error}</div>}
          <button className="npx-btn npx-btn-primary" type="submit" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

export function AdminPageHeader({ admin, title, description, onSignOut, backTo }) {
  return (
    <div className="npx-admin-header">
      <div>
        {backTo && <Link className="npx-admin-back" to={backTo}>← Admin</Link>}
        <p className="npx-eyebrow">Restricted administration</p>
        <h1 className="npx-h1-sm">{title}</h1>
        {description && <p className="npx-lede-sm">{description}</p>}
      </div>
      <div className="npx-admin-account">
        <span>{admin?.email}</span>
        <button className="npx-btn npx-btn-ghost npx-btn-small" onClick={onSignOut}>Sign out</button>
      </div>
    </div>
  );
}
