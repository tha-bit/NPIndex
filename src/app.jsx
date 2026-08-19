import { useCallback, useEffect, useState } from "react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { Header, Style, normalizeAnnotationValue, sb } from "./archive.jsx";
import AboutPage from "./pages/AboutPage.jsx";
import DetailPage from "./pages/DetailPage.jsx";
import ExplorePage from "./pages/ExplorePage.jsx";
import LanguagesPage from "./pages/LanguagesPage.jsx";
import StatisticsPage from "./pages/StatisticsPage.jsx";
import AdminPage from "./pages/AdminPage.jsx";
import AdminDataManagementPage from "./pages/AdminDataManagementPage.jsx";
import AdminDataMigrationPage from "./pages/AdminDataMigrationPage.jsx";

const EMPTY_ANNOTATION_META = {
  categories: [],
  subcategoriesByCategory: {},
  typesByCategory: {},
  typesByCategoryAndSubcategory: {},
};

const VIEW_PATHS = {
  home: "/",
  languages: "/languages",
  explore: "/explore",
  statistics: "/statistics",
};

const SITE_ORIGIN = "https://npdb.vercel.app";
const DEFAULT_META_DESCRIPTION = "Explore the Noun Phrase Index, a cross-linguistic research archive of noun phrases with word-level glosses, translations, annotations, and source data.";

const META_DESCRIPTIONS = {
  "/": DEFAULT_META_DESCRIPTION,
  "/languages": "Browse languages represented in the Noun Phrase Index and open their noun phrase records, translations, glosses, and grammatical annotations.",
  "/explore": "Search cross-linguistic noun phrases by wording, translation, language, and grammatical annotation sequence in the Noun Phrase Index research archive.",
  "/statistics": "Compare noun phrase annotation distributions and ordered grammatical sequences across languages in the Noun Phrase Index research archive worldwide.",
  "/admin": "Access protected Noun Phrase Index administration tools for authorised data management and migration workflows.",
  "/admin/data-management": "Find, correct, or remove individual Noun Phrase Index database records through the protected administration interface.",
  "/admin/data-migration": "Validate and import Noun Phrase Index lexicon, phrase, token, and annotation data through the protected administration interface.",
};

function getMetaDescription(pathname) {
  if (pathname.startsWith("/explore/")) {
    return "View a noun phrase record with its translation, token-level glosses, grammatical annotations, context, source, language, and provenance details.";
  }
  return META_DESCRIPTIONS[pathname] || DEFAULT_META_DESCRIPTION;
}

function getCanonicalPath(pathname) {
  if (pathname.startsWith("/explore/")) return pathname;
  return META_DESCRIPTIONS[pathname] ? pathname : "/";
}

function AppRoutes() {
  const navigate = useNavigate();
  const location = useLocation();
  const [languages, setLanguages] = useState([]);
  const [languageById, setLanguageById] = useState({});
  const [annotationMeta, setAnnotationMeta] = useState(EMPTY_ANNOTATION_META);

  useEffect(() => {
    let metaDescription = document.querySelector('meta[name="description"]');
    if (!metaDescription) {
      metaDescription = document.createElement("meta");
      metaDescription.name = "description";
      document.head.appendChild(metaDescription);
    }
    metaDescription.content = getMetaDescription(location.pathname);

    let canonicalLink = document.querySelector('link[rel="canonical"]');
    if (!canonicalLink) {
      canonicalLink = document.createElement("link");
      canonicalLink.rel = "canonical";
      document.head.appendChild(canonicalLink);
    }
    canonicalLink.href = new URL(getCanonicalPath(location.pathname), SITE_ORIGIN).href;
  }, [location.pathname]);

  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap";
    document.head.appendChild(link);
    return () => document.head.removeChild(link);
  }, []);

  useEffect(() => {
    Promise.all([
      sb("languages?select=language_id,language_name,iso_code&order=language_name.asc&limit=1000"),
      sb("annotations?select=category,subcategory,type&limit=10000"),
    ]).then(([{ data: langs }, { data: anns }]) => {
      setLanguages(langs);
      setLanguageById(Object.fromEntries(langs.map((language) => [language.language_id, language])));

      const categories = new Set();
      const subcategoriesByCategory = {};
      const typesByCategory = {};
      const typesByCategoryAndSubcategory = {};

      anns.forEach(({ category, subcategory, type }) => {
        const normalizedCategory = normalizeAnnotationValue(category);
        const normalizedSubcategory = normalizeAnnotationValue(subcategory);
        const normalizedType = normalizeAnnotationValue(type);
        if (!normalizedCategory) return;

        categories.add(normalizedCategory);
        if (normalizedSubcategory) {
          if (!subcategoriesByCategory[normalizedCategory]) subcategoriesByCategory[normalizedCategory] = new Set();
          subcategoriesByCategory[normalizedCategory].add(normalizedSubcategory);
        }
        if (normalizedType) {
          if (!typesByCategory[normalizedCategory]) typesByCategory[normalizedCategory] = new Set();
          typesByCategory[normalizedCategory].add(normalizedType);
        }
        if (normalizedSubcategory && normalizedType) {
          if (!typesByCategoryAndSubcategory[normalizedCategory]) typesByCategoryAndSubcategory[normalizedCategory] = {};
          if (!typesByCategoryAndSubcategory[normalizedCategory][normalizedSubcategory]) {
            typesByCategoryAndSubcategory[normalizedCategory][normalizedSubcategory] = new Set();
          }
          typesByCategoryAndSubcategory[normalizedCategory][normalizedSubcategory].add(normalizedType);
        }
      });

      setAnnotationMeta({
        categories: [...categories].sort(),
        subcategoriesByCategory: Object.fromEntries(
          Object.entries(subcategoriesByCategory).map(([key, values]) => [key, [...values].sort()])
        ),
        typesByCategory: Object.fromEntries(
          Object.entries(typesByCategory).map(([key, values]) => [key, [...values].sort()])
        ),
        typesByCategoryAndSubcategory: Object.fromEntries(
          Object.entries(typesByCategoryAndSubcategory).map(([category, subcategories]) => [
            category,
            Object.fromEntries(
              Object.entries(subcategories).map(([subcategory, types]) => [subcategory, [...types].sort()])
            ),
          ])
        ),
      });
    }).catch(console.error);
  }, []);

  const go = useCallback((view, phraseId = null, options = {}) => {
    let path = view === "detail"
      ? `/explore/${encodeURIComponent(phraseId)}`
      : VIEW_PATHS[view] || "/";
    if (view === "explore" && options.language !== undefined) {
      path += `?language=${encodeURIComponent(String(options.language))}`;
    }
    navigate(path);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [navigate]);

  const view = location.pathname.startsWith("/explore")
    ? "explore"
    : location.pathname.slice(1) || "home";
  const sharedPageProps = { go, languages, languageById, annotationMeta };

  return (
    <div className="npx-root">
      <Style />
      <Header view={view} go={go} />
      <Routes>
        <Route path="/" element={<AboutPage go={go} languageById={languageById} />} />
        <Route path="/languages" element={<LanguagesPage go={go} languages={languages} />} />
        <Route path="/explore" element={<ExplorePage {...sharedPageProps} />} />
        <Route path="/explore/:phraseId" element={<DetailPage go={go} languageById={languageById} />} />
        <Route path="/statistics" element={<StatisticsPage {...sharedPageProps} />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/admin/data-management" element={<AdminDataManagementPage />} />
        <Route path="/admin/data-migration" element={<AdminDataMigrationPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <footer className="npx-footer">Cross-linguistic noun phrase archive · Developed by Taha Yangin</footer>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
