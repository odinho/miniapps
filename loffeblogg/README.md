# Løffeblogg

Genererer ein statisk reiseblogg frå Google Docs.

## Oppsett

```bash
npm install
```

## Bruk

```bash
# Hent dokument og bygg nettstaden
npm run build

# Start utviklingsserver (http://localhost:8080)
npm run dev

# Berre hent dokument (utan å byggje)
npm run fetch

# Køyr testar
npm test
```

## Konfigurasjon

Rediger `config.json` for å leggje til nye dokument:

```json
{
  "documents": [
    {
      "id": "GOOGLE_DOC_ID",
      "name": "Dokumentnamn"
    }
  ]
}
```

Dokument-ID finn du i URL-en til dokumentet:
`https://docs.google.com/document/d/DENNE_ID_EN/edit`

Dokumenta må vera delt offentleg ("Alle med lenkja").

## Datoformat

Parseren kjenner att desse datformata i dokumenta:

- `1. januar 2026` eller `Bangkok 1. januar 2026`
- `01.01.2026` eller `01.01.26`
- `Laurdag 10.01.26`

Datoar i starten av korte avsnitt vert brukt til å dele dokumentet i dagseksjonar.

## Automatisk oppdatering

For å køyre på ein server med cron/systemd-timer, bruk `scripts/check-updates.sh`.
Krev [gdrive v3](https://github.com/glotlabs/gdrive/releases) med `gdrive account add`.

```bash
# Sjekk om dokument har endra seg
./scripts/check-updates.sh

# Sjekk også etter nye dokument i mappa
./scripts/check-updates.sh --check-new
```

## Mappestruktur

```
cache/          # Nedlasta dokument og bilete (gitignorert)
scripts/        # Hjelpeskript (cron-oppdatering)
site/           # 11ty malar og stil
src/            # Hentings- og parsingskript
_site/          # Generert nettstad (gitignorert)
```
