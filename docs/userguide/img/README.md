# Screenshots

Pages show a screenshot through a placeholder; the build copies the file in.

```html
<figure class="ug-shot" data-shot="<slug>-<what>.png">
  <figcaption>What the picture shows.</figcaption>
</figure>
```

- The name is `<slug>-<what>.png` (or `.jpg`), lowercase letters, digits and `-`. The
  `<slug>` is the page's own slug (`ui`, `logs`, `collect`, ...). The build rejects a
  name without that prefix, so files from different pages never collide.
- Shots of the general pages live here in `docs/userguide/img/`. A module's shots live in
  `src/modules/<id>/guide/img/`.
- Every file in these folders is copied to the guide, except this README.

Taking a shot in the AIR client:

1. Set the client to 100% zoom.
2. Open the steward window on the screen to show.
3. Crop to the steward window only, with no desktop or client chrome.
4. Save as PNG.
