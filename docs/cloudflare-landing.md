# Public LIFELINE landing

Production: https://lifeline-mhacks.pages.dev/

Cloudflare Pages project: `lifeline-mhacks`, production branch `main`, direct upload.
Initial deployment: https://f88a3c6e.lifeline-mhacks.pages.dev/
Brand identity deployment: https://7dcc43b4.lifeline-mhacks.pages.dev/
Speaking/pacing deployment: https://fbcff270.lifeline-mhacks.pages.dev/

Brand page: https://lifeline-mhacks.pages.dev/brand

The supplied triad is used as the logo and favicon. `/brand` includes logo
applications, charcoal/ivory colors, activation gradient specifications, Aspekta
typography, five interactive identity motion states, the original board and a
downloadable asset kit. SVG marks wrap the original pixels as a luminance mask;
the supplied geometry is not redrawn. Browser PNG and ICO icons are exported
from the SVG. Refresh identity assets with `python3 scripts/prepare-brand-assets.py`
before rebuilding the public bundle. This exporter uses installed Playwright/Chrome.
Landing navigation and footer link to the brand page.

The published marketing page includes the scroll-owned story, revision 6 frame trims,
incident vision effect, revision 8 speaking frames with an expanded speech/request
scroll beat, coordination animation, signal charts and EHR
preview. All 520 desktop/mobile WebP frames, local fonts and their licenses,
the supplied logo and the EHR preview image are included in the current bundle.
The public page's care-workspace actions become “How it works” actions leading to
the product explanation; record links lead to the hospital-context section.
The connected dashboard and hardware services remain local.
The source landing used by the local demo retains its dashboard links.

Rebuild and publish from the repository root:

```sh
python3 scripts/build-cloudflare-landing.py
wrangler pages deploy output/cloudflare-landing --project-name lifeline-mhacks --branch main --commit-dirty=true
```

The builder stages an explicit static asset set, validates its complete file
allowlist, then replaces only `output/cloudflare-landing`. Stale files from an
earlier bundle are removed; a missing required asset preserves the previous
successful bundle. Symbolic links in managed build paths or source assets are
refused. It does not publish repository files, source videos, device bridges,
patient/incident state or credentials.
Build metadata is saved in `output/cloudflare-landing-build.json`.
The isolated packaging regressions run with `python3 scripts/cloudflare_landing_test.py`.
HTML, scripts, styles and the manifest revalidate; frame/font files have long
cache lifetimes. Increment the sequence manifest revision when rebuilding frames
so the browser's existing revision query invalidates older frame assets.

The deployment does not require a commit and does not change the current branch.
Cloudflare login was refreshed using account/user read scopes and Pages write scope.

The public URL was verified in Chrome at 1432×988 and 390×844. All frames/fonts
load without failed resource responses or page errors. Forward/reverse incident
focus, final-frame hold, static mode and reduced motion pass; neither viewport
overflows horizontally. Evidence: `output/ui-design/cloudflare-live-verification.json`
and `cloudflare-live-*-vision-*.png`. The published site is also open in Chrome.
