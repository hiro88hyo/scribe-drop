import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.js";
import "./styles.css";

const rootElement = document.querySelector("#root");

if (rootElement === null) {
  throw new Error("Application root element is missing");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
