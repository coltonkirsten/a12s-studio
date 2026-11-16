import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/parts.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");
createRoot(root).render(<App />);
