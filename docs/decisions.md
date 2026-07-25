# Decision log — Photothinker MVP

## Cel dokumentu

- Ten dokument łączy wcześniejsze decyzje, które nadal obowiązują, z najnowszymi decyzjami ownera.
- Decyzje historyczne, które zostały później odwrócone, nie są tu traktowane jako aktywny stan produktu.
- Celem jest jedno źródło prawdy dla scope’u, dostępu, UX, rollout’u i infrastruktury.

## 1. Model produktu

- Aplikacja działa w modelu multi-event: wiele wydarzeń pod jedną aplikacją.
- Główny backend pozostaje oparty o Firebase Storage + Firestore.
- Google Drive wchodzi teraz jako osobny eksperyment techniczny.
- Eksperyment z Google Drive nie oznacza jeszcze pełnej migracji architektury ani porzucenia Firebase.
- Produkt nie wchodzi jeszcze w pełny multi-tenant, wiele niezależnych workspace’ów ani pełny model wielu organizatorów.
- Event nadal nie ma rozbudowanej maszyny stanów; nie budujemy osobnego lifecycle management UI.

## 2. Zakres funkcjonalny

- Upload zdjęć zostaje w zakresie.
- Upload wideo zostaje w zakresie.
- Kompresja client-side zostaje dla zdjęć i wideo, z fallbackiem na oryginał, jeśli kompresja wideo zawiedzie.
- HEIC jest konwertowany client-side do JPEG.
- MOV pozostaje bez konwersji.
- Lightbox organizatora zostaje w wariancie MVP-lite: podgląd, podstawowe metadane i zamknięcie, bez akcji destrukcyjnych i bez next/prev.
- Admin ma możliwość pobrania ZIP-a ze wszystkimi plikami wydarzenia.
- Admin może usuwać pliki z galerii wydarzenia.
- Galeria admina odświeża się automatycznie w czasie rzeczywistym; nie dodajemy osobnego przycisku ręcznego odświeżania.
- QR w aplikacji zostaje w zakresie.
- Plansze A4 i A5 do druku zostają w zakresie.
- Pasek dostępnego miejsca zostaje w zakresie jako funkcja informacyjna dla admina.
- Pasek quota nie blokuje uploadu.
- Licznik zdjęć i filmów per event wchodzi do bieżącego scope’u.
- Consent zostaje w wariancie minimalnym: mikrotekst przy CTA, bez checkboxa.
- Limity plików pozostają ustawione na 25 MB dla zdjęć i 200 MB dla wideo, z zastrzeżeniem dalszej weryfikacji względem planu.
- Styl wizualny pozostaje w kierunku Editorial Warmth.

## 3. Dostęp i bezpieczeństwo

- Dotychczasowy model jednego allowlist e-maila był poprawnym zabezpieczeniem wcześniejszego etapu i pozostaje ważnym punktem wyjścia.
- Na obecnym etapie chcemy rozszerzyć ten model o możliwość rejestracji i testowego dopuszczenia przynajmniej jednej dodatkowej osoby.
- Ten krok służy walidacji flow konta i dostępu, a nie wdrożeniu pełnego systemu ról i organizacji.
- Nadal nie wdrażamy jeszcze pełnego systemu ról, wielu niezależnych organizatorów ani workspace’ów.

## 4. Rollout i jakość

- Backfill historycznych zdjęć jest potrzebny.
- Oznacza to, że stare pliki muszą zostać poprawnie przypisane do wydarzeń w nowym modelu danych, aby galerie, liczniki i widoki eventowe działały spójnie także dla wcześniejszych uploadów.
- Polskie znaki w PDF muszą zostać poprawione.
- Brak polskich znaków nie jest już traktowany jako akceptowalne, świadomie odłożone ograniczenie.
- Artifact Registry cleanup policy trzeba wdrożyć jako housekeeping po testach funkcji.

## 5. Decyzje aktywne z wcześniejszych ustaleń

- Firebase pozostaje aktualnym, działającym fundamentem produktu.
- Multi-event pozostaje aktywnym kierunkiem produktu.
- ZIP dla admina pozostaje w scope.
- Usuwanie plików przez admina pozostaje w scope.
- QR w aplikacji oraz plansze A4/A5 pozostają w scope.
- Pasek dostępnego miejsca pozostaje funkcją informacyjną.
- Auto-refresh galerii admina pozostaje aktywnym zachowaniem systemu.
- Minimalny consent, limity plików, HEIC→JPEG, MOV bez konwersji i lightbox MVP-lite pozostają obowiązującymi decyzjami.

## 6. Decyzje zastąpione lub rozszerzone

- Wcześniejszy model single-event został zastąpiony przez multi-event.
- Wcześniejsza decyzja o QR poza aplikacją została zastąpiona przez QR generowany w aplikacji.
- Wcześniejsze odłożenie Google Drive do v2 zostało rozszerzone: teraz wchodzi jako eksperyment techniczny.
- Wcześniejszy model jednego admina przez jeden allowlist e-mail został rozszerzony o test rejestracji i dostępu dla przynajmniej jednej dodatkowej osoby.
- Wcześniejsze świadome odłożenie problemu polskich znaków w PDF zostało cofnięte: temat przechodzi do naprawy.
- Wcześniejsze podejście bez licznika zdjęć i filmów zostaje rozszerzone: licznik wchodzi teraz do scope’u.

## 7. Poza obecnym zakresem

- Pełny multi-tenant.
- Rozbudowany system ról i uprawnień.
- Wiele niezależnych workspace’ów.
- Płatności.
- Pełna migracja architektury na Google Drive jako jedyny docelowy storage bez osobnej decyzji po eksperymencie.

## 8. Log techniczny — Krok 0: quota per event (2026-07)

- Projekt przeszedł na plan Blaze; Cloud Functions wdrożone w regionie `us-east1` (region bucketa Storage potwierdzony ręcznie przez ownera w Google Cloud Console).
- Model danych: `events/{slug}` dostało pole `quotaBytes` (domyślnie 2 GB, sterowane `VITE_DEFAULT_EVENT_QUOTA_GB`, ustawiane przy tworzeniu eventu). Osobna kolekcja `usage/{slug}` (nie pole na evencie — żeby częste zapisy przy każdym uploadzie nie triggerowały niepotrzebnie listy wszystkich eventów) niesie `usedBytes`, `imageCount`, `videoCount`.
- Dwie funkcje Storage-triggered (`functions/src/index.ts`): `onEventFileFinalize` i `onEventFileDelete`. Liczą wyłącznie obiekty pod wzorcem `events/{slug}/{fileName}` — inne ścieżki, w tym legacy prefiks `photos/...`, są strukturalnie ignorowane. Klasyfikacja zdjęcie/wideo po prefiksie `contentType`; brak/nieznany `contentType` przy usunięciu pliku nie rusza liczników typu (akceptowany drobny dryf zamiast błędnej dekrementacji).
- Funkcje są czystą księgowością — nigdy nie czytają `quotaBytes` i nie podejmują decyzji o blokadzie. Blokadę robi klient: `GuestCamera` sprawdza `archived` i `usedBytes >= quotaBytes` przy wejściu na stronę oraz ponownie (świeży odczyt) tuż przed samym uploadem — nieudany re-check nie blokuje uploadu (fail open), żeby nie karać gościa za przejściowy problem sieciowy.
- Legacy event (`ania-marek`, pilot sprzed pivotu na multi-event) zablokowany na nowe uploady przez pole `archived: true` — pole istniało od dawna na `Event`, ale nigdzie nie było odczytywane; teraz dostało realne znaczenie zamiast wprowadzania nowego pola.
- Zweryfikowane manualnie na jednorazowym evencie testowym: upload zdjęcia, upload wideo, usunięcie pliku, negative test na `photos/` — wszystkie wyniki zgodne co do bajta z oczekiwaniami.
- Backfill (`scripts/backfill-usage.ts`) dla eventów z plikami sprzed wdrożenia funkcji jest zaprojektowany (ta sama reguła klasyfikacji co w funkcji, zapis bezwzględny `set` z realnego listingu Storage, nie increment), ale **jeszcze nie uruchomiony** — czeka na poświadczenia Admin SDK (sesja OAuth `firebase` CLI i Application Default Credentials używane przez `firebase-admin` to dwa różne mechanizmy).
- Przy okazji odkryte i zalogowane osobno (nie część quota MVP, nie blokują go): eksport QR/PDF w części przeglądarek (desktop i iOS Safari) nie daje bezpośredniego pobrania pliku zamiast tego otwiera systemowy ekran udostępniania; brak przycisku kopiowania linku w modalu QR; pobieranie pojedynczego pliku w galerii admina nie działa dla zasobów cross-origin.
