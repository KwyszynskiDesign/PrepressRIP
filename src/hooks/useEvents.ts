import { useState, useEffect } from 'react';
import { collection, query, orderBy, onSnapshot, doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { slugify } from '../utils/slugify';

export interface Event {
  id: string;
  name: string;
  slug: string;
  eventDate: string | null;
  createdAt: number;
  guestUrl: string;
  storagePrefix: string;
  archived: boolean;
  quotaBytes: number;
}

const DEFAULT_EVENT_QUOTA_GB = Number(import.meta.env.VITE_DEFAULT_EVENT_QUOTA_GB) || 2;
export const DEFAULT_EVENT_QUOTA_BYTES = DEFAULT_EVENT_QUOTA_GB * 1024 * 1024 * 1024;

export function useEvents() {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = query(collection(db, 'events'), orderBy('createdAt', 'desc'));
    return onSnapshot(
      q,
      snap => {
        setError(null);
        setEvents(snap.docs.map(d => ({ id: d.id, ...d.data() } as Event)));
        setLoading(false);
      },
      err => {
        console.error('Nie udało się wczytać listy wydarzeń:', err);
        setError('Nie udało się wczytać listy wydarzeń. Odśwież stronę.');
        setLoading(false);
      }
    );
  }, []);

  return { events, loading, error };
}

// undefined = ładowanie, null = wydarzenie nie istnieje (usunięte / błędny link / błąd odczytu)
export function useEvent(slug: string | undefined) {
  const [event, setEvent] = useState<Event | null | undefined>(undefined);

  useEffect(() => {
    if (!slug) {
      setEvent(null);
      return;
    }
    let cancelled = false;
    setEvent(undefined);
    getDoc(doc(db, 'events', slug))
      .then(snap => {
        if (cancelled) return;
        setEvent(snap.exists() ? ({ id: snap.id, ...snap.data() } as Event) : null);
      })
      .catch(err => {
        console.error('Nie udało się wczytać wydarzenia:', err);
        if (!cancelled) setEvent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return event;
}

export class SlugTakenError extends Error {}

// Jeden admin, tworzenie wydarzeń jest rzadkie — sprawdzenie kolizji przed zapisem
// (bez transakcji) jest wystarczająco bezpieczne przy braku równoczesnych zapisów.
export async function createEvent(name: string, eventDate: string | null): Promise<Event> {
  const trimmedName = name.trim();
  const baseSlug = slugify(trimmedName);

  let slug = baseSlug;
  let attempt = 1;
  while ((await getDoc(doc(db, 'events', slug))).exists()) {
    attempt += 1;
    if (attempt > 50) throw new SlugTakenError('Nie udało się wygenerować unikalnego adresu wydarzenia.');
    slug = `${baseSlug}-${attempt}`;
  }

  const event: Event = {
    id: slug,
    name: trimmedName,
    slug,
    eventDate,
    createdAt: Date.now(),
    guestUrl: `${window.location.origin}/e/${slug}`,
    storagePrefix: `events/${slug}`,
    archived: false,
    quotaBytes: DEFAULT_EVENT_QUOTA_BYTES,
  };

  await setDoc(doc(db, 'events', slug), event);
  return event;
}
