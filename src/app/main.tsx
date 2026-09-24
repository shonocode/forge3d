/** The new screen's entry (ADR-014). */
import "../styles.css";
import "./app.css";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { boot } from "./boot";

createRoot(document.getElementById("root")!).render(<App onCanvas={boot} />);
