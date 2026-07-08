import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PocSttPage } from "./dev/PocSttPage";
import "./styles/index.css";
import "./styles/tokens.css";
import "./styles/app.css";

// Tauri Phase 1 Task 3: ?poc=stt のときだけ dev専用PoCページを描画する（本番UI=Appは不変）
const isPocStt = new URLSearchParams(window.location.search).get("poc") === "stt";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isPocStt ? <PocSttPage /> : <App />}
  </React.StrictMode>,
);
