# Brand assets

| File | What it is | Used by |
|------|------------|---------|
| `worklens-logo.png` | Full lockup — mark + "WorkLens" + tagline, transparent background | Login page header |
| `worklens-mark.svg` | The square mark, scalable | Favicon (browsers that take SVG) |
| `worklens-mark.png` | The square mark, 512×512 | Sidebar, employee header, PWA / home-screen icon |
| `favicon-96x96.png` | The mark at tab size | Favicon |
| `apple-touch-icon.png` | The mark at 180×180 | iOS home screen |
| `../../app/favicon.ico` | The mark as .ico | Older browsers that ask for /favicon.ico by name |

Replacing a file is the whole job — nothing in the code names a size.

The favicon set came from RealFaviconGenerator, which is why there are several
of them: browsers choose badly when handed a single image, and iOS crops and
rounds its own, so it gets a file sized for that rather than a 512px one
scaled down.
