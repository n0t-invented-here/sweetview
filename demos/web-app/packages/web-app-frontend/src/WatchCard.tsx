import { Alert, Badge, Button, Card, Code, Group, Indicator, ScrollArea, Table, Text, TextInput, Title } from "@mantine/core";
import type { FsChange, WatchStatus } from "web-app-backend/protocol";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { inApp, on, rpc } from "./bridge";

type Row = FsChange & { id: number };

const kindColor: Record<FsChange["kind"], string> = {
  created: "green",
  modified: "blue",
  deleted: "red",
  unknown: "gray",
};

const MAX_ROWS = 500;

export function WatchCard() {
  const [status, setStatus] = useState<WatchStatus>({ watching: false, path: null });
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [typedPath, setTypedPath] = useState("");
  const nextId = useRef(1);

  useEffect(() => {
    rpc("watch.status").then(setStatus).catch((e: Error) => setError(e.message));
    const offStatus = on("watch.status", setStatus);
    const offChange = on("fs.change", (changes) => {
      const fresh = changes.map<Row>((c) => ({ ...c, id: nextId.current++ }));
      setRows((prev) => [...fresh.reverse(), ...prev].slice(0, MAX_ROWS));
    });
    return () => {
      offStatus();
      offChange();
    };
  }, []);

  async function start(path: string) {
    setError(null);
    setBusy(true);
    try {
      setRows([]);
      setStatus(await rpc("watch.start", { path }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function pick() {
    setError(null);
    setBusy(true);
    try {
      const path = await rpc("pick.folder");
      if (path !== null) await start(path); // null: cancelled
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function submitPath(e: FormEvent) {
    e.preventDefault();
    if (typedPath.trim()) void start(typedPath.trim());
  }

  async function stop() {
    setError(null);
    try {
      setStatus(await rpc("watch.stop"));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Card withBorder shadow="sm" padding="lg">
      <Group justify="space-between" mb="md" wrap="nowrap">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <Title order={4}>Folder watcher</Title>
          {status.watching && (
            <Indicator processing color="green" size={8} offset={-2} position="middle-end">
              <Badge variant="light" color="green" pr="md" style={{ maxWidth: 480 }}>
                {status.path}
              </Badge>
            </Indicator>
          )}
        </Group>
        <Group gap="xs" wrap="nowrap">
          {status.watching && (
            <Badge variant="outline">
              {rows.length} event{rows.length === 1 ? "" : "s"}
            </Badge>
          )}
          {status.watching && (
            <Button variant="default" size="xs" onClick={() => setRows([])} disabled={rows.length === 0}>
              Clear
            </Button>
          )}
          {status.watching ? (
            <Button color="red" variant="light" size="xs" onClick={stop}>
              Stop
            </Button>
          ) : (
            inApp && (
              <Button size="xs" onClick={pick} loading={busy}>
                Pick a folder…
              </Button>
            )
          )}
        </Group>
      </Group>

      {error && (
        <Alert color="red" mb="md">
          {error}
        </Alert>
      )}

      {!status.watching && !inApp && (
        <form onSubmit={submitPath}>
          <Group align="flex-end" mb="md" wrap="nowrap">
            <TextInput
              label="Folder on the server"
              placeholder="C:\\Users\\you\\Documents or /home/you"
              value={typedPath}
              onChange={(e) => setTypedPath(e.currentTarget.value)}
              style={{ flex: 1 }}
            />
            <Button type="submit" loading={busy} disabled={!typedPath.trim()}>
              Watch
            </Button>
          </Group>
        </form>
      )}

      {!status.watching && (
        <Text c="dimmed" size="sm">
          {inApp ? (
            <>
              Opens the OS folder dialog in-process (COM <Code>IFileOpenDialog</Code> / <Code>NSOpenPanel</Code> over{" "}
              <Code>bun:ffi</Code>), then <Code>fs.watch</Code> runs on the worker and pushes every change through the
              shared ring into this page. No polling, no sockets, no child processes.
            </>
          ) : (
            <>
              <Code>fs.watch</Code> runs on the server for this tab only and pushes every change down the WebSocket.
              Other tabs have their own watcher.
            </>
          )}
        </Text>
      )}

      {status.watching && rows.length === 0 && (
        <Text c="dimmed" size="sm">
          Watching <Code>{status.path}</Code> recursively. Change something inside it.
        </Text>
      )}

      {rows.length > 0 && (
        <ScrollArea.Autosize mah={380} type="auto">
          <Table striped highlightOnHover withTableBorder stickyHeader>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={110}>Event</Table.Th>
                <Table.Th>Path</Table.Th>
                <Table.Th w={120}>Time</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((r) => (
                <Table.Tr key={r.id}>
                  <Table.Td>
                    <Badge color={kindColor[r.kind]} variant="light" size="sm">
                      {r.kind}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Code>{r.path}</Code>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">
                      {new Date(r.at).toLocaleTimeString()}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea.Autosize>
      )}
    </Card>
  );
}
