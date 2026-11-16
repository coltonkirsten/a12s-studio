import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");
createRoot(root).render(<h1>a12s Studio</h1>);
