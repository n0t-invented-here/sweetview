import { Group, NumberInput, Select, Slider, Stack, Switch, Text, Title } from "@mantine/core";
import { createBridge } from "@n1h/sweetview/ipc";
import { webviewTransport } from "@n1h/sweetview/page";
import { useEffect, useState } from "react";
import { PETS, petLabel, type Pet } from "../pets";
import type { Events, Methods } from "../service";
import { BOTTOM_MAX, BOTTOM_MIN, DEFAULT_SETTINGS, SCALE_MAX, SCALE_MIN, type Settings } from "../settings";

const bridge = createBridge<Methods, Events>(webviewTransport());

export function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [pet, setModel] = useState<Pet>(PETS[0]);

  useEffect(() => {
    void bridge.rpc("settings.get").then(setSettings);
    void bridge.rpc("pet.current").then(setModel);
    // The tray can change both too; follow it.
    const offSettings = bridge.on("settings.changed", setSettings);
    const offPet = bridge.on("pet.select", setModel);
    return () => {
      offSettings();
      offPet();
    };
  }, []);

  // Applied and saved by the UI thread at once; the reply is the clamped result.
  const change = (patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    void bridge.rpc("settings.set", patch).then(setSettings);
  };

  return (
    <Stack p="lg" gap="lg">
      <Title order={3}>Pet</Title>

      <Select
        label="Animal"
        data={PETS.map((p) => ({ value: p, label: petLabel(p) }))}
        value={pet}
        allowDeselect={false}
        onChange={(v) => {
          if (v) {
            setModel(v as Pet);
            bridge.notify("pet.choose", v as Pet);
          }
        }}
      />

      <NumberInput
        label="Bottom"
        description="How far above the very bottom of the display it stands, in pixels (the same distance on every monitor, whatever its scale). Raise it to walk around mid-screen; negative sinks it below the edge."
        min={BOTTOM_MIN}
        max={BOTTOM_MAX}
        allowNegative
        step={10}
        value={settings.bottom}
        onChange={(v) => change({ bottom: typeof v === "number" ? v : 0 })}
      />

      <Stack gap={4}>
        <Group justify="space-between" align="flex-end">
          <div>
            <Text size="sm" fw={500}>
              Scale
            </Text>
            <Text size="xs" c="dimmed">
              Size of the pet; the window and the hit boxes follow it.
            </Text>
          </div>
          <NumberInput w={110} min={SCALE_MIN} max={SCALE_MAX} step={0.05} decimalScale={2} value={settings.scale} onChange={(v) => change({ scale: typeof v === "number" ? v : 1 })} />
        </Group>
        <Slider min={SCALE_MIN} max={SCALE_MAX} step={0.05} value={settings.scale} onChange={(v) => change({ scale: v })} label={(v) => v.toFixed(2)} />
      </Stack>

      <Switch
        label="Click through"
        description="Clicks beside the pet reach whatever is underneath. Off: the whole window takes clicks."
        checked={settings.clickThrough}
        onChange={(e) => change({ clickThrough: e.currentTarget.checked })}
      />
    </Stack>
  );
}
