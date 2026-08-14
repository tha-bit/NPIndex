import { useSearchParams } from "react-router-dom";
import { Explore } from "../archive.jsx";

export default function ExplorePage({ go, languages, languageById, annotationMeta }) {
  const [searchParams] = useSearchParams();
  const initialLangFilter = searchParams.get("language") || "";

  return (
    <Explore
      key={initialLangFilter}
      go={go}
      languages={languages}
      languageById={languageById}
      annotationMeta={annotationMeta}
      initialLangFilter={initialLangFilter}
    />
  );
}
