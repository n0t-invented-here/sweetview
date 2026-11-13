// The demo: a page with characters on it. A click anywhere drops another one at
// that point; the panel picks the model from the three packs and sets the
// scale and the bottom of every character on the page. The demo imports every
// pack whole, so its bundle ships every file; a page imports the models it
// uses.

import "./main.css";

import { StrictMode, useRef, useState, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { BOTTOM_MIN, SCALE_MIN, type ModelSpec, type Point } from "@n1h/web-characters";
import { BLOCKY_CHARACTERS } from "@n1h/web-characters/packs/blocky-characters";
import { CUBE_PETS, cat } from "@n1h/web-characters/packs/cube-pets";
import { MINI_CHARACTERS } from "@n1h/web-characters/packs/mini-characters";
import { Character } from "@n1h/web-characters/react";

type Dropped = { id: number; model: ModelSpec; spawn: Point };

const PACKS: { title: string; models: readonly ModelSpec[] }[] = [
  { title: "Cube Pets", models: Object.values(CUBE_PETS) },
  { title: "Mini Characters", models: MINI_CHARACTERS },
  { title: "Blocky Characters", models: BLOCKY_CHARACTERS },
];
const byUrl = new Map(PACKS.flatMap((p) => p.models).map((m) => [m.url, m]));
const importName = (m: ModelSpec) => m.name.replace(/^(Mini|Blocky) /, "").replace(/-(\w)/g, (_, c: string) => c.toUpperCase()).replace(/^\w/, (c) => (m.name.startsWith("Blocky") ? `character${c}` : c.toLowerCase()));

const SCALE_MAX_HERE = 4; // the package allows 8; a character that size covers a phone

function App() {
  const [characters, setModels] = useState<Dropped[]>([{ id: 0, model: cat, spawn: { x: window.innerWidth * 0.6, y: -100 } }]);
  const [model, setModel] = useState<ModelSpec>(cat);
  const [scale, setScale] = useState(1);
  const [bottom, setBottom] = useState(0);
  const nextId = useRef(1);

  const drop = (e: MouseEvent<HTMLElement>) => {
    setModels((ps) => [...ps, { id: nextId.current++, model, spawn: { x: e.clientX, y: e.clientY } }]);
  };

  return (
    <main className="page" onClick={drop}>
      <section className="hero">
        <h1>Web Characters</h1>
        <p>
          Click anywhere to drop a {model.name.toLowerCase()} there. It falls to the bottom of the page, or onto whoever is below, and lives along it. Pick one up and throw it.
        </p>
        <p className="hint">
          <code>{`<Character model={${importName(model)}} scale={${scale}} spawn={{ x, y }} />`}</code>
        </p>
      </section>

      <aside className="panel" onClick={(e) => e.stopPropagation()}>
        <label>
          Model
          <select value={model.url} onChange={(e) => setModel(byUrl.get(e.target.value) ?? cat)}>
            {PACKS.map((p) => (
              <optgroup key={p.title} label={p.title}>
                {p.models.map((m) => (
                  <option key={m.url} value={m.url}>
                    {m.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          <span>
            Scale <output>{scale.toFixed(2)}</output>
          </span>
          <input type="range" min={SCALE_MIN} max={SCALE_MAX_HERE} step={0.05} value={scale} onChange={(e) => setScale(Number(e.target.value))} />
        </label>
        <label>
          <span>
            Bottom <output>{bottom}px</output>
          </span>
          <input type="range" min={Math.max(BOTTOM_MIN, -100)} max={600} step={10} value={bottom} onChange={(e) => setBottom(Number(e.target.value))} />
        </label>
        <div className="row">
          <span className="count">
            {characters.length} {characters.length === 1 ? "character" : "characters"}
          </span>
          <button type="button" onClick={() => setModels([])} disabled={characters.length === 0}>
            Clear
          </button>
        </div>
      </aside>

      {characters.map((p) => (
        <Character key={p.id} model={p.model} spawn={p.spawn} scale={scale} bottom={bottom} />
      ))}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
