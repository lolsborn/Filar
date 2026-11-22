# Filar

Filament winding design, simulation and G-code for tubes and tapered mandrels.

Filar plans where every band of fibre goes, shows the result in 3D, simulates
the machine winding it, and writes G-code for 2-, 3- and 4-axis winders. The
planner is a pure-Rust library; the desktop app is Tauri 2 with a React and
Three.js front end. The same Rust core also compiles to WebAssembly, so the
whole app runs in a plain browser too.

> The survey of existing winding software that shaped this design is in
> [`docs/technology-landscape.md`](docs/technology-landscape.md).

## What it does

**Design**

- Tube or taper mandrel, with optional cylindrical run-outs at each end.
- Any stack of helical (±angle) and hoop layers.
- On a taper, each helical layer is either *constant angle* (steered; needs
  friction) or *geodesic* (slip-free; the angle rises towards the small end).
- Turnarounds are friction-limited by default: the fibre is steered to 90° as
  fast as the friction coefficient allows, so the path is one the fibre can
  hold. A pin-ring option reverses on the spot instead.
- A table of every closed pattern for each layer (pattern number, circuits,
  coverage, dwell needed to close it). Pick one or leave it on Auto.
- Live wall build-up and winding-angle charts along the mandrel, fibre length,
  fibre and resin mass, part mass and wind time.
- Checks: turnaround running off the mandrel, friction demand above what is
  available, geodesics that cannot reach the small end, axis travel limits,
  eye clearance. Export is blocked while any error stands.

**Materials**

- Wind a flat band of fibre tows, or round material that keeps its shape:
  rope, cord, twine, wire. A round strand builds thickness by its diameter
  and is drawn as a strand in 3D; it is treated as wound dry.
- Built-in materials for both, all editable: name, colour, width or
  diameter, weight, densities and fibre volume.
- A personal library: save a material under your own name and it is
  available in every project. Saved materials can be updated, reverted or
  deleted. Ply-property sets for the strength estimate work the same way.
- A flat material can name the ply-property set that goes with it, so
  choosing it in Design switches Analyse to match.

The library is stored as `materials.json` in the app's data folder (on
macOS, `~/Library/Application Support/com.ronoth.filar/`); the browser build
keeps it in local storage.

**Units**

- Settings (the sliders button in the top bar) switches between metric and
  imperial, or sets length, mass, pressure, force, moment and stress
  individually. The choice is remembered.
- Units only change what is shown and typed. Projects are always saved in
  metric, and G-code units come from the machine profile, so switching units
  cannot change a wind.

**Analyse**

- Stiffness and first-failure estimates for the wound wall, from the angle
  and thickness of every ply at every station (thin-wall laminate theory).
- Load cases combining internal pressure, axial force, bending and torque,
  with presets for pressure tubes, airframes and shafts.
- A reserve factor against the level you require: the part is shaded by it,
  charted along its length, and the weakest station, ply and failure mode are
  named. Click a station to see what each ply is carrying.
- Capacity under each basic load, wall moduli, and tube stiffness (EA, EI, GJ).
- Compare layups: snapshot the current layup, change it, and see strength,
  stiffness, mass and wind time side by side.

These are estimates for comparing layups, not a substitute for testing. Ply
properties start from representative textbook-range values; replace them, and
the winding knock-down, with tested values when you have them.

**Simulate**

- The machine winds the part in 3D: spindle, carriage, cross-feed, eye
  rotation and the free span of fibre, with a scrubbable timeline.
- Live axis read-outs in machine units and per-circuit axis traces.

**G-code**

- Configurable machine profile: which axes exist, their G-code words, units,
  direction, limits and speeds; feed-rate convention; spindle wrap; header and
  footer.
- The program view follows the simulation line by line; click a line to jump
  the simulation there.

What is simulated is what is exported: one planned sample is one G-code move.

## Run it

Prerequisites: Rust (stable), Node 20+, pnpm, and for the WebAssembly build
`rustup target add wasm32-unknown-unknown` and
`cargo install wasm-bindgen-cli --version 0.2.130`.

```sh
cd app
pnpm install
pnpm tauri dev        # desktop app (native Rust planner)
pnpm dev              # browser at http://localhost:1420 (WebAssembly planner)
pnpm tauri build      # installable desktop bundle
```

Without the GUI:

```sh
cargo run -p filar-cli -- new cone > part.filar
cargo run -p filar-cli -- info part.filar
cargo run -p filar-cli -- analyze part.filar
cargo run -p filar-cli -- gcode part.filar -o part.gcode
```

Tests: `cargo test` (planner maths, pattern closure, mass conservation, a
G-code interpreter that checks every machine preset reproduces the plan, and
laminate analysis against closed-form results).

Set `FILAR_TRACE=1` when launching the desktop app to log each call the UI
makes into the Rust core.

## Releases and CI

Two GitHub Actions workflows live in `.github/workflows/`:

- **CI** (`ci.yml`) runs on every pull request and every push to `main`:
  the planner and CLI tests, then the full front-end build.
- **Release** (`release.yml`) builds the desktop app on macOS (Apple
  Silicon only; Intel Macs are not supported), Windows and Linux.

To cut a release:

1. Set the new version in `Cargo.toml` (`[workspace.package]`),
   `app/src-tauri/tauri.conf.json` and `app/package.json`, and commit.
2. Tag that commit and push the tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. When the run finishes, a **draft** release holds the installers. Review
   it and publish.

The tag must match the app version or the run stops before building. To
build without releasing, run the workflow by hand (Actions → Release → Run
workflow); the installers are kept as artifacts on that run.

| System | What is built |
| --- | --- |
| macOS, Apple Silicon | `.dmg`, `.app` |
| Windows x64 | `.msi` and `.exe` installers |
| Linux x64 | `.deb`, `.rpm`, `.AppImage` |

**The installers are not code-signed.** The macOS app carries only an
ad-hoc signature, so on first launch macOS blocks it until you allow it
under System Settings → Privacy & Security → Open Anyway; Windows shows a
SmartScreen prompt (More info → Run anyway). Removing those steps needs an
Apple Developer ID certificate with notarisation, and a Windows
code-signing certificate, supplied to the build step as repository
secrets; see the Tauri signing guides for
[macOS](https://v2.tauri.app/distribute/sign/macos/) and
[Windows](https://v2.tauri.app/distribute/sign/windows/).

## Layout

| Path | What |
| --- | --- |
| `crates/filar-core` | The planner. No UI or platform dependencies. |
| `crates/filar-cli` | `filar` command-line tool. |
| `crates/filar-wasm` | WebAssembly bindings for the browser build. |
| `app/src-tauri` | Desktop shell: exposes the core to the web view, file dialogs. |
| `app/src` | React + Three.js front end. |

Inside `filar-core`:

| Module | Role |
| --- | --- |
| `project` | The saved project model (`.filar` files are this, as JSON). |
| `mandrel` | Meridian `r(z)` as a piecewise-linear profile. |
| `path` | Fibre paths: prescribed-angle bodies, geodesics, hoop, friction turnarounds. |
| `pattern` | Closed-pattern enumeration and selection. |
| `kinematics` | Machine pose for a touch-down point (free-fibre lead and wrap). |
| `plan` | Ties it together: timed blocks of samples, thickness, checks. |
| `analysis` | Laminate stiffness, ply stresses and reserve factors per station. |
| `gcode` | Post-processor. |
| `machine` | Machine profiles and presets. |
| `api` | JSON facade shared by the desktop shell, WebAssembly and CLI. |

## How the planner works

A fibre path on a surface of revolution is described by its winding angle α to
the meridian. With arc length `s`, local half-angle γ and slip tendency λ (the
friction coefficient the fibre needs to stay put):

```text
dz/ds = cos α · cos γ      dφ/ds = sin α / r
dα/ds = λ · kₙ − sin γ · sin α / r         kₙ = sin²α · cos γ / r
```

λ = 0 is a geodesic and gives Clairaut's relation `r·sin α = const`. A path is
stable while |λ| ≤ μ. Bodies follow a prescribed angle law and report the λ
they need; turnarounds integrate with λ = μ until the fibre runs hoop-wise.
The exit from a turn is the mirror image of the entry, so a circuit is built
from one integrated half.

One circuit turns the mandrel through Φ. For `n` circuits to tile the
circumference and close, Φ mod 360° must equal `360°·k/n` with `k` coprime to
`n`. Filar reaches a legal Φ by adding hoop dwell at the ends, so the winding
angle is never bent to fit. The pattern number is the smallest `p` with
`k·p ≡ ±1 (mod n)`: the number of diamonds around the circumference.

The delivery eye is found by following the path tangent from the touch-down
point until it meets the eye's radius. That gives the carriage lead, the
spindle angle and the eye rotation for 2-, 3- and 4-axis machines.

## Machine presets

| Preset | Axes | Feed |
| --- | --- | --- |
| Generic 4/3/2-axis (grblHAL) | X carriage, A spindle, Y cross-feed, B eye | G93 inverse time |
| LinuxCNC 4-axis | X, A, Y, B | G93 inverse time |
| Marlin 2.1, rotary A/B (FiberPath-style) | X, A, B | G94, F on the linear axes |
| Marlin, rotary on Y/Z (Cyclone-style) | X, Y spindle, Z eye | G94, F across all axes |

These follow published conventions; none has been run on hardware yet.

## Known limits

- **Not yet proven on a machine.** Dry-run a new profile with no fibre and
  check directions, limits and speeds before winding.
- **No X-Winder output.** X-Winder's Executor is not a general G-code
  controller (it redefines G2/G3 as turnaround moves and takes feed in units
  per second), so it needs its own post-processor, tested on a real machine.
- Wind time comes from axis speed limits and ignores acceleration, so real
  runs take longer, mostly at the turnarounds.
- Each layer is planned on the bare mandrel; the thickness of earlier layers
  is not added to the radius.
- Profile corners (taper to run-out) are treated as sharp creases.
- The strength estimate is membrane-only laminate theory with a single
  knock-down factor. It does not model fibre crimp at crossovers, voids, end
  fittings, shell buckling, impact or fatigue, and it has not been checked
  against test parts. First failure is often resin cracking, which is not
  the same as rupture.
- Wireframes for the Analyse workspace also show a log of test results
  against predictions (`docs/wireframes/`); that part is not built yet.
- Round material is planned on the same paths as a flat band of equal
  width. Strands are assumed to sit side by side and to cross without
  nesting or flattening, they are wound dry, and they get no strength
  estimate. Built-in rope and wire weights are typical figures, not data for
  a specific product.
- Display units do not reach the G-code: for an inch-based controller, set
  the axis scale and header in the machine profile. Axis read-outs in
  Simulate are in machine units. The command-line tool reports in metric.

## Licence

Filar is free software, released under the GNU General Public License,
version 3. See [LICENSE](LICENSE). It comes with no warranty: check any
program it writes before running it on a machine.
