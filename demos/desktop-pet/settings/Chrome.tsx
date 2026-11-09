// The settings window's own chrome, drawn by the page: a card with a title
// bar, window buttons and resize handles, in the pet's dark Mantine look. The
// window behind it is frameless and see-through, so everything the user sees
// is ours; what the user does with it is the OS's. The pointer handlers, the
// handle geometry and the `window.*` methods behind them are sweetview's
// (sweetview/window-chrome); this file is the skin. With the OS's frame
// instead (PET_OS_FRAME=1, `window.info` says so) it renders the children alone.

import { ActionIcon, Box, Group, Text } from "@mantine/core";
import { webviewTransport } from "@n1h/sweetview/page";
import { resizeHandles, windowChromeControls, type WindowChromeInfo } from "@n1h/sweetview/window-chrome";
import { useEffect, useState, type ReactNode } from "react";

const chrome = windowChromeControls(webviewTransport());

const TITLE_HEIGHT = 38;
const HANDLES = resizeHandles(6); // px of the window's edge that resizes it

export function Chrome({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<WindowChromeInfo>({ chrome: "os", maximized: false });
  const refresh = () => void chrome.info().then(setInfo);
  useEffect(refresh, []);

  if (info.chrome === "os") return <>{children}</>;

  const maximize = () => {
    chrome.toggleMaximize();
    setTimeout(refresh, 50);
  };

  return (
    <Box
      className="chrome"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        borderRadius: info.maximized ? 0 : 12,
        overflow: "hidden",
        background: "var(--mantine-color-dark-7)",
        border: "1px solid var(--mantine-color-dark-4)",
        boxShadow: "0 12px 40px rgba(0, 0, 0, 0.55)",
      }}
    >
      <Group
        gap="xs"
        px="sm"
        h={TITLE_HEIGHT}
        wrap="nowrap"
        style={{ flex: "none", background: "var(--mantine-color-dark-8)", borderBottom: "1px solid var(--mantine-color-dark-4)", cursor: "default", userSelect: "none" }}
        onPointerDown={chrome.onTitlePointerDown}
        onDoubleClick={maximize}
      >
        <Box w={10} h={10} style={{ borderRadius: 5, background: "var(--mantine-color-violet-5)", flex: "none" }} />
        <Text size="sm" fw={600} style={{ flex: 1 }}>
          Pet Settings
        </Text>
        <Group gap={4} wrap="nowrap" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <ActionIcon variant="subtle" color="gray" size="md" aria-label="Minimise" onClick={chrome.minimize}>
            <Glyph d="M3 8.5h10" />
          </ActionIcon>
          <ActionIcon variant="subtle" color="gray" size="md" aria-label={info.maximized ? "Restore" : "Maximise"} onClick={maximize}>
            {info.maximized ? <Glyph d="M5 3.5h7.5V11M3.5 5.5h7.5v7.5H3.5z" /> : <Glyph d="M3.5 3.5h9v9h-9z" />}
          </ActionIcon>
          <ActionIcon variant="subtle" color="red" size="md" aria-label="Close" onClick={chrome.close}>
            <Glyph d="M4 4l8 8M12 4l-8 8" />
          </ActionIcon>
        </Group>
      </Group>

      <Box style={{ flex: 1, overflow: "auto" }}>{children}</Box>

      {!info.maximized && HANDLES.map(({ edge, style }) => <Box key={edge} style={{ position: "absolute", ...style }} onPointerDown={chrome.onHandlePointerDown(edge)} />)}
    </Box>
  );
}

/** A 16px line icon. */
function Glyph({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}
