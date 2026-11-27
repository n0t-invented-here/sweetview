# sweetview-window-logic

Job: what a window should do next, decided from cursor positions, button states and bounds.

It makes no OS call and holds no `unsafe` (`#![forbid(unsafe_code)]`), so every rule is tested with `cargo test` on any machine. The runtime feeds it what the platform crate reads and applies what it answers.

| Module | Holds |
|---|---|
| `geometry` | `Rect` and `Point`, in outer-frame physical pixels |
| `hit` | the packed polygon format of `hit-regions.ts`, the point-in-polygon test, and the 10 ms poll's state machine: inside a polygon, entered, the point asked of the refiner, the ask sequence, "never flip while a mouse button is down" |
| `resize` | the edge-resize gesture's arithmetic with its minimum size, and the frameless maximise toggle |
| `style` | the extended-style bits Sweetview forces on and off whoever changes a window's style |
| `color` | `#rrggbb` colour keys to `COLORREF` |
| `screen` | which screen a point or a window rectangle belongs to, the way the OS picks one |
| `ico` | the image of an `.ico` file closest to a wanted size |
