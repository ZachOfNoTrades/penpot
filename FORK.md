# Fork: shape animations

Branch `feat/shape-animations` of `ZachOfNoTrades/penpot`, based on tag `2.17.2`.

Adds CSS animations to shapes. An animation is a keyframe preset plus timing, stored on the
shape and played in the workspace canvas, the viewer, exported SVG, and the inspect code
output.

## Data model

Optional shape attribute `:animation` (`app.common.types.shape.animation`):

| Key | Values | Default |
|---|---|---|
| `:type` | `:spin` `:pulse` `:blink` `:bounce` `:shake` `:fade-in` `:fade-out` `:scale-in` `:slide-up` `:slide-down` `:slide-left` `:slide-right` | `:spin` |
| `:duration` | milliseconds | `1000` |
| `:delay` | milliseconds | `0` |
| `:easing` | `:linear` `:ease` `:ease-in` `:ease-out` `:ease-in-out` | `:linear` for spin, `:ease-in-out` otherwise |
| `:direction` | `:normal` `:reverse` `:alternate` `:alternate-reverse` | `:normal` |
| `:iterations` | integer or `:infinite` | `:infinite` for looping presets, `1` for entrances/exits |
| `:hidden` | boolean | `false` |

The attribute syncs from main components to copies (touched group `:animation-group`) and is
included in copy/paste of properties.

Rotation and scale pivot on the center of the animated shape's geometry bounding box
(`transform-box: fill-box`). To spin a partial arc around its circle center, group it with a
transparent full circle.

## Surfaces

- **Design sidebar**: an Animation section on every shape type (preset, duration, delay,
  easing, repeat, direction, pause, remove).
- **Canvas and viewer**: the shape content is wrapped in a group carrying the CSS animation
  and a scoped `@keyframes` rule. Root boards containing an active animation render live
  instead of as a thumbnail.
- **Plugin API**: `shape.animation` (`ShapeAnimation` in `plugins/libs/plugin-types`), read and
  write; assign `null` to remove.

  ```js
  shape.animation = { type: 'spin', duration: 700, easing: 'linear', iterations: 'infinite' };
  ```

- **Inspect code (CSS)**: an `animation:` declaration per animated shape and the `@keyframes`
  rules of every preset in use.

## Compatibility

Only the frontend changes. The stock 2.17.2 backend, exporter and MCP images work unchanged:
the backend shape schema is an open map, so it stores `:animation` without knowing it. A stock
frontend ignores the attribute and renders the shape static, so returning to the stock image
loses no data.

The WebAssembly renderer (`render-wasm/v1`, off by default) does not play animations.

## Build

Push to any `feat/**` branch. Workflow `build-frontend-image-fork.yml` builds the bundle in
the upstream `penpotapp/devenv` image, packages it with `docker/images/Dockerfile.frontend`,
and uploads `penpot-frontend-fork.tar.gz` (a `docker save` tarball) as a run artifact. The
image tag is `penpot-frontend-fork:<git describe>`.

## Deploy

```sh
gh run download <run-id> -R ZachOfNoTrades/penpot -n penpot-frontend-fork
gunzip -c penpot-frontend-fork.tar.gz | docker load
```

Set the `penpot-frontend` image in the compose file to the loaded tag and run
`docker compose up -d penpot-frontend`. Roll back by restoring the `penpotapp/frontend` image.

## Rebase onto a new upstream release

```sh
git fetch https://github.com/penpot/penpot.git tag <version>
git rebase --onto <version> 2.17.2 feat/shape-animations
```
