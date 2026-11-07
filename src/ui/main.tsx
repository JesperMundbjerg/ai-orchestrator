import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { startInputLog } from "./inputlog.ts";
import "./styles.css";

// Off unless the tab was opened with ?inputlog=1 (a dictation diagnostic; see docs/API.md, Debug).
startInputLog();
createRoot(document.getElementById("root")!).render(<App />);
