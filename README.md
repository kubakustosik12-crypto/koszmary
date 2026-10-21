# 5 Koszmarów Szymona Ignaczaka — co-op (do 3 osób)

Gra + mały serwer, który łączy graczy w pokoje. Grać można dalej solo — co-op jest opcjonalny.

## Wrzucenie na Render (za darmo, ~10 min)

1. **GitHub** → zaloguj się → **New repository** (np. `koszmary`) → *Public* → **Create**.
2. Kliknij **uploading an existing file** i przeciągnij **zawartość tego folderu**:
   `server.js`, `package.json`, `render.yaml`, `.gitignore`, `README.md` i folder `public` (w nim `index.html`).
   Na dole **Commit changes**.
3. **render.com** → *Sign in with GitHub* → **New +** → **Web Service** → wybierz repo `koszmary`.
4. Ustawienia (zwykle wpiszą się same z `render.yaml`):
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Instance Type: **Free**
5. **Create Web Service** → po 2–3 min dostaniesz adres typu `https://koszmary-xxxx.onrender.com`.

Ten adres wysyłasz kumplom. Gra otwiera się w przeglądarce (komputer i telefon).

## Jak grać razem

1. Każdy wybiera swoją postać (Ignaczak / Pracownik / Luźny) na ekranie startowym.
2. Jedna osoba: **🌐 Multiplayer → Załóż pokój** → dostaje 4-literowy kod (widać go też w lewym górnym rogu).
3. Reszta: **🌐 Multiplayer → wpisz kod → Dołącz**.
4. W grze: **T** = czat, przycisk **🌐** = pokój / wyjście.

Zasady drużyny:
- **Lider** (kto założył pokój) prowadzi drużynę między mapami i lochami. Jak ktoś inny wejdzie w przejście, lider dostaje pytanie „Idziemy?”.
- **XP wspólne** — każdy dostaje doświadczenie za każde zabicie.
- **Łup osobny** — każdy ma swoje monety, skrzynki i przedmioty.
- Każdy gra **swoim zapisem** (zapis jest w przeglądarce gracza).
- Jak lider wyjdzie, liderem zostaje następna osoba. Jak padnie połączenie, grasz dalej solo.

## Ważne

- Darmowy Render **usypia serwer po ~15 min bez graczy**. Pierwsze wejście może trwać do ~1 minuty — to normalne.
- Aktualizacja gry: podmień `public/index.html` na GitHubie — Render sam wdroży nową wersję.
- Test na swoim komputerze: zainstaluj Node.js, w tym folderze `npm install`, potem `node server.js` i wejdź na `http://localhost:3000`.
