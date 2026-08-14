import { useParams } from "react-router-dom";
import { Detail } from "../archive.jsx";

export default function DetailPage({ go, languageById }) {
  const { phraseId } = useParams();
  return <Detail phraseId={phraseId} go={go} languageById={languageById} />;
}
