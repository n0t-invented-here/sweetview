# web-characters

A character for any web page: an animated glTF character rendered with [Babylon.js](https://www.babylonjs.com/) on a see-through canvas over the page.
It drops in at a point, falls to the bottom edge of the page, lands, and lives there: idles, walks, runs, does whatever its clips do, turns around at the sides.
Pick it up with the mouse and throw it. Clicks beside it reach the page as if it were not there.
Add as many as you like: they land on each other's heads, ride along, walk off, and bump into the ones at their level.

Three packs of Kenney's CC0 models come with it: the 24 Cube Pets (the [desktop pet](../desktop-character/README.md)'s animals, which it takes from here), six Mini Characters and four Blocky Characters.
Any other animated glTF works through a model spec (below).
No sweetview and no Bun at runtime, only a browser with WebGL.

## Use it

```ts
import { createCharacter } from "@n1h/web-characters";
import { cat } from "@n1h/web-characters/packs/cube-pets/cat";
import { fox } from "@n1h/web-characters/packs/cube-pets/fox";
import { femaleA } from "@n1h/web-characters/packs/mini-characters/female-a";

const kitty = createCharacter({ character: cat, spawn: { x: 300, y: 0 }, scale: 1.5 });
const person = createCharacter({ character: femaleA, spawn: { x: 500, y: 0 }, scale: 1.5 });
kitty.setSettings({ scale: 2 }); // the reply is the clamped result
kitty.setModel(fox);
kitty.spawn({ x: 800, y: 0 }); // teleport and fall again
kitty.dispose();
person.dispose();
```

In React:

```tsx
import { Character, type CharacterHandle } from "@n1h/web-characters/react";
import { cat } from "@n1h/web-characters/packs/cube-pets/cat";
import { characterA } from "@n1h/web-characters/packs/blocky-characters/a";

function Page() {
  const kitty = useRef<CharacterHandle>(null);
  const [more, setMore] = useState<{ id: number; spawn: Point }[]>([]);
  return (
    <>
      <Character ref={kitty} character={cat} spawn={{ x: 300, y: 0 }} scale={1.5} />
      {more.map((p) => (
        <Character key={p.id} character={characterA} spawn={p.spawn} scale={1.5} />
      ))}
      <button onClick={() => kitty.current?.spawn({ x: 100, y: 0 })}>Again</button>
      <button onClick={() => setMore((ps) => [...ps, { id: ps.length, spawn: { x: 600, y: 0 } }])}>Someone too</button>
    </>
  );
}
```

`<Character>` renders nothing in React's tree: the canvas is appended to the body (or `host`) and removed on unmount. `character`, `scale` and `bottom` apply when they change (a model is compared by its URL, so an object literal in the render body is fine); `spawn` is where the character first appears (use the handle's `spawn` to move it later); `host` and `zIndex` re-create the character.

### What ships: only the models you import

Every model is its own module that imports its own file:

```ts
// the whole of packs/cube-pets/cat.ts
import colormap from "../../../assets/kenney-cube-pets/Textures/colormap.png";
import url from "../../../assets/kenney-cube-pets/animal-cat.glb";
import { PET_TEXTURE_FILE, cubePetSpec } from "./spec";

export const cat = cubePetSpec("cat", url, { [PET_TEXTURE_FILE]: colormap });
```

So `import { cat } from "@n1h/web-characters/packs/cube-pets/cat"` puts the cat's glTF and the pack's shared texture in your build, as hashed assets your bundler emits, and nothing else: a bundler ships every file a module it resolves imports, used or not, which is why each model has a module of its own rather than a named export in a shared one. Bun, Vite and esbuild handle `.glb` and `.png` imports as asset URLs by default; webpack needs asset modules for them.
There is nothing to copy and no folder to serve. The root module exports no model at all, and `character` is required, so a page that imports nothing ships nothing.
A page that imports only the cat and one Blocky character ships four files: the two glTFs and their two textures.

| Pack | One model | The whole pack (ships every file) |
|---|---|---|
| Cube Pets, 24 glTF of 130 to 170 KB and one shared texture | `@n1h/web-characters/packs/cube-pets/<name>` exports `<name>`, the names as in `PETS` (`cat`, `polar`, …) | `@n1h/web-characters/packs/cube-pets` exports all 24 and `CUBE_PETS` by name |
| Mini Characters, 6 glTF of about 250 KB and one shared texture | `.../packs/mini-characters/female-a` … `male-c` export `femaleA` … `maleC` | `.../packs/mini-characters` exports all six and `MINI_CHARACTERS` |
| Blocky Characters, 4 glTF of about 110 KB with a texture each | `.../packs/blocky-characters/a` … `d` export `characterA` … `characterD` | `.../packs/blocky-characters` exports all four and `BLOCKY_CHARACTERS` |

Each pack's `spec` module (`.../packs/cube-pets/spec` and the others) is the pack as data with no files in it: the clips, the moods and the function that makes a model from a file URL. The desktop pet imports the cube pets' one for the names and moods.
The files themselves are under the package's `assets/`, with each pack's licence, for a build that wants them another way.

The package ships TypeScript sources, like `@n1h/sweetview`; the consuming app's bundler compiles them. `src/assets.d.ts` declares the `.glb` and `.png` imports.

### Your own model

A character is a `ModelSpec`: where the file is, how to fit it, which clip plays in which state, and what it does on the ground.

```ts
import { createCharacter, type ModelSpec } from "@n1h/web-characters";
import robotUrl from "./robot.glb";
import robotSkin from "./robot-skin.png";

const robot: ModelSpec = {
  name: "Robot",
  url: robotUrl,
  textures: { "robot-skin.png": robotSkin }, // what the file references by relative path, by that path; not needed when the textures are embedded
  height: 1.3, // scene units; the cube pets are 1 to 1.4 tall as modelled
  forward: "-z", // which way it faces as modelled; +z by default, as glTF says
  clips: {
    idle: "Idle",
    carried: "Flail",
    falling: "Fall", // falls back to carried, then idle
    landed: { name: "Land", once: true }, // played once, so the landing lasts as long as the clip
  },
  moods: [
    { name: "idle", clip: "Idle", weight: 2, seconds: [2, 6] },
    { name: "walk", clip: "Walk", weight: 3, speed: 60, seconds: [3, 8] }, // px/s at scale 1, tuned to the stride
    { name: "spin", clip: "Spin", seconds: [1, 2] },
  ],
};
createCharacter({ character: robot });
```

What happens with it:

- The file is loaded from `url`; a texture it references by relative path is fetched from `textures[path]` when there is one, else from beside the file. It is posed on the first frame of its idle clip (a bind pose is a T-pose), measured, centred, its feet put at y = 0, scaled to `height` when given, and turned by `forward` so it faces +z. The camera never changes; the model is fitted to it.
- Its posed geometry through the camera gives its width (the lower three quarters, so a raised tail or a hat does not count), its head (the surface straight above its middle) and where its feet are drawn, which is what other characters bump into and stand on. No numbers to supply. The canvas carries them as `data-body`, `data-head` and `data-feet`, fractions of its edge, for a look.
- `moods` is a weighted draw; a mood whose clip the file lacks is never drawn. A mood with `speed` moves the character along the ground at that many CSS pixels per second at scale 1, and faces it the way it goes; the stride is the one thing to tune by eye, because a clip does not say how far its feet travel.
- `clips` name the clips for the states that are not moods. Missing ones fall back as noted. A `once` clip plays through and stops instead of looping; for `landed` it also sets how long the landing lasts (otherwise 1.2 s).
- Every clip gets blending between it and the next, which suits clips of one rig.

The three packs are specs of this shape in `src/packs/`, one module per model; the Mini and Blocky characters are the proof that a file with none of the characters' clip names works (`fall`, `sprint`, `emote-yes` once for the landing, `jump`, `sit`, `pick-up`; Blocky has no falling clip and falls with its carried one).

## What it does

| Feature | Behaviour |
|---|---|
| Spawn | The character's centre appears at `spawn` (CSS pixels from the top-left of its bounds) and falls, playing its falling clip, lands with its landed clip, then idles. Without `spawn`: somewhere along the top edge, so it drops in from above. |
| Bounds | The viewport by default: the canvas is `position: fixed`, so the character stays on screen while the page scrolls. With `host`, the element's box: the canvas is absolute inside it (the element becomes `position: relative` when it was static). A walking character turns around at the sides; a character thrown past one is pulled back inside. |
| Moods | The model's moods, drawn by weight for a while each; the cube pets idle, walk, run and dance, and the three birds also eat (a pecking clip). |
| Pick up and throw | A press on the model picks it up (the hand cursor shows only over the model); the character plays its carried clip while held, falls when released with the hand's speed, clamped to a throw, and lands with its landed clip. A press on a transparent spot reaches the page. |
| Several characters | Each `createCharacter` is its own canvas and WebGL context (browsers allow about 16 per page). Characters on the same ground (the viewport, or one `host`) step in one loop and meet: a character that falls onto another lands on its head and stands there, rides along when the one below walks, drops off when it walks past the edge of the head or the one below is picked up, and towers stack as deep as you drop them. At one level, two whose bodies overlap are pushed apart, a walker that bumps into another turns around, a pile dropped on one spot spreads out. Characters in the air or in hand pass freely. |

### Settings

| Setting | Range | Default | Effect |
|---|---|---|---|
| `scale` | 0.25 to 8, two decimals | 1 | Size of the model; the canvas scales with it, about the feet. At 1 the canvas is 192 CSS pixels square. |
| `bottom` | -2000 to 4000, whole numbers | 0 | Height above the bottom edge of the bounds, in CSS pixels. Negative sinks it below the edge. |

Out-of-range values are clamped by `setSettings`, whose reply is the result.

## Files

| File | Role |
|---|---|
| `src/character.ts` | `createCharacter`: the canvas, its placement over the page, the pointer (hover test, pick up, throw), joining its ground. |
| `src/react.tsx` | `<Character>`: `createCharacter` in an effect, props to the handle, the handle on `ref`. |
| `src/model.ts` | `ModelSpec`: the spec, clip fallbacks, the weighted mood draw. |
| `src/packs/<pack>/<model>.ts` | One module per model, importing its own file and texture and making its spec. |
| `src/packs/<pack>/index.ts` | The whole pack: every model, and the pack as a record or list. |
| `src/packs/<pack>/spec.ts` | The pack as data with no files: clips, moods, the spec function; for the cube pets also the names, labels, file names and the desktop pet's `nextCommand`. |
| `src/assets.d.ts` | The `.glb` and `.png` import types. |
| `src/life.ts` | The character's life with no screen in it: fall, land (on the ground or on another character's head), ground moods, side edges, riding, carry and throw, and `separate`, which keeps characters at one level apart. Pure; tested. |
| `src/ground.ts` | One frame loop per ground: steps every character on it with the others in view, separates them, then lets each draw. |
| `src/scene.ts` | The Babylon.js scene: the camera aimed so the feet sit on the canvas's bottom edge at every scale, lights, one model at a time fitted to the spec, clips by name, the triangle pick. |
| `src/framing.ts` | The camera as numbers and a model's box through it: its width and head height on the canvas. Pure; tested. |
| `src/settings.ts` | `CharacterSettings`, ranges, `sanitizeCharacterSettings`. |
| `src/index.ts` | The package's root export. |
| `demo/main.tsx`, `demo/main.css` | The demo page: a click drops a character at that point; a panel picks the model from the three packs (imported whole, so the demo ships every file) and sets the scale and the bottom of every character. |
| `demo/serve.ts` | `Bun.serve` for the demo page and the files the build put beside it. |
| `assets/kenney-cube-pets/`, `assets/kenney-mini-characters/`, `assets/kenney-blocky-characters/` | The models, their textures and each pack's `License.txt`. |

## Recipes

Run `just <recipe>` in this folder or `just demos web-characters <recipe>` from the repo root.

| Recipe | Does |
|---|---|
| `test` | `bun test` for the life, the framing, the model spec, the cube pets' moods and the settings. |
| `frontend` | Bundles and minifies the demo page into `build/demo/` (Babylon.js and the glTF loader included, about 4 MB, plus every model file as a hashed asset). |
| `demo` | `frontend`, then serves it on `http://127.0.0.1:4748` (`PORT` and `HOST` to change). |
| `clean` | Removes `build/`. |

## How it works

`createLife` is the character's state machine: a square box with a top-left in the bounds' coordinates, in one of four states (`ground` with a mood and a direction until a time, `fall` with a vertical speed, `carried`, `landed` until a time).
It reads the bounds, the box size, the scale, the bottom and the model through functions each step, so a resize, a settings change or a model swap takes effect on the next frame.
On the ground it draws the next mood from the model when the current one ends.

`createModelScene` draws the model: a level camera whose height is computed so that the model's ground plane projects onto the canvas's last pixel rows, at any scale (the model, the camera distance and the canvas scale together, so the framing never changes); the model fitted under it as the spec says; its clips by name, with blending; and a triangle pick for `solidAt`.
`framing.ts` has the same camera as numbers, so the fitted model's width, head height and foot line on the canvas come out from its vertices and triangles without a render.

`createCharacter` joins the two on a canvas it appends to the page, moved with `translate3d` every frame the position changes.
The canvas takes no pointer events, so the page under it works as if the canvas were not there.
On every pointer move the point is tested against the model with a triangle pick; over the model the canvas takes events and shows the hand, so the press lands on it.
That is one move of lag before a press on the model counts, and never a stolen click beside it.

Characters on the same ground share a ground (`ground.ts`), one `requestAnimationFrame` loop that steps every life with the others in view, runs `separate` over the standing ones (pairs at one level, half the overlap each, until nothing moves) and then lets each character draw.
A life's floor is the ground or the highest head of a standing character whose body is under the life's centre and whose head was not above the feet when the step began, so a fall never passes through a head and a character beside another never climbs it; a standing character whose floor is gone falls, and one on a head moves with it.
Head and feet are both taken at a model's centre depth, so a rider's drawn feet meet its mount's drawn head.

## Assets

Every model is Kenney's, CC0: [Cube Pets](https://kenney.nl/assets/cube-pets), [Mini Characters](https://kenney.nl/assets/mini-characters) and [Blocky Characters](https://kenney.nl/assets/blocky-characters).
Each pack's folder under `assets/` has its `License.txt`.
