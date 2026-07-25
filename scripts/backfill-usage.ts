// Jednorazowy skrypt administracyjny — NIE część deployowanej aplikacji ani Cloud Functions.
// Uruchamiany lokalnie (np. `npm run backfill-usage`) przez osobę wykonującą migrację,
// WYŁĄCZNIE w oknie bez aktywnego live eventu (decyzja ownera — patrz rozmowa o Etapie 2a).
//
// Co robi:
// 1. Dla każdego dokumentu w `events` listuje realne obiekty Storage pod events/{slug}/
//    (świadomie NIE pod polem storagePrefix z dokumentu — dla wydarzenia-legacy to pole
//    wskazuje na events/{legacy-slug}, ale jego prawdziwe pliki nadal leżą pod photos/...,
//    więc listing po storagePrefix dałby fałszywe 0 z niewłaściwego powodu; listing po
//    stałej konwencji events/{slug}/ daje poprawne 0 dla legacy z właściwego powodu —
//    tam po prostu nic nie ma, bo nowe uploady są zablokowane przez archived).
// 2. Sumuje rozmiary i zapisuje WARTOŚĆ BEZWZGLĘDNĄ (set, nie increment) do usage/{slug}.
//    Increment tutaj skumulowałby się z tym, co Cloud Function już mogła doliczyć —
//    set nadpisuje absolutną prawdą z listingu.
// 3. Stempluje domyślne quotaBytes na dokumentach eventów, które go jeszcze nie mają.
//
// Wymaga lokalnych poświadczeń Admin SDK (Application Default Credentials albo
// GOOGLE_APPLICATION_CREDENTIALS wskazujący na service account key z dostępem do
// projektu photoevent-8b105).

import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const PROJECT_ID = 'photoevent-8b105';
const BUCKET = 'photoevent-8b105.firebasestorage.app';
const DEFAULT_EVENT_QUOTA_BYTES = 2 * 1024 * 1024 * 1024; // musi być zgodne z VITE_DEFAULT_EVENT_QUOTA_GB w .env

initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID, storageBucket: BUCKET });
const db = getFirestore();
const bucket = getStorage().bucket();

async function sumBytesUnderPrefix(prefix: string): Promise<number> {
  const [files] = await bucket.getFiles({ prefix });
  return files.reduce((sum, file) => sum + Number(file.metadata.size ?? 0), 0);
}

async function main() {
  const eventsSnap = await db.collection('events').get();
  console.log(`Znaleziono ${eventsSnap.size} wydarzeń.`);

  for (const eventDoc of eventsSnap.docs) {
    const slug = eventDoc.id;
    const data = eventDoc.data();

    const usedBytes = await sumBytesUnderPrefix(`events/${slug}/`);

    await db.doc(`usage/${slug}`).set(
      { usedBytes, updatedAt: new Date() },
      { merge: false } // set bezwzględny — to jest jedyne źródło prawdy dla backfillu, nie merge z ewentualnym starym stanem
    );
    console.log(`usage/${slug}: usedBytes=${usedBytes}`);

    if (typeof data.quotaBytes !== 'number') {
      await eventDoc.ref.set({ quotaBytes: DEFAULT_EVENT_QUOTA_BYTES }, { merge: true });
      console.log(`events/${slug}: ustawiono domyślne quotaBytes=${DEFAULT_EVENT_QUOTA_BYTES}`);
    }
  }

  console.log('Backfill zakończony.');
}

main().catch(err => {
  console.error('Backfill nie powiódł się:', err);
  process.exitCode = 1;
});
