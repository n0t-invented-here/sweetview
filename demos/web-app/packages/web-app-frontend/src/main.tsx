import "@mantine/core/styles.css";

import { MantineProvider, createTheme } from "@mantine/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { signalReady } from "@n1h/sweetview/page";
import { App } from "./App";

const theme = createTheme({
  primaryColor: "violet",
  defaultRadius: "md",
  fontFamily: "Inter, Segoe UI, system-ui, sans-serif",
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <App />
    </MantineProvider>
  </StrictMode>,
);
// The page has painted: a window made with showOnReady appears now (a no-op outside a sweetview window).
// macOS (WKWebView) keeps the start it had at the tag pre-rust-rewrite until the macOS goal (D42).
const macTagPath = /Macintosh|Mac OS X/.test(navigator.userAgent);
if (!macTagPath) requestAnimationFrame(() => void signalReady());
