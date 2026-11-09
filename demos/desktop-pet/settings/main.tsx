// The settings window's page: React + Mantine, talking to the UI thread over
// the same bridge the pet page uses. No worker behind it; every method it
// calls is answered on the UI thread.

import "@mantine/core/styles.css";
import "./main.css";

import { MantineProvider, createTheme } from "@mantine/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Chrome } from "./Chrome";

const theme = createTheme({
  primaryColor: "violet",
  defaultRadius: "md",
  fontFamily: "Inter, Segoe UI, system-ui, sans-serif",
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <Chrome>
        <App />
      </Chrome>
    </MantineProvider>
  </StrictMode>,
);
