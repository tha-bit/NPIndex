import { Statistics } from "../archive.jsx";

export default function StatisticsPage({ languages, languageById, annotationMeta }) {
  return (
    <Statistics
      languages={languages}
      languageById={languageById}
      annotationMeta={annotationMeta}
    />
  );
}
