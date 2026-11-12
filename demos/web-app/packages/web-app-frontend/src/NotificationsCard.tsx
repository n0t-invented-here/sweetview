import { Alert, Badge, Button, Card, Code, Group, Stack, Switch, Text, Title } from "@mantine/core";
import type { NotifyStatus, SentNotification } from "web-app-backend/protocol";
import { useEffect, useState } from "react";
import { inApp, on, rpc } from "./bridge";

type Row = SentNotification & { clickedAt?: string };

const MAX_ROWS = 50;

export function NotificationsCard() {
  const [status, setStatus] = useState<NotifyStatus>({ onChanges: false });
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!inApp) return;
    rpc("notify.status").then(setStatus).catch((e: Error) => setError(e.message));
    const offStatus = on("notify.status", setStatus);
    const offSent = on("notify.sent", (sent) => setRows((prev) => [sent, ...prev].slice(0, MAX_ROWS)));
    const offClicked = on("notify.clicked", ({ id, at }) => setRows((prev) => prev.map((r) => (r.id === id ? { ...r, clickedAt: at } : r))));
    return () => {
      offStatus();
      offSent();
      offClicked();
    };
  }, []);

  async function sendTest() {
    setError(null);
    setBusy(true);
    try {
      if (!(await rpc("notify.test"))) setError("The OS showed nothing. On macOS, run the .app bundle, not the bare binary.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function setOnChanges(enabled: boolean) {
    setError(null);
    try {
      setStatus(await rpc("notify.onChanges", { enabled }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Card withBorder shadow="sm" padding="lg">
      <Group justify="space-between" mb="md" wrap="nowrap">
        <Title order={4}>Notifications</Title>
        {inApp && (
          <Button size="xs" onClick={sendTest} loading={busy}>
            Send test notification
          </Button>
        )}
      </Group>

      {!inApp && (
        <Text c="dimmed" size="sm">
          System notifications come from the desktop app: its tray icon on Windows, the notification center on macOS. This
          page is served by <Code>Bun.serve</Code>, so there is none to send here.
        </Text>
      )}

      {inApp && (
        <Stack gap="md">
          <Switch
            label="Notify on folder changes"
            description="Every batch of changes from the folder watcher becomes a silent notification. The tray menu has the same switch."
            checked={status.onChanges}
            onChange={(e) => void setOnChanges(e.currentTarget.checked)}
          />

          {error && <Alert color="red">{error}</Alert>}

          {rows.length === 0 ? (
            <Text c="dimmed" size="sm">
              Nothing sent yet. A click on a notification brings this window back and marks it here.
            </Text>
          ) : (
            <Stack gap="xs">
              {rows.map((r) => (
                <Group key={r.id} justify="space-between" wrap="nowrap">
                  <div style={{ minWidth: 0 }}>
                    <Text size="sm" truncate>
                      <strong>{r.title}</strong> · {r.body}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {r.id} · sent {new Date(r.at).toLocaleTimeString()}
                    </Text>
                  </div>
                  {r.clickedAt ? (
                    <Badge color="green" variant="light">
                      clicked {new Date(r.clickedAt).toLocaleTimeString()}
                    </Badge>
                  ) : (
                    <Badge variant="outline" color="gray">
                      sent
                    </Badge>
                  )}
                </Group>
              ))}
            </Stack>
          )}
        </Stack>
      )}
    </Card>
  );
}
