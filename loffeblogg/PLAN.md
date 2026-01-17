# Løffeblogg - Reiseblogg frå Google Drive

Ein automatisk blogg-generator som hentar reisedagbøker frå Google Drive og lagar ein fin, enkel nettstad.

## Oversikt

**Mål:** Henta Google Docs frå ei delt mappe, tolka innhaldet (med datoar i feit skrift), lasta ned bilete, og generera ein statisk nettstad med 11ty.

**Teknologi:**
- Node.js
- Google Drive/Docs API (offentleg delt mappe)
- 11ty (Eleventy) for statisk sidegenerering
- Sharp for biletprosessering
- Nunjucks for malar

**Mappestruktur:**
```
loffeblogg/
├── PLAN.md                 # Denne fila
├── package.json
├── .eleventy.js            # 11ty konfigurasjon
├── src/
│   ├── fetch/              # Google Drive henting
│   │   ├── drive.js        # Hent mappeliste
│   │   ├── docs.js         # Hent dokumentinnhald
│   │   └── images.js       # Hent og prosesser bilete
│   ├── parse/              # Dokumenttolking
│   │   ├── parser.js       # Hovudparser
│   │   └── dates.js        # Datotolking (norske format)
│   └── build.js            # Hovudskript som køyrer alt
├── cache/                  # Lokal cache (git-ignorert)
│   ├── meta/               # Mappemetadata
│   ├── docs/               # Rå dokumentinnhald
│   ├── images/             # Originale bilete
│   │   └── thumbs/         # Genererte miniatyrbilete
│   └── parsed/             # Tolka JSON-data
├── site/                   # 11ty kjeldekode
│   ├── _includes/          # Malar
│   │   ├── base.njk        # Hovudmal
│   │   ├── post.njk        # Blogginnleggsmal
│   │   └── day-section.njk # Dagseksjon
│   ├── _data/              # 11ty data
│   │   └── posts.js        # Les frå cache/parsed
│   ├── css/
│   │   └── style.css       # Enkel, rein stil
│   ├── index.njk           # Framside
│   └── posts.njk           # Blogginnlegg
├── _site/                  # Generert nettstad (git-ignorert)
└── tests/                  # Testar
    ├── parse.test.js       # Test for datotolking
    └── fixtures/           # Testdata
```

---

## Fase 1: Prosjektoppsett

### 1.1 Initialisering
- [ ] Opprett `package.json` med nødvendige avhengigheiter
- [ ] Sett opp `.gitignore` (cache/, _site/, node_modules/, .env)
- [ ] Opprett mappestruktur

### 1.2 Avhengigheiter
```json
{
  "dependencies": {
    "@11ty/eleventy": "^3.0.0",
    "googleapis": "^140.0.0",
    "sharp": "^0.33.0",
    "node-fetch": "^3.3.0",
    "cheerio": "^1.0.0"
  },
  "devDependencies": {
    "vitest": "^2.0.0"
  }
}
```

**Vurdering:** Sidan mappa er offentleg delt, kan me kanskje bruka direkte URL-ar i staden for full API-tilgang. Må undersøka kva som er enklast.

---

## Fase 2: Google Drive Integrasjon

### 2.1 Mappehenting
**Mål:** Henta liste over dokument i mappa.

**Offentleg mappe-URL:** `https://drive.google.com/drive/folders/1a6KGU3iFtzeQbzZAiEy5Ky5jJNRnf_FT`

**Tilnærming (enkel, utan API-nøkkel):**
1. Bruk Google Drive si innebygde HTML-side for offentlege mapper
2. Eller: Bruk Google Docs export-URL direkte viss me veit dokument-ID-ane

**Tilnærming (med API-nøkkel):**
1. Opprett API-nøkkel i Google Cloud Console
2. Bruk `googleapis` for å lista filer i mappa
3. Lagra metadata i `cache/meta/folder.json`

**Cache-strategi:**
- Lagra `lastChecked` timestamp
- Samanlikn `modifiedTime` for kvart dokument
- Berre oppdater endra dokument

**Fil:** `src/fetch/drive.js`
```javascript
// Eksporterer:
// - listDocuments(folderId) -> [{id, name, modifiedTime}, ...]
// - getCachedMeta() -> cached folder state
// - needsUpdate(docId) -> boolean
```

### 2.2 Dokumenthenting
**Mål:** Henta innhaldet i kvart Google Doc.

**Tilnærming (enkel):**
- Google Docs kan eksporterast via URL:
  `https://docs.google.com/document/d/{DOC_ID}/export?format=html`
- Dette gjev HTML med inline CSS og bilete-URL-ar

**Fil:** `src/fetch/docs.js`
```javascript
// Eksporterer:
// - fetchDocument(docId) -> HTML string
// - getCachedDocument(docId) -> cached HTML or null
// - cacheDocument(docId, html) -> void
```

**Cache:**
- Lagra som `cache/docs/{docId}.html`
- Lagra metadata i `cache/docs/{docId}.meta.json` (med modifiedTime)

---

## Fase 3: Bilethandtering

### 3.1 Bilethenting
**Mål:** Finna og lasta ned alle bilete frå dokumenta.

**Utfordring:** Bilete i Google Docs HTML har spesielle URL-ar som kan vera tidsbegrensa.

**Tilnærming:**
1. Parse HTML med Cheerio
2. Finn alle `<img>` tags
3. Last ned kvart bilete
4. Lagra med unik ID i `cache/images/`

**Fil:** `src/fetch/images.js`
```javascript
// Eksporterer:
// - extractImageUrls(html) -> [{url, id}, ...]
// - downloadImage(url, id) -> local path
// - generateThumbnail(imagePath) -> thumbnail path
```

### 3.2 Miniatyrbilete
**Mål:** Lag mindre versjonar for raskare lasting.

**Konfigurasjon:**
- Original: behald som den er
- Thumbnail: max 800px breidd, 80% kvalitet

**Verktøy:** Sharp

---

## Fase 4: Innhaldstolking

### 4.1 Datotolking
**Mål:** Finna datoar i feit skrift som markerer nye dagar.

**Observerte format:**
- `Bangkok 1. januar 2026` (stad + dato)
- `2. januar 2026` (berre dato)
- `09.01.2026 Chang Mai` (numerisk dato + stad)

**Regex-mønster:**
```javascript
// Format 1: "1. januar 2026" eller "1. januar"
/(\d{1,2})\.\s*(januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember)\s*(\d{4})?/i

// Format 2: "09.01.2026" (DD.MM.YYYY)
/(\d{1,2})\.(\d{1,2})\.(\d{4})/
```

**Fil:** `src/parse/dates.js`
```javascript
// Eksporterer:
// - parseNorwegianDate(text) -> Date or null
// - extractDateFromLine(line) -> {date, location, rawText}
```

### 4.2 Hovudparser
**Mål:** Konvertera HTML til strukturert JSON.

**Inndata:** Rå HTML frå Google Docs

**Utdata:**
```json
{
  "id": "doc-id",
  "title": "Thailand",
  "lastModified": "2026-01-15T10:00:00Z",
  "days": [
    {
      "date": "2026-01-01",
      "location": "Bangkok",
      "heading": "Bangkok 1. januar 2026",
      "content": "<p>Etter ein lang reise...</p>",
      "images": [
        {
          "original": "/images/abc123.jpg",
          "thumbnail": "/images/thumbs/abc123.jpg",
          "alt": ""
        }
      ]
    }
  ]
}
```

**Fil:** `src/parse/parser.js`
```javascript
// Eksporterer:
// - parseDocument(docId, html) -> structured JSON
// - splitIntoDays(html) -> [{heading, content}, ...]
```

**Strategi:**
1. Parse HTML med Cheerio
2. Finn alle element med feit skrift (`<b>`, `<strong>`, eller `font-weight: bold`)
3. Sjekk om teksten inneheld eit datamønster
4. Del dokumentet på desse punkta
5. For kvar seksjon: bevar HTML, oppdater bilete-URL-ar til lokale stiar

---

## Fase 5: 11ty Nettstad

### 5.1 11ty Konfigurasjon
**Fil:** `.eleventy.js`
```javascript
module.exports = function(eleventyConfig) {
  // Kopier statiske filer
  eleventyConfig.addPassthroughCopy("site/css");
  eleventyConfig.addPassthroughCopy("cache/images");

  // Nynorsk datofilter
  eleventyConfig.addFilter("dato", (date) => {
    // Formater som "1. januar 2026"
  });

  return {
    dir: {
      input: "site",
      output: "_site"
    }
  };
};
```

### 5.2 Datahandtering
**Fil:** `site/_data/posts.js`
```javascript
// Les alle JSON-filer frå cache/parsed/
// Returner sortert liste av blogginnlegg
```

### 5.3 Malar

**Hovudmal:** `site/_includes/base.njk`
- Enkel, rein HTML5
- Responsiv design
- God typografi for lesing

**Innleggsmal:** `site/_includes/post.njk`
- Vis tittel
- Liste av dagar med ankerlenkjer
- Innhald for kvar dag med bilete

**Stil:** `site/css/style.css`
- System fonts for fart
- Max-breidd for lesbarheit (65ch)
- Biletrammer/spacing
- Responsivt biletgalleri

### 5.4 Sider

**Framside:** `site/index.njk`
- Velkomen-tekst
- Liste av blogginnlegg (Thailand, osv.)

**Innlegg:** `site/posts.njk`
- Pagination for kvart dokument
- Viser alle dagar som seksjonar

---

## Fase 6: Hovudskript

### 6.1 Build-skript
**Fil:** `src/build.js`
```javascript
// 1. Hent mappeliste frå Google Drive
// 2. For kvart dokument:
//    a. Sjekk om cache er utdatert
//    b. Hent dokument viss nødvendig
//    c. Last ned nye bilete
//    d. Generer miniatyrbilete
//    e. Parse og lagra JSON
// 3. Køyr 11ty
```

### 6.2 NPM-skript
```json
{
  "scripts": {
    "fetch": "node src/build.js --fetch-only",
    "build": "node src/build.js && npx eleventy",
    "serve": "npx eleventy --serve",
    "dev": "node src/build.js && npx eleventy --serve",
    "test": "vitest"
  }
}
```

---

## Fase 7: Testing

### 7.1 Einingstestar
**Fil:** `tests/parse.test.js`
- Test datotolking med ulike format
- Test dagsoppdeling
- Test biletekstraksjon

**Testdata:** `tests/fixtures/`
- Eksempel-HTML som liknar Google Docs output

### 7.2 Integrasjonstestar
- Test heile pipeline med mock-data
- Verifiser at cache fungerer

---

## Implementeringsrekkjefølgje

1. **Setup** (Fase 1)
   - Opprett prosjektstruktur
   - Installer avhengigheiter

2. **Google Drive henting** (Fase 2)
   - Implementer enkel dokumenthenting
   - Test med eitt dokument

3. **Bilethandtering** (Fase 3)
   - Last ned bilete frå henta dokument
   - Generer miniatyrbilete

4. **Parsing** (Fase 4)
   - Implementer datotolking
   - Del dokument i dagar
   - Lag JSON-output

5. **11ty nettstad** (Fase 5)
   - Sett opp enkel side
   - Lag malar
   - Style

6. **Integrasjon** (Fase 6)
   - Kople alt saman i build-skript
   - Test heile flyten

7. **Testing og finjustering** (Fase 7)
   - Skriv testar
   - Fiks edge cases
   - Poler design

---

## Opne spørsmål / Avklaringar

1. **API vs direkte URL:** Testa først om direkte export-URL fungerer for offentlege dokument. Viss ikkje, sett opp API-nøkkel.

2. **Bilete-URL-ar:** Google Docs bilete kan ha tidsbegrensa URL-ar. Må testa om dei fungerer etter eksport.

3. **Stilhandtering:** Google Docs eksporterer mykje inline CSS. Må kanskje rensa dette for rein output.

4. **Framtidige dokument:** Systemet må handtera nye dokument automatisk når dei vert lagt til i mappa.

---

## Kommandoar for utvikling

```bash
# Installer avhengigheiter
npm install

# Hent data og bygg
npm run build

# Utviklingsmodus med live reload
npm run dev

# Køyr testar
npm test
```
