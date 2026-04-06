# Star Rating Philosophy

## Revised System (2026-04-06)

The old system used 1★ as "this photo was not deleted" during manual culling passes.
The new system reclaims 1★ to mean something positive.

### Scale

| Stars | Meaning | Approximate count (100k library) |
|-------|---------|----------------------------------|
| 0 / unrated | Processed but unremarkable. Safe to keep, no special value. | ~70k |
| 1★ | Good photo. Stands out from the group, worth noting. | ~15k |
| 2★ | Share-worthy. Would show to someone interested. | ~5k |
| 3★ | Best-of-trip/roll. Local standout. | ~1k |
| 4★ | Print-worthy. Great image + memory combined. Cross-library standout. | ~500 |
| 5★ | Best of the best. Portfolio/yearly highlight. | ~100 |

### Key Changes from Old System

1. **0★ is a valid processed state** — not "unreviewed", just "keep without distinction"
2. **1★ now means something** — the photo has notable quality, composition, or moment
3. **Existing 1★ ratings are ambiguous** — in folders where 80%+ photos have 1★+, the old 1★ meant "not deleted" and should be treated as 0★ equivalent. In folders where <80% are rated, 1★ likely meant the photo was genuinely selected.
4. **2★+ ratings are trustworthy** — these always represented deliberate positive selection
5. **Existing ratings are a soft floor for 2★+** — never auto-downgrade 2★ or higher
6. **Existing 1★ can be reconsidered** — the LLM may leave a previously-1★ photo at 0★ if it's unremarkable in context

### Migration Strategy

For the LLM ranking pass:
- If a folder/roll has ≥80% of photos rated 1★+, treat existing 1★ as "was not deleted" (equivalent to 0★ in new system)
- If a folder/roll has <80% rated, treat existing 1★ as genuine positive selection (soft floor)
- 2★+ ratings are always respected as a floor
- The LLM should independently judge and suggest stars based on the new scale
- User reviews and confirms before any ratings are written back

### What the LLM Should Consider

When suggesting stars:
- **0★**: technically fine but nothing special. Generic, redundant-ish, or purely functional.
- **1★**: "I'd pick this one out if scrolling through." Good moment, nice light, clear subject, or useful reference.
- **2★**: "I'd show this to someone." Genuinely good photo worth sharing.
- **3★**: "This is a highlight." Best of the session/trip. Would feature in a recap.
- **4★/5★**: Not assigned by LLM. Requires cross-library curation by user.
