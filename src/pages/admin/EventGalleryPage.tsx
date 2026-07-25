import { useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { deleteDoc, doc } from 'firebase/firestore';
import { deleteObject, ref } from 'firebase/storage';
import { Archive, ArrowLeft, LogOut, QrCode, RefreshCw } from 'lucide-react';
import JSZip from 'jszip';
import { auth, db, storage } from '../../lib/firebase';
import { usePhotos, type Photo } from '../../hooks/usePhotos';
import { useEvent } from '../../hooks/useEvents';
import { ANONYMOUS_FILTER, Lightbox, PhotoTile, formatSize, sortPhotos, type SortOrder } from './GalleryShared';
import { QrModal } from './QrModal';
import { EventStorageBar } from './EventStorageBar';

const ZIP_SIZE_WARNING_BYTES = 1.5 * 1024 * 1024 * 1024;

export function EventGalleryPage() {
  const { slug = '' } = useParams<{ slug: string }>();
  const event = useEvent(slug);
  const { photos, loading, error: photosError } = usePhotos(slug);

  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [typeFilter, setTypeFilter] = useState<'all' | 'image' | 'video'>('all');
  const [authorFilter, setAuthorFilter] = useState('all');
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');
  const [zipState, setZipState] = useState<'idle' | 'zipping' | 'error'>('idle');
  const [zipProgress, setZipProgress] = useState({ done: 0, total: 0 });
  const [zipMessage, setZipMessage] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);

  function openPhoto(photo: Photo, trigger: HTMLElement) {
    triggerRef.current = trigger;
    setSelectedPhoto(photo);
  }

  async function handleDelete(photo: Photo) {
    const ok = window.confirm('Usunąć to zdjęcie/film z albumu? Tej operacji nie można cofnąć.');
    if (!ok) return;

    try {
      await deleteDoc(doc(db, 'photos', photo.id));
    } catch (err) {
      console.error('Firestore delete failed:', err);
      window.alert('Nie udało się usunąć pliku. Spróbuj ponownie.');
      return;
    }

    try {
      await deleteObject(ref(storage, photo.storagePath));
    } catch (err) {
      console.error('Storage delete failed (plik może zostać osierocony w Storage):', err);
    }
  }

  function closeLightbox() {
    setSelectedPhoto(null);
    triggerRef.current?.focus();
    triggerRef.current = null;
  }

  async function handleDownloadZip(photosToZip: Photo[], totalBytes: number) {
    if (photosToZip.length === 0) return;

    if (totalBytes > ZIP_SIZE_WARNING_BYTES) {
      const proceed = window.confirm(
        `Łączny rozmiar to ok. ${formatSize(totalBytes)} — pakowanie może być wolne albo zawiesić przeglądarkę. Kontynuować?`
      );
      if (!proceed) return;
    }

    setZipState('zipping');
    setZipMessage(null);
    setZipProgress({ done: 0, total: photosToZip.length });

    const zip = new JSZip();
    let failed = 0;

    for (const photo of photosToZip) {
      try {
        const response = await fetch(photo.url);
        const blob = await response.blob();
        const filename = photo.storagePath.split('/').pop() || photo.id;
        zip.file(filename, blob);
      } catch {
        failed += 1;
      }
      setZipProgress(prev => ({ ...prev, done: prev.done + 1 }));
    }

    try {
      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = `album-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      setZipState('idle');
      setZipMessage(
        failed > 0
          ? `Spakowano ${photosToZip.length - failed} z ${photosToZip.length} plików — ${failed} nie udało się pobrać.`
          : null
      );
    } catch {
      setZipState('error');
      setZipMessage('Nie udało się spakować plików. Spróbuj ponownie lub pobierz je pojedynczo.');
    }
  }

  const authors = Array.from(new Set(photos.map(p => p.author).filter((a): a is string => !!a))).sort(
    (a, b) => a.localeCompare(b, 'pl')
  );
  const hasAnonymous = photos.some(p => !p.author);

  const filteredPhotos = photos.filter(p => {
    if (typeFilter !== 'all' && p.type !== typeFilter) return false;
    if (authorFilter === 'all') return true;
    if (authorFilter === ANONYMOUS_FILTER) return !p.author;
    return p.author === authorFilter;
  });
  const visiblePhotos = sortPhotos(filteredPhotos, sortOrder);
  const imageCount = filteredPhotos.filter(p => p.type === 'image').length;
  const videoCount = filteredPhotos.filter(p => p.type === 'video').length;
  const totalSize = filteredPhotos.reduce((sum, p) => sum + (p.size ?? 0), 0);

  if (event === null) {
    return (
      <div className="min-h-dvh bg-canvas flex flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-ink-700 text-sm">Nie znaleziono wydarzenia.</p>
        <Link to="/admin" className="text-accent-600 text-sm underline">
          Wróć do listy wydarzeń
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-canvas">
      <header className="bg-surface border-b border-ink-300 px-4 sm:px-6 py-4 flex items-center justify-between gap-4 flex-wrap sticky top-0 z-10">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            to="/admin"
            aria-label="Wróć do listy wydarzeń"
            className="p-1.5 -ml-1.5 rounded-lg text-ink-500 hover:text-ink-900 hover:bg-canvas transition-colors shrink-0"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          </Link>
          <h1 className="font-semibold text-ink-900 truncate">
            {event ? event.name : 'Wydarzenie'}
            <span className="ml-2 text-sm font-normal text-ink-500">{photos.length} plików</span>
          </h1>
        </div>

        <div className="flex items-center gap-4 shrink-0">
          <div>
            <button
              onClick={() => setQrOpen(true)}
              disabled={!event}
              className="flex items-center gap-1.5 py-1.5 px-3 rounded-lg border border-ink-300 text-xs text-ink-700 hover:bg-canvas disabled:opacity-50 transition-colors"
            >
              <QrCode className="w-3.5 h-3.5" aria-hidden="true" />
              Generuj QR
            </button>
            <p className="text-[11px] text-ink-500 mt-1">Kod dla gości do dodawania zdjęć</p>
          </div>
          <button
            onClick={() => signOut(auth)}
            aria-label="Wyloguj się"
            className="flex items-center gap-1.5 text-sm text-ink-500 hover:text-ink-900 transition-colors"
          >
            <LogOut className="w-4 h-4" aria-hidden="true" />
            Wyloguj
          </button>
        </div>
      </header>

      {photos.length > 0 && (
        <div className="bg-surface border-b border-ink-300 px-4 py-3 flex flex-wrap gap-2">
          <select
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value as 'all' | 'image' | 'video')}
            aria-label="Filtruj po typie pliku"
            className="py-2 px-3 rounded-lg border border-ink-300 text-sm text-ink-700 bg-surface"
          >
            <option value="all">Wszystkie typy</option>
            <option value="image">Tylko zdjęcia</option>
            <option value="video">Tylko wideo</option>
          </select>

          <select
            value={authorFilter}
            onChange={e => setAuthorFilter(e.target.value)}
            aria-label="Filtruj po autorze"
            className="py-2 px-3 rounded-lg border border-ink-300 text-sm text-ink-700 bg-surface"
          >
            <option value="all">Wszyscy autorzy</option>
            {authors.map(a => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
            {hasAnonymous && <option value={ANONYMOUS_FILTER}>Anonimowo</option>}
          </select>

          <select
            value={sortOrder}
            onChange={e => setSortOrder(e.target.value as SortOrder)}
            aria-label="Sortuj galerię"
            className="py-2 px-3 rounded-lg border border-ink-300 text-sm text-ink-700 bg-surface"
          >
            <option value="newest">Najnowsze najpierw</option>
            <option value="oldest">Najstarsze najpierw</option>
            <option value="author">Autor (A-Z)</option>
          </select>
        </div>
      )}

      <main className="p-4">
        {event && <EventStorageBar event={event} />}

        {photos.length > 0 && !loading && (
          <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
            <p className="text-xs text-ink-500">
              {imageCount} zdjęć · {videoCount} filmów · {filteredPhotos.length} plików łącznie · {formatSize(totalSize)}
            </p>
            <button
              onClick={() => handleDownloadZip(filteredPhotos, totalSize)}
              disabled={zipState === 'zipping' || filteredPhotos.length === 0}
              className="flex items-center gap-1.5 py-1.5 px-3 rounded-lg border border-ink-300 text-xs text-ink-700 hover:bg-canvas disabled:opacity-50 transition-colors"
            >
              <Archive className="w-3.5 h-3.5" aria-hidden="true" />
              {zipState === 'zipping'
                ? `Pakowanie ${zipProgress.done}/${zipProgress.total}...`
                : 'Pobierz wszystko (ZIP)'}
            </button>
          </div>
        )}

        {photosError && (
          <p className="text-error-600 text-sm mb-3" role="alert">
            {photosError}
          </p>
        )}

        {zipMessage && (
          <p
            className={`text-xs mb-3 ${zipState === 'error' ? 'text-error-600' : 'text-ink-500'}`}
            role="alert"
            aria-live="polite"
          >
            {zipMessage}
          </p>
        )}

        {loading ? (
          <div className="flex justify-center items-center py-24" role="status" aria-label="Ładowanie zdjęć">
            <RefreshCw className="w-6 h-6 text-ink-300 animate-spin" aria-hidden="true" />
          </div>
        ) : photos.length === 0 ? (
          <div className="text-center py-24 text-ink-500 text-sm">
            Brak zdjęć. Poczekaj aż goście zaczną wysyłać!
          </div>
        ) : visiblePhotos.length === 0 ? (
          <div className="text-center py-24 text-ink-500 text-sm">Brak wyników dla wybranego filtra.</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
            {visiblePhotos.map(photo => (
              <PhotoTile key={photo.id} photo={photo} onOpen={openPhoto} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </main>

      {selectedPhoto && <Lightbox photo={selectedPhoto} onClose={closeLightbox} />}
      {qrOpen && event && <QrModal event={event} onClose={() => setQrOpen(false)} />}
    </div>
  );
}
