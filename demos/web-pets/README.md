# web-pets

A pet for any web page: one of the 24 animals from Kenney's Cube Pets pack, rendered with [Babylon.js](https://www.babylonjs.com/) on a see-through canvas over the page.
It drops in at a point, falls to the bottom edge of the page, lands, and lives there: idles, walks, runs, dances, turns around at the sides.
Pick it up with the mouse and throw it. Clicks beside it reach the page as if it were not there.
Add as many as you like: they land on each other's heads, ride along, walk off, and bump into the ones at their level.

The same animals, moods and models as the [desktop pet](../desktop-pet/README.md), which takes them from this package; this one needs no sweetview and no Bun at runtime, only a browser with WebGL.

## Use it

```ts
import { createPet } from "@n1h/web-pets";

const cat = createPet({ pet: "cat", spawn: { x: 300, y: 0 }, scale: 1.5, assetsUrl: "/pets/" });
const dog = createPet({ pet: "dog", spawn: { x: 500, y: 0 }, scale: 1.5, assetsUrl: "/pets/" });
cat.setSettings({ scale: 2 }); // the reply is the clamped result
cat.setPet("fox");
cat.spawn({ x: 800, y: 0 }); // teleport and fall again
cat.dispose();
dog.dispose();
```

In React:

```tsx
import { Pet, type PetHandle } from "@n1h/web-pets/react";

function Page() {
  const cat = useRef<PetHandle>(null);
  const [more, setMore] = useState<{ id: number; pet: Pet; spawn: Point }[]>([]);
  return (
    <>
      <Pet ref={cat} pet="cat" spawn={{ x: 300, y: 0 }} scale={1.5} assetsUrl="/pets/" />
      {more.map((p) => (
        <Pet key={p.id} pet={p.pet} spawn={p.spawn} scale={1.5} assetsUrl="/pets/" />
      ))}
      <button onClick={() => cat.current?.spawn({ x: 100, y: 0 })}>Again</button>
      <button onClick={() => setMore((ps) => [...ps, { id: ps.length, pet: "dog", spawn: { x: 600, y: 0 } }])}>A dog too</button>
    </>
  );
}
```

`<Pet>` renders nothing in React's tree: the canvas is appended to the body (or `host`) and removed on unmount. `pet`, `scale` and `bottom` apply when they change; `spawn` is where the pet first appears (use the handle's `spawn` to move it later); `host`, `assetsUrl` and `zIndex` re-create the pet.

### Serving the models

The models are in this package's `assets/kenney-cube-pets/` folder (24 `.glb` files, 130 to 170 KB each, one shared texture under `Textures/`).
Serve that folder from your page's origin and pass its URL as `assetsUrl` (`/pets/` by default): copy it to your static folder, or point your bundler or server at `node_modules/@n1h/web-pets/assets/kenney-cube-pets/`.
A model's URL is `assetsUrl + "animal-" + pet + ".glb"`; the texture is referenced from inside each model, relative to it.

The package ships TypeScript sources, like `@n1h/sweetview`; the consuming app's bundler compiles them.

## What it does

| Feature | Behaviour |
|---|---|
| Spawn | The pet's centre appears at `spawn` (CSS pixels from the top-left of its bounds) and falls, playing its negative gesture, lands with its positive gesture, then idles. Without `spawn`: somewhere along the top edge, so it drops in from above. |
| Bounds | The viewport by default: the canvas is `position: fixed`, so the pet stays on screen while the page scrolls. With `host`, the element's box: the canvas is absolute inside it (the element becomes `position: relative` when it was static). A walking pet turns around at the sides; a pet thrown past one is pulled back inside. |
| Moods | `idle`, `walk`, `run`, `dance` for every animal, picked at random with weights; `eat` is a pecking animation, so only the chick, the parrot and the penguin play it. |
| Pick up and throw | A press on the model picks it up (the hand cursor shows only over the model); the pet plays its negative gesture while carried, falls when released with the hand's speed, clamped to a throw, and lands with its positive gesture. A press on a transparent spot reaches the page. |
| Several pets | Each `createPet` is its own canvas and WebGL context (browsers allow about 16 per page). Pets on the same ground (the viewport, or one `host`) step in one loop and meet: a pet that falls onto another lands on its head and stands there, rides along when the one below walks, drops off when it walks past the edge of the head or the one below is picked up, and towers stack as deep as you drop them. At one level, two whose bodies overlap are pushed apart, a walker that bumps into another turns around, a pile dropped on one spot spreads out. Pets in the air or in hand pass freely. |

### Settings

| Setting | Range | Default | Effect |
|---|---|---|---|
| `scale` | 0.25 to 8, two decimals | 1 | Size of the model; the canvas scales with it, about the feet. At 1 the pet is 192 CSS pixels tall. |
| `bottom` | -2000 to 4000, whole numbers | 0 | Height above the bottom edge of the bounds, in CSS pixels. Negative sinks it below the edge. |

Out-of-range values are clamped by `setSettings`, whose reply is the result.

## Files

| File | Role |
|---|---|
| `src/pet.ts` | `createPet`: the canvas, its placement over the page, the pointer (hover test, pick up, throw), the frame loop. |
| `src/react.tsx` | `<Pet>`: `createPet` in an effect, props to the handle, the handle on `ref`. |
| `src/life.ts` | The pet's life with no screen in it: fall, land (on the ground or on another pet's head), ground moods, side edges, riding, carry and throw, and `separate`, which keeps pets at one level apart. Pure; tested. |
| `src/herd.ts` | One frame loop per ground: steps every pet on it, separates them, then lets each draw. |
| `src/scene.ts` | The Babylon.js scene: camera aimed so the feet sit on the canvas's bottom edge at every scale, lights, one model at a time, animations by name, the triangle pick. |
| `src/pets.ts` | The 24 animals, their labels, their file names, which are birds. |
| `src/moods.ts` | The weighted draw of what a pet does next. |
| `src/settings.ts` | `PetSettings`, ranges, `sanitizePetSettings`. |
| `src/index.ts` | The package's root export. |
| `demo/main.tsx`, `demo/main.css` | The demo page: a click drops a pet at that point; a panel picks the animal and sets the scale and the bottom of every pet. |
| `demo/serve.ts` | `Bun.serve` for the demo page and the assets under `/pets/`. |
| `assets/kenney-cube-pets/` | The models, the shared texture, the previews and the pack's `License.txt`. |

## Recipes

Run `just <recipe>` in this folder or `just demos web-pets <recipe>` from the repo root.

| Recipe | Does |
|---|---|
| `test` | `bun test` for the life, the moods and the settings. |
| `frontend` | Bundles and minifies the demo page into `build/demo/` (Babylon.js and the glTF loader included, about 4 MB). |
| `demo` | `frontend`, then serves it on `http://127.0.0.1:4748` (`PORT` and `HOST` to change). |
| `clean` | Removes `build/`. |

## How it works

`createLife` is the pet's state machine: a square box with a top-left in the bounds' coordinates, in one of four states (`ground` with a mood and a direction until a time, `fall` with a vertical speed, `carried`, `landed` until a time).
It reads the bounds, the box size, the scale and the bottom through functions each step, so a resize or a settings change takes effect on the next frame.
On the ground it asks `nextCommand` for the next mood when the current one ends.

`createPetScene` draws the model: a level camera whose height is computed so that the model's ground plane projects onto the canvas's last pixel rows, at any scale (the model, the camera distance and the canvas scale together, so the framing never changes); the eight animations of the models, by name, with blending; and a triangle pick for `solidAt`.

`createPet` joins the two on a canvas it appends to the page, moved with `translate3d` every frame the position changes.
Pets on the same ground share a herd (`herd.ts`), one `requestAnimationFrame` loop that steps every life with the others in view, runs `separate` over the standing ones (pairs at one level, half the overlap each, until nothing moves) and then lets each pet draw.
A life's floor is the ground or the highest head (a quarter of the way down the box) of a standing pet whose body is under the life's centre and whose head was not above the feet when the step began, so a fall never passes through a head and a pet beside another never climbs it; a standing pet whose floor is gone falls, and one on a head moves with it.
The canvas takes no pointer events, so the page under it works as if the canvas were not there.
On every pointer move the point is tested against the model with a triangle pick; over the model the canvas takes events and shows the hand, so the press lands on it.
That is one move of lag before a press on the model counts, and never a stolen click beside it.

## Assets

The animals are [Cube Pets by Kenney](https://kenney.nl/assets/cube-pets), CC0.
The pack's licence file is `assets/kenney-cube-pets/License.txt`.
