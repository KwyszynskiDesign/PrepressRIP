import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../lib/firebase';

// usage/{slug} to osobny dokument od events/{slug} — aktualizowany przy każdym uploadzie/
// usunięciu przez Cloud Functions (functions/src/index.ts), więc nie chcemy, żeby jego częste
// zapisy triggerowały onSnapshot na liście wszystkich wydarzeń (useEvents).
//
// Dopóki żaden plik nie wpadł/nie zniknął dla danego eventu, dokument usage/{slug} może
// w ogóle nie istnieć — to nie błąd, tylko brak zdarzeń do tej pory. Traktujemy to jako
// usedBytes = 0, nie jako stan błędu.
export function useEventUsage(slug: string | undefined) {
  const [usedBytes, setUsedBytes] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) {
      setUsedBytes(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    return onSnapshot(
      doc(db, 'usage', slug),
      snap => {
        setError(null);
        setUsedBytes(snap.exists() ? Number(snap.data().usedBytes) || 0 : 0);
        setLoading(false);
      },
      err => {
        console.error('Nie udało się wczytać zużycia miejsca dla wydarzenia:', err);
        setError('Nie udało się wczytać zużycia miejsca.');
        setLoading(false);
      }
    );
  }, [slug]);

  return { usedBytes, loading, error };
}
