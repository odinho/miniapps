# Napper TODO — Roadmap to Feature Parity & Beyond

Inspirert av den originale Napper-appen. Prioritert i fasar.

---

## Fase 0: MVP ✅ (current)
- [x] Event-sourced backend med SQLite
- [x] Start/stopp søvn (nap/night auto-detect)
- [x] Sanntids-timer under pågåande søvn
- [x] Neste-lur-prediksjon basert på wake windows
- [x] Historikk med redigering og sletting
- [x] Offline-køing (localStorage)
- [x] PWA med service worker
- [x] Onboarding (legg til baby)
- [ ] **Deploy til napper.s0.no** ← pågår no

---

## Fase 1: Kjernefunksjonar som manglar
_Ting som gjer appen faktisk brukbar dag-til-dag._

### 1.1 Søvn-metadata
- [ ] **Start-tilstand:** Upset, lang tid å sovna, normal (valfri tag ved start/stopp)
- [ ] **Korleis ho sovna:** In bed, nursing, worn/held, next to me, bottle feeding, stroller, car
- [ ] Nye event-typar: `sleep.tagged` — {sleepId, mood?, method?}
- [ ] Bottom-sheet UI for tagging (etter stopp, eller rediger seinare)
- [ ] Lagra som del av sleep-payload eller eige event

### 1.2 Pause/resume
- [ ] `sleep.paused` event — {sleepId, pauseTime}
- [ ] `sleep.resumed` event — {sleepId, resumeTime}
- [ ] Pause-knapp i dashboard under aktiv søvn
- [ ] Vis pausar i historikk (total søvntid minus pausar)
- [ ] "Add pause" retroaktivt i redigeringsmodal

### 1.3 Manuell registrering
- [ ] Legg til tidlegare søvn manuelt (start + slutt)
- [ ] "+" knapp for rask manuell registrering
- [ ] Endra starttid på pågåande søvn ("ho sovna eigentleg 10 min sidan")

### 1.4 Betre tidshandtering
- [ ] Vis alle tider i brukarens lokale tidssone (ikkje UTC)
- [ ] Timezone-felt i brukarinnstillingar (auto-detect)
- [ ] Rett dato-gruppering i historikk (natt-søvn som startar 20:00 høyrer til "i dag")

---

## Fase 2: Visualisering
_Det som gjer appen visuelt nyttig og kjekk å bruka._

### 2.1 Dagsboge (12h-klokke med dag/natt-flip)
- [ ] Sirkulær 12-timars visualisering (IKKJE 24h)
- [ ] To moduser: **dag** (06–18) og **natt** (18–06)
- [ ] Flippar frå natt→dag ved "stå opp"-registrering, dag→natt ved "legg seg"
- [ ] Animert overgang mellom dag/natt-modus
- [ ] Boge rundt klokka der søvnperiodar er markerte
- [ ] Sol-ikon (sunrise) og måne-ikon (sunset) som ankerunkt
- [ ] Lurar som "bobler" langs bogen med start/slutt-tid
- [ ] Pågåande søvn animert (pulsering/glød)
- [ ] Canvas eller SVG-basert

### 2.2 Statistikk-side
- [ ] Dagleg oppsummering (total søvn, antal lurar, lengste lur)
- [ ] Vekeoversikt med søylediagram
- [ ] Gjennomsnittleg wake window
- [ ] Trend: søvn per dag siste 2-4 veker
- [ ] Samanlikning med aldersanbefalingar

### 2.3 Betre dashboard
- [ ] Anbefalt leggetid (kveld)
- [ ] "Schedule is optimized" / tips basert på alder
- [ ] Gårdagens natt-søvn synleg (total nattetimar)

---

## Fase 3: Mørk tema & design
_Frå "funksjonell" til "vakker"._

### 3.1 Mørkt tema (natt-modus)
- [ ] Mørk bakgrunn med stjerner (som originalen)
- [ ] Automatisk bytte basert på tid på døgnet
- [ ] Beholde det lyse pastelltemaet som standard dagtema

### 3.2 Animasjonar & polish
- [ ] Soft glow rundt måne-knappen under søvn
- [ ] Stjerne-twinkle animasjon (CSS)
- [ ] Smooth transitions mellom views
- [ ] Bottom-sheet modal (slide-up) for redigering ← allereie delvis
- [ ] Haptic feedback (vibration API) ved start/stopp

### 3.3 Ikon & branding
- [ ] App-ikon (for PWA homescreen)
- [ ] Splash screen
- [ ] Profilbilete av baby (valfritt)

---

## Fase 4: Smart funksjonalitet
_Det som gjer appen smartare enn ein enkel logg._

### 4.1 Notifikasjonar
- [ ] Push-varsling X minutt før predikert neste lur
- [ ] "Har ho vore vaken i Y min — tid for lur snart?"
- [ ] Service worker push eller Telegram-integrasjon
- [ ] Konfigurerbare varseltider

### 4.2 Lyd/kvitestøy
- [ ] Kvitestøy-spelar (brown noise, rain, shh)
- [ ] Timer for kvitestøy (auto-stopp etter X min)
- [ ] Volum-kontroll
- [ ] (Originalen har dette — "Music" tab)

### 4.3 Søvntransisjonar
- [ ] Automatisk deteksjon av lur-dropping (3→2, 2→1)
- [ ] Varsel: "Halldis ser ut til å droppa ein lur"
- [ ] Tilpassa wake windows basert på faktisk data (allereie delvis)

### 4.4 Fôring-sporing (stretch goal)
- [ ] Registrer amming/flaske/mat
- [ ] Sjå samanheng mellom fôring og søvn
- [ ] Eventtypes: `feeding.started`, `feeding.ended`

---

## Fase 5: Multi-brukar & sync
_For at både Odin og Helene kan bruka appen._

### 5.1 Enkel autentisering
- [ ] Pin-kode eller enkel passord-beskyttelse
- [ ] Eller: ingen auth, berre delt URL (trusted network)
- [ ] Client-ID allereie på plass for event-dedup

### 5.2 Sanntids-oppdatering
- [ ] SSE (Server-Sent Events) eller WebSocket for live sync
- [ ] Når Helene startar lur → Odin ser det med ein gong
- [ ] Vis kven som registrerte kva (clientId → namn)

### 5.3 Offline sync forbetring
- [ ] Conflict resolution UI ("Dobbel registrering oppdaga")
- [ ] Synkindikator i UI (grøn = synka, gul = køa)
- [ ] Last-write-wins med manuell dedup-knapp

---

## Fase 6: Data & eksport
- [ ] Eksporter til CSV
- [ ] Importer frå original Napper-app (viss mogleg)
- [ ] API for Klådi-integrasjon (eg kan henta data for morgonrapportar!)
- [ ] Backup/restore av eventlog

---

## Teknisk gjeld & infrastruktur
- [ ] TypeScript strict mode
- [ ] Testar (minst for engine/schedule.ts og events.ts)
- [ ] Rate limiting på API
- [ ] Gzip/brotli komprimering (nginx)
- [ ] Cache headers for statiske filer
- [ ] Healthcheck endpoint (/api/health)
- [ ] Automatisk deploy-script (rsync + restart)
- [ ] Logrotate for systemd-journal

---

## Prioritert rekkefølge for neste sprint

1. ✅ Deploy MVP til napper.s0.no
2. 🔜 Søvn-metadata (mood + method) — mest nyttig dagleg
3. 🔜 Manuell registrering (retroaktiv søvn)
4. 🔜 Pause/resume
5. Dagsboge-visualisering (24h-klokke)
6. Mørkt tema
7. Statistikk-side
8. SSE live sync (for Helene)
9. Notifikasjonar
