# Løffeblogg

Genererer ein statisk reiseblogg frå Google Docs.

## Oppsett

```bash
npm install
npm run setup:gdrive   # Last ned gdrive CLI (valfritt)
gdrive account add     # Autentiser mot Google (valfritt)
```

Med gdrive vert dokument automatisk oppdaga frå Drive-mappa.
Utan gdrive må du liste dokument manuelt i `config.json`.

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

`config.json` inneheld mappe-ID og (valfritt) manuelle dokument:

```json
{
  "folderId": "GOOGLE_DRIVE_FOLDER_ID",
  "documents": []
}
```

- `folderId`: Henta frå Drive-URL (`drive.google.com/drive/folders/DENNE_ID`)
- `documents`: Valfri liste dersom du ikkje brukar gdrive

Dokumenta må vera delt offentleg ("Alle med lenkja").
Dokument med namn som startar med "Kopi av " vert ignorert.

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

### Systemd-timer

For automatisk oppdatering kvart 30. minutt:

```bash
./systemd/install.sh
```

Dette installerer ein brukar-timer som køyrer `scripts/auto-update.sh`.
Sjå status med `systemctl --user status loffeblogg.timer`.

## Mappestruktur

```
cache/          # Nedlasta dokument og bilete (gitignorert)
scripts/        # Hjelpeskript (cron-oppdatering)
site/           # 11ty malar og stil
src/            # Hentings- og parsingskript
_site/          # Generert nettstad (gitignorert)
```
