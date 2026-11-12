import {
  ActionIcon,
  Alert,
  AppShell,
  Badge,
  Button,
  Card,
  Code,
  Group,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
  useMantineColorScheme,
} from "@mantine/core";
import type { ColorScheme, Info, Note } from "web-app-backend/protocol";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { inApp, notify, on, onDisconnect, rpc } from "./bridge";
import { NotificationsCard } from "./NotificationsCard";
import { WatchCard } from "./WatchCard";

const platformLabel: Record<string, string> = {
  win32: "Windows",
  darwin: "macOS",
  linux: "Linux",
};

export function App() {
  const { colorScheme, toggleColorScheme, setColorScheme } = useMantineColorScheme();
  const [disconnected, setDisconnected] = useState(false);

  // Keep the tray menu's Theme check marks in step with the page, both ways.
  useEffect(() => {
    if (inApp) notify("ui.theme", { scheme: colorScheme as ColorScheme });
  }, [colorScheme]);
  useEffect(() => on("ui.theme", ({ scheme }) => setColorScheme(scheme)), [setColorScheme]);
  useEffect(() => onDisconnect(() => setDisconnected(true)), []);

  return (
    <AppShell header={{ height: 60 }} padding="lg">
      <AppShell.Header>
        <Group h="100%" px="lg" justify="space-between">
          <Group gap="sm">
            <Title order={3}>Web App</Title>
            <Badge variant="light" color={inApp ? "violet" : "teal"}>
              {inApp ? "sweetview · IPC" : "Bun.serve · WebSocket"}
            </Badge>
          </Group>
          <Button variant="default" size="xs" onClick={toggleColorScheme}>
            {colorScheme === "dark" ? "☀️ Light" : "🌙 Dark"}
          </Button>
        </Group>
      </AppShell.Header>

      <AppShell.Main>
        <Stack gap="lg">
          {disconnected && (
            <Alert color="red" title="Disconnected">
              The server closed the connection. Reload the page to reconnect.
            </Alert>
          )}
          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
            <RuntimeCard />
            <NotesCard />
          </SimpleGrid>
          <WatchCard />
          <NotificationsCard />
        </Stack>
      </AppShell.Main>
    </AppShell>
  );
}

function RuntimeCard() {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc("info.get").then(setInfo).catch((e: Error) => setError(e.message));
  }, []);

  return (
    <Card withBorder shadow="sm" padding="lg">
      <Group justify="space-between" mb="md">
        <Title order={4}>Runtime</Title>
        {info && (
          <Badge color={info.compiled ? "green" : "yellow"} variant="light">
            {info.compiled ? "single executable" : "dev mode"}
          </Badge>
        )}
      </Group>

      {error && <Text c="red">Backend call failed: {error}</Text>}

      {info && (
        <Table variant="vertical" layout="fixed" withTableBorder>
          <Table.Tbody>
            <Row label="Host" value={info.host === "webview" ? "sweetview window, service in a worker" : `Bun.serve, ${info.sessions} session${info.sessions === 1 ? "" : "s"}`} />
            <Row label="Bun" value={info.bun} />
            <Row label="Platform" value={`${platformLabel[info.platform] ?? info.platform} / ${info.arch}`} />
            <Row label="PID" value={String(info.pid)} />
            <Row label="cwd" value={<Code>{info.cwd}</Code>} />
          </Table.Tbody>
        </Table>
      )}
    </Card>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Table.Tr>
      <Table.Th w={110}>{label}</Table.Th>
      <Table.Td>{value}</Table.Td>
    </Table.Tr>
  );
}

function NotesCard() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    rpc("notes.list").then(setNotes).catch(console.error);
    return on("notes.changed", setNotes); // shared: another tab's edits show up here too
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      await rpc("notes.add", { text });
      setText("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card withBorder shadow="sm" padding="lg">
      <Group justify="space-between" mb="md">
        <Title order={4}>Notes</Title>
        <Badge variant="outline">{notes.length}</Badge>
      </Group>

      <form onSubmit={submit}>
        <Group align="flex-end" mb="md" wrap="nowrap">
          <TextInput
            label="New note"
            placeholder={inApp ? "Round-trips through the worker" : "Round-trips through the WebSocket"}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            style={{ flex: 1 }}
          />
          <Button type="submit" loading={busy} disabled={!text.trim()}>
            Add
          </Button>
        </Group>
      </form>

      <Stack gap="xs">
        {notes.length === 0 && (
          <Text c="dimmed" size="sm">
            No notes yet.
          </Text>
        )}
        {notes.map((note) => (
          <Group key={note.id} justify="space-between" wrap="nowrap">
            <div>
              <Text size="sm">{note.text}</Text>
              <Text size="xs" c="dimmed">
                #{note.id} · {new Date(note.createdAt).toLocaleTimeString()}
              </Text>
            </div>
            <Tooltip label="Delete">
              <ActionIcon variant="subtle" color="red" onClick={() => rpc("notes.remove", { id: note.id })} aria-label="Delete note">
                ✕
              </ActionIcon>
            </Tooltip>
          </Group>
        ))}
      </Stack>
    </Card>
  );
}
