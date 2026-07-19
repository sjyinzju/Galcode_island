import React from "react";
import ReactDOM from "react-dom/client";

import { PetWindowApp } from "./PetWindowApp";
import "./pet.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PetWindowApp />
  </React.StrictMode>,
);
