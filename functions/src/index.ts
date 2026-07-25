import { initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { onObjectDeleted, onObjectFinalized } from 'firebase-functions/v2/storage';
import { logger } from 'firebase-functions';

initializeApp();
const db = getFirestore();

const BUCKET = 'photoevent-8b105.firebasestorage.app';
// Region bucketa potwierdzony przez ownera w Google Cloud Console: US-EAST1.
const REGION = 'us-east1';

// Klasyfikacja po prefiksie contentType — ta sama reguła musi być używana w
// scripts/backfill-usage.ts, inaczej liczniki live i backfillowane się rozjadą.
type MediaKind = 'image' | 'video' | null;
function classifyContentType(contentType: string | undefined): MediaKind {
  if (!contentType) return null;
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  return null;
}

// Ścieżki obiektów, którymi zajmuje się quota MVP, mają zawsze postać
// events/{slug}/{fileName} — to wynika z tego, jak createEvent() ustawia storagePrefix
// (src/hooks/useEvents.ts) i jak GuestCamera do niego uploaduje. Wszystko inne (w tym
// legacy prefiks photos/...) jest tu świadomie ignorowane — legacy event jest blokowany
// na nowe uploady (archived), więc nie powinien już generować nowych obiektów.
function parseEventSlug(objectName: string | undefined): string | null {
  if (!objectName) return null;
  const parts = objectName.split('/');
  if (parts.length < 2 || parts[0] !== 'events') return null;
  const slug = parts[1];
  return slug ? slug : null;
}

// Czysta księgowość: ta funkcja nigdy nie czyta quotaBytes ani nie podejmuje decyzji
// o blokadzie — to robi klient (GuestCamera) na podstawie usage/{slug} + events/{slug}.quotaBytes.
export const onEventFileFinalize = onObjectFinalized({ bucket: BUCKET, region: REGION }, async event => {
  const slug = parseEventSlug(event.data.name);
  if (!slug) return;

  const size = Number(event.data.size) || 0;
  if (size <= 0) return;

  const kind = classifyContentType(event.data.contentType);
  const update: Record<string, FieldValue> = {
    usedBytes: FieldValue.increment(size),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (kind === 'image') update.imageCount = FieldValue.increment(1);
  if (kind === 'video') update.videoCount = FieldValue.increment(1);

  await db.doc(`usage/${slug}`).set(update, { merge: true });
});

export const onEventFileDelete = onObjectDeleted({ bucket: BUCKET, region: REGION }, async event => {
  const slug = parseEventSlug(event.data.name);
  if (!slug) return;

  const size = Number(event.data.size) || 0;
  if (size <= 0) return;

  const kind = classifyContentType(event.data.contentType);
  const ref = db.doc(`usage/${slug}`);
  try {
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const data = snap.data() ?? {};
      const currentBytes = Number(data.usedBytes) || 0;
      // Math.max(0, ...) to łatka na dryf (duplicate delivery / przegapione zdarzenia),
      // nie naprawa przyczyny — okresowe uzgadnianie świadomie poza scope tego etapu.
      const update: Record<string, FieldValue | number> = {
        usedBytes: Math.max(0, currentBytes - size),
        updatedAt: FieldValue.serverTimestamp(),
      };
      // Brak/nierozpoznany contentType przy delete: nie wiadomo który licznik typu
      // dekrementować, więc go nie ruszamy — akceptowany drobny dryf, naprawialny backfillem.
      if (kind === 'image') {
        update.imageCount = Math.max(0, (Number(data.imageCount) || 0) - 1);
      } else if (kind === 'video') {
        update.videoCount = Math.max(0, (Number(data.videoCount) || 0) - 1);
      }
      tx.set(ref, update, { merge: true });
    });
  } catch (err) {
    logger.error(`Nie udało się zdekrementować usage/${slug}:`, err);
  }
});
