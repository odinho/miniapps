# Agent Guidelines

## Architecture

```
src/build.js          # Entry point - orchestrates fetch → parse → cache
src/fetch/drive.js    # Document listing via gdrive CLI + cache cleanup
src/fetch/docs.js     # Google Docs HTML export
src/fetch/images.js   # Image download + Sharp thumbnails
src/parse/dates.js    # Norwegian date parsing (tested)
src/parse/parser.js   # HTML → JSON conversion
```

Data flows: Google Docs → `cache/docs/` → `cache/parsed/` → 11ty → `_site/`

## Key Files

- `config.json` - Document IDs and names
- `eleventy.config.js` - 11ty setup, filters, passthrough copies
- `site/_data/posts.js` - Loads parsed JSON for templates
- `tests/parse.test.js` - Date parsing tests

## Making Changes

**Adding date formats:** Update `src/parse/dates.js`, add tests in `tests/parse.test.js`, run `npm test`.

**Changing templates:** Edit `site/*.njk` and `site/_includes/*.njk`. Use `{{ content | safe }}` for HTML content.

**Styling:** Edit `site/css/style.css`. Keep it simple, mobile-friendly.

**Adding documents:** Update `config.json`, run `npm run build`.

## Testing

```bash
npm test              # Run once
npm test -- --watch   # Watch mode
```

Always run tests after modifying `src/parse/`.

## Common Pitfalls

- Date regex: 2-digit years need `(?!\d)` lookahead to avoid partial matches
- Image URLs from Google Docs are temporary - always download and cache
- Nunjucks `safe` filter is built-in, don't override it
- The `build.js` file is globally gitignored, needs `git add -f`

## Code Style

- **Be concise**: Prefer short, clear functions over long implementations
- **Be concise**: Don't document what the code already says
- **Be concise**: Keep commit messages short and clear

## Language

UI and comments are in Norwegian (Nynorsk). Keep it consistent.
