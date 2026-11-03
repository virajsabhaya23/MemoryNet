# Build and publish the website

The static website lives in `website/`; `index.html` describes MemoryNet and `guide.html` covers installation and usage. GitHub Pages serves these files only. It does not run the Node/PGlite application or connect to its database. See the [README](../README.md) for app setup and [SECURITY.md](../SECURITY.md) for supported deployment boundaries.

## Preview and check

Run from the repository root with Node.js 24 or newer:

```sh
npm run site:check
npm run site:build
npm run site:serve
```

Open [http://127.0.0.1:4173/MemoryNet/](http://127.0.0.1:4173/MemoryNet/) to preview the project path used by Pages. Stop with Ctrl+C and restart after edits; the preview reads the checked files at startup. These commands use Node built-ins and require no model key, installed dependencies, or database.

The build writes `website/` files and a generated `.nojekyll` file to ignored `.local/site/`. The checker validates local links and anchors, rejects project-breaking root-relative URLs, and refuses symlinks, unsupported file types, and hidden files. Local renderer metadata in `website/.hallmark/` is excluded.

Before publishing, check screenshot selection and image links, keyboard focus, mobile navigation, copy success/failure, and guide commands. Confirm content remains readable without JavaScript and controls respect reduced motion. Use project-relative asset links so the site works under `/MemoryNet/`. Preserve the included font and scaffold licenses; see [third-party notices](../THIRD_PARTY_NOTICES.md).

## Publish with GitHub Actions

The workflow in `.github/workflows/pages.yml` is manually triggered and restricted to `virajsabhaya23/MemoryNet`. For a fork, update that repository condition and any repository links to the intended destination.

1. Commit and push the reviewed source to the target repository.
2. In **Settings → Pages → Build and deployment → Source**, select **GitHub Actions**.
3. Run **Actions → Publish website (manual)**. Its build job runs `site:build` and uploads `.local/site/`; the deployment job publishes that artifact.
4. Open the Pages URL returned by the completed deployment and check navigation, screenshots, guide anchors, command copying, and assets under the project path.

Local checking and building do not deploy anything. The workflow has no push trigger; publishing requires its explicit manual run.
