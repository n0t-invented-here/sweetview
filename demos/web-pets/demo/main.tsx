// The demo: a page with a pet on it. A click anywhere drops another one at
// that point; the panel picks the animal and sets the scale and the bottom of
// every pet on the page.

import "./main.css";

import { StrictMode, useRef, useState, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { BOTTOM_MIN, PETS, petLabel, SCALE_MIN, type Pet, type Point } from "@n1h/web-pets";
import { Pet as PetOnPage } from "@n1h/web-pets/react";

type Dropped = { id: number; pet: Pet; spawn: Point };

const SCALE_MAX_HERE = 4; // the package allows 8; a pet that size covers a phone

function App() {
  const [pets, setPets] = useState<Dropped[]>([{ id: 0, pet: "cat", spawn: { x: window.innerWidth * 0.6, y: -100 } }]);
  const [animal, setAnimal] = useState<Pet>("cat");
  const [scale, setScale] = useState(1);
  const [bottom, setBottom] = useState(0);
  const nextId = useRef(1);

  const drop = (e: MouseEvent<HTMLElement>) => {
    setPets((ps) => [...ps, { id: nextId.current++, pet: animal, spawn: { x: e.clientX, y: e.clientY } }]);
  };

  return (
    <main className="page" onClick={drop}>
      <section className="hero">
        <h1>Web Pets</h1>
        <p>
          Click anywhere to drop a {petLabel(animal).toLowerCase()} there. It falls to the bottom of the page and lives along it. Pick one up and throw it.
        </p>
        <p className="hint">
          <code>{`<Pet pet="${animal}" scale={${scale}} spawn={{ x, y }} />`}</code>
        </p>
      </section>

      <aside className="panel" onClick={(e) => e.stopPropagation()}>
        <label>
          Animal
          <select value={animal} onChange={(e) => setAnimal(e.target.value as Pet)}>
            {PETS.map((p) => (
              <option key={p} value={p}>
                {petLabel(p)}
              </option>
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
        <PetOnPage key={p.id} pet={p.pet} spawn={p.spawn} scale={scale} bottom={bottom} assetsUrl="/pets/" />
      ))}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
