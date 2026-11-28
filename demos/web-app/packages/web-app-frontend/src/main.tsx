import "@mantine/core/styles.css";

import { MantineProvider, createTheme } from "@mantine/core";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { signalReady } from "@n1h/sweetview/page";
import { App } from "./App";

// macOS (WKWebView) keeps the start it had at the tag pre-rust-rewrite until the macOS goal (D42).
const macTagPath = /Macintosh|Mac OS X/.test(navigator.userAgent);

/** Signals ready once React has committed the first render: a window made with showOnReady appears then (a no-op outside a sweetview window). */
function SignalReady() {
  useEffect(() => {
    if (!macTagPath) void signalReady();
  }, []);
  return null;
}

const theme = createTheme({
  primaryColor: "violet",
  defaultRadius: "md",
  fontFamily: "Inter, Segoe UI, system-ui, sans-serif",
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <App />
      <SignalReady />
    </MantineProvider>
  </StrictMode>,
);
