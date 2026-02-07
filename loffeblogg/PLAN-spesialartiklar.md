# Plan: Handtering av spesialartiklar (utan dato)

## Problem
"Tankar på vegen" er ikkje eit reisemål — det er refleksjonar/essays.
Bør ikkje visast i footer-ruta som om det er ein stad dei reiser til.

## Løysing

### Deteksjon
Artiklar utan nokon datoar i `days[]` er "essays/artiklar", ikkje "destinasjonar".
Allereie mogleg å detektera: `post.days | selectattr("date") | first` returnerer null.

### Endringar

#### 1. `site/_data/posts.js` — legg til `isDestination` flagg
```javascript
// Etter parsing, legg til:
post.isDestination = post.days.some(d => d.date);
```

#### 2. Footer (`base.njk`) — filtrer berre destinasjonar i ruta
```njk
{% for p in posts | reverse %}
{% if p.isDestination %}  {# Berre destinasjonar i ruta #}
  ...route-stop...
{% endif %}
{% endfor %}
```

#### 3. Framsida (`index.njk`) — vis artiklar separat
**Destinasjonar** — same som no (kort med datoar, dagteljar)
**Artiklar** — eigen seksjon nederst med anna stil:
- Ingen datoar
- Ingen "X dagar"
- Meir som blog-innlegg enn reisekort
- Tittel som "Tankar frå reisa" eller liknande

### Design for artikkel-kort
```
┌─────────────────────────┐
│  📝                     │
│  Tankar på vegen        │
│  Refleksjonar undervegs │
│  Les meir →             │
└─────────────────────────┘
```
Enklare, meir tekstbasert. Kanskje med eit ikon (📝 eller ✍️).

## Filsystem-endringar
1. `site/_data/posts.js` — legg til `isDestination`
2. `site/_includes/base.njk` — filtrer footer-rute
3. `site/index.njk` — to seksjonar (destinasjonar + artiklar)
4. `site/css/style.css` — stil for artikkel-kort

## Testing
- `npm run build`
- Sjekk at footer berre viser: Thailand → Laos → ... → Australia
- Sjekk at "Tankar på vegen" viser i eigen seksjon på framsida
