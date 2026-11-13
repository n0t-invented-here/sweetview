// The demo: a page with pets on it. A click anywhere drops another one at
// that point; the panel picks the model from the three packs and sets the
// scale and the bottom of every pet on the page.

import "./main.css";

import { StrictMode, useRef, useState, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { BLOCKY_CHARACTERS, BOTTOM_MIN, CUBE_PETS, MINI_CHARACTERS, SCALE_MIN, type PetModel, type Point } from "@n1h/web-pets";
import { Pet } from "@n1h/web-pets/react";

type Dropped = { id: number; model: PetModel; spawn: Point };

const PACKS: { title: string; models: readonly PetModel[] }[] = [
  { title: "Cube Pets", models: Object.values(CUBE_PETS) },
  { title: "Mini Characters", models: MINI_CHARACTERS },
  { title: "Blocky Characters", models: BLOCKY_CHARACTERS },
];
const key = (m: PetModel) => `${m.pack}/${m.file}`;
const byKey = new Map(PACKS.flatMap((p) => p.models).map((m) => [key(m), m]));

const SCALE_MAX_HERE = 4; // the package allows 8; a pet that size covers a phone

function App() {
  const [pets, setPets] = useState<Dropped[]>([{ id: 0, model: CUBE_PETS.cat, spawn: { x: window.innerWidth * 0.6, y: -100 } }]);
  const [model, setModel] = useState<PetModel>(CUBE_PETS.cat);
  const [scale, setScale] = useState(1);
  const [bottom, setBottom] = useState(0);
  const nextId = useRef(1);

  const drop = (e: MouseEvent<HTMLElement>) => {
    setPets((ps) => [...ps, { id: nextId.current++, model, spawn: { x: e.clientX, y: e.clientY } }]);
  };

  return (
    <main className="page" onClick={drop}>
      <section className="hero">
        <h1>Web Pets</h1>
        <p>
          Click anywhere to drop a {model.name.toLowerCase()} there. It falls to the bottom of the page, or onto whoever is below, and lives along it. Pick one up and throw it.
        </p>
        <p className="hint">
          <code>{`<Pet pet=${model.pack === "kenney-cube-pets" ? `"${model.name.toLowerCase()}"` : `{${model.name.replace(/\W/g, "")}}`} scale={${scale}} spawn={{ x, y }} />`}</code>
        </p>
      </section>

      <aside className="panel" onClick={(e) => e.stopPropagation()}>
        <label>
          Model
          <select value={key(model)} onChange={(e) => setModel(byKey.get(e.target.value) ?? CUBE_PETS.cat)}>
            {PACKS.map((p) => (
              <optgroup key={p.title} label={p.title}>
                {p.models.map((m) => (
                  <option key={key(m)} value={key(m)}>
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
            {pets.length} {pets.length === 1 ? "pet" : "pets"}
          </span>
          <button type="button" onClick={() => setPets([])} disabled={pets.length === 0}>
            Clear
          </button>
        </div>
      </aside>

      {pets.map((p) => (
        <Pet key={p.id} pet={p.model} spawn={p.spawn} scale={scale} bottom={bottom} assetsUrl="/pets/" />
      ))}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
