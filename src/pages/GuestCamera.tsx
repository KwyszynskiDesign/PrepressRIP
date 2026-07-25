import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { collection, addDoc, doc, getDoc } from 'firebase/firestore';
import { Camera, Check, RefreshCw, RotateCcw } from 'lucide-react';
import heic2any from 'heic2any';
import { storage, db } from '../lib/firebase';
import { compressImage } from '../utils/compressImage';
import { useEvent, DEFAULT_EVENT_QUOTA_BYTES } from '../hooks/useEvents';
import { useEventUsage } from '../hooks/useEventUsage';

type UploadState = 'idle' | 'converting' | 'preview' | 'uploading' | 'success' | 'error';
type ErrorKind = 'network' | 'storage-full' | 'generic';

const MAX_IMAGE_SIZE = 25 * 1024 * 1024;
const MAX_VIDEO_SIZE = 200 * 1024 * 1024;

function isHeicFile(f: File) {
  return f.type === 'image/heic' || f.type === 'image/heif' || /\.(heic|heif)$/i.test(f.name);
}

async function convertHeicToJpeg(f: File): Promise<File> {
  const result = await heic2any({ blob: f, toType: 'image/jpeg', quality: 0.9 });
  const blob = Array.isArray(result) ? result[0] : result;
  const name = f.name.replace(/\.(heic|heif)$/i, '.jpg') || 'photo.jpg';
  return new File([blob], name, { type: 'image/jpeg' });
}

export function GuestCamera() {
  const { slug } = useParams<{ slug: string }>();
  const event = useEvent(slug);
  const { usedBytes, loading: usageLoading } = useEventUsage(slug);

  if (event === undefined || (event && usageLoading)) {
    return (
      <div className="min-h-dvh bg-canvas flex items-center justify-center" role="status" aria-label="Ładowanie">
        <RefreshCw className="w-6 h-6 text-ink-300 animate-spin" aria-hidden="true" />
      </div>
    );
  }

  if (event === null) {
    return (
      <div className="min-h-dvh bg-canvas flex flex-col items-center justify-center p-8 text-center gap-2">
        <p className="text-ink-900 text-lg font-medium">Nie znaleziono wydarzenia</p>
        <p className="text-ink-500 text-sm">Sprawdź link od organizatora — mógł się zmienić.</p>
      </div>
    );
  }

  if (event.archived) {
    return (
      <div className="min-h-dvh bg-canvas flex flex-col items-center justify-center p-8 text-center gap-2">
        <p className="text-ink-900 text-lg font-medium">Wydarzenie zostało zamknięte</p>
        <p className="text-ink-500 text-sm">
          Organizator nie przyjmuje już nowych zdjęć ani filmów dla tego wydarzenia.
        </p>
      </div>
    );
  }

  const quotaBytes = event.quotaBytes ?? DEFAULT_EVENT_QUOTA_BYTES;

  return (
    <UploadFlow
      eventId={event.id}
      eventName={event.name}
      eventDate={event.eventDate}
      storagePrefix={event.storagePrefix}
      quotaBytes={quotaBytes}
      initialOverQuota={usedBytes >= quotaBytes}
    />
  );
}

function UploadFlow({
  eventId,
  eventName,
  eventDate,
  storagePrefix,
  quotaBytes,
  initialOverQuota,
}: {
  eventId: string;
  eventName: string;
  eventDate: string | null;
  storagePrefix: string;
  quotaBytes: number;
  initialOverQuota: boolean;
}) {
  const [state, setState] = useState<UploadState>(initialOverQuota ? 'error' : 'idle');
  const [preview, setPreview] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [author, setAuthor] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [errorKind, setErrorKind] = useState<ErrorKind>(initialOverQuota ? 'storage-full' : 'generic');

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.files?.[0];
    if (!raw) return;
    if (preview) URL.revokeObjectURL(preview);
    setValidationError(null);
    setPreviewFailed(false);

    let f = raw;
    if (isHeicFile(raw)) {
      setState('converting');
      try {
        f = await convertHeicToJpeg(raw);
      } catch (err) {
        // Konwersja się nie udała (np. Live Photo / nietypowy podtyp HEIC) — wysyłamy oryginał
        // zamiast blokować gościa; podgląd może nie działać, upload i tak przejdzie.
        console.error('HEIC conversion failed, falling back to original file:', err);
        f = raw;
      }
    }

    const isVideo = f.type.startsWith('video/');
    if (isVideo && f.size > MAX_VIDEO_SIZE) {
      setValidationError('Film jest za duży (max 200 MB)');
    } else if (!isVideo && f.size > MAX_IMAGE_SIZE) {
      setValidationError('Zdjęcie jest za duże (max 25 MB)');
    } else {
      setValidationError(null);
    }

    setFile(f);
    setPreview(URL.createObjectURL(f));
    setState('preview');
  }

  async function handleUpload() {
    if (!file) return;

    // Re-check tuż przed uploadem, nie tylko przy wejściu na stronę — zawęża (nie zamyka
    // całkowicie) okno, w którym quota zostaje przekroczona w trakcie sesji gościa.
    // Fail open: nieudany odczyt (np. gość chwilowo offline) nie blokuje uploadu — decyzja
    // ownera, żeby nie karać gościa za przejściowy problem sieciowy.
    try {
      const usageSnap = await getDoc(doc(db, 'usage', eventId));
      const used = usageSnap.exists() ? Number(usageSnap.data().usedBytes) || 0 : 0;
      if (used >= quotaBytes) {
        setErrorKind('storage-full');
        setState('error');
        return;
      }
    } catch (err) {
      console.error('Re-check quota przed uploadem nie powiódł się (fail open, upload kontynuowany):', err);
    }

    setState('uploading');
    try {
      const isVideo = file.type.startsWith('video/');
      const stillHeic = !isVideo && isHeicFile(file);
      // Nieskonwertowany HEIC: canvas (compressImage) i tak go nie odczyta — wysyłamy bajty 1:1.
      const blob: Blob = isVideo || stillHeic ? file : await compressImage(file);
      const ext = isVideo
        ? file.name.split('.').pop()?.toLowerCase() || 'mp4'
        : stillHeic
          ? file.name.split('.').pop()?.toLowerCase() || 'heic'
          : 'jpg';
      const contentType = isVideo ? file.type : stillHeic ? file.type || 'image/heic' : 'image/jpeg';
      const path = `${storagePrefix}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, blob, { contentType });
      const url = await getDownloadURL(storageRef);
      await addDoc(collection(db, 'photos'), {
        url,
        storagePath: path,
        type: isVideo ? 'video' : 'image',
        author: anonymous ? null : author.trim() || null,
        size: blob.size,
        uploadedAt: Date.now(),
        eventId,
      });
      if (preview) URL.revokeObjectURL(preview);
      setPreview(null);
      setFile(null);
      setState('success');
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      if (code === 'storage/quota-exceeded') {
        setErrorKind('storage-full');
      } else if (!navigator.onLine || code === 'storage/retry-limit-exceeded' || code === 'unavailable') {
        setErrorKind('network');
      } else {
        setErrorKind('generic');
      }
      setState('error');
    }
  }

  function reset() {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setFile(null);
    setValidationError(null);
    setPreviewFailed(false);
    setState('idle');
  }

  if (state === 'success') {
    return (
      <div className="min-h-dvh bg-canvas flex flex-col items-center justify-center p-8 text-center">
        <div className="w-20 h-20 rounded-full bg-success-100 flex items-center justify-center mb-6">
          <Check className="w-10 h-10 text-success-600" aria-hidden="true" />
        </div>
        <h2 className="text-3xl font-light text-ink-900 mb-2">Dziękujemy!</h2>
        <p className="text-ink-700 text-sm mb-10">Plik trafił do albumu</p>
        <button
          onClick={reset}
          className="py-3 px-10 bg-accent-600 text-white rounded-full text-sm tracking-widest uppercase"
        >
          Wyślij kolejne
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-canvas flex flex-col items-center justify-center p-6">
      <div className="text-center mb-12">
        {eventDate && (
          <p className="text-accent-600 text-xs tracking-widest uppercase mb-2">{eventDate}</p>
        )}
        <h1 className="text-ink-900 text-4xl font-light tracking-wide">{eventName}</h1>
        <div className="w-10 h-px bg-accent-600 mx-auto mt-4" />
      </div>

      {state === 'idle' && (
        <label htmlFor="camera-input" className="cursor-pointer flex flex-col items-center gap-5 select-none">
          <div className="w-28 h-28 rounded-full bg-accent-600 flex items-center justify-center shadow-2xl active:scale-95 transition-transform duration-150">
            <Camera className="w-12 h-12 text-white" aria-hidden="true" />
          </div>
          <span className="text-ink-700 text-sm tracking-wide">Dotknij, aby dodać zdjęcie lub film</span>
          <input
            id="camera-input"
            type="file"
            accept="image/*,video/*"
            capture="environment"
            className="hidden"
            onChange={handleFileChange}
          />
        </label>
      )}

      {state === 'idle' && (
        <p className="text-xs text-ink-500 text-center max-w-xs mt-4">
          Wysyłając zdjęcie lub film, zgadzasz się na jego udostępnienie w albumie wydarzenia.
        </p>
      )}

      {state === 'idle' && (
        <p className="text-xs text-ink-500 text-center max-w-xs mt-2">
          Jeśli robisz zdjęcie z telefonu, wyłącz tryb Live Photo (żółte kółko w aparacie) — inaczej podgląd może nie zadziałać.
        </p>
      )}

      {state === 'converting' && (
        <div className="flex flex-col items-center gap-4" role="status" aria-live="polite">
          <div className="w-12 h-12 border-2 border-accent-600 border-t-transparent rounded-full animate-spin" aria-hidden="true" />
          <p className="text-ink-700 text-sm">Przetwarzanie zdjęcia...</p>
        </div>
      )}

      {state === 'preview' && preview && file && (
        <div className="w-full max-w-xs flex flex-col gap-4">
          {file.type.startsWith('video/') ? (
            <video
              src={preview}
              controls
              className="w-full rounded-2xl shadow-lg object-cover max-h-[60dvh]"
            />
          ) : previewFailed ? (
            <div className="w-full rounded-2xl bg-ink-300/40 flex flex-col items-center justify-center gap-2 py-16 px-4 text-center">
              <Camera className="w-8 h-8 text-ink-500" aria-hidden="true" />
              <p className="text-ink-700 text-sm">
                Podgląd niedostępny dla tego formatu — plik i tak zostanie wysłany.
              </p>
            </div>
          ) : (
            <img
              src={preview}
              alt="Podgląd"
              className="w-full rounded-2xl shadow-lg object-cover max-h-[60dvh]"
              onError={() => setPreviewFailed(true)}
            />
          )}

          {validationError ? (
            <div className="flex flex-col gap-3 text-center" role="alert" aria-live="polite">
              <p className="text-error-600 text-sm">{validationError}</p>
              <button
                onClick={reset}
                className="w-full py-3 border border-ink-300 text-ink-900 rounded-full text-sm flex items-center justify-center gap-2"
              >
                <RotateCcw className="w-4 h-4" aria-hidden="true" />
                Wybierz inny plik
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-ink-700 text-sm text-center">Załadowano — możesz wysłać</p>

              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-ink-700">Wyślij anonimowo</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={anonymous}
                  aria-label="Wyślij anonimowo"
                  onClick={() => setAnonymous(v => !v)}
                  className="relative w-11 h-11 shrink-0 flex items-center justify-center"
                >
                  <span
                    aria-hidden="true"
                    className={`relative w-11 h-6 rounded-full transition-colors ${
                      anonymous ? 'bg-accent-600' : 'bg-ink-300'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${
                        anonymous ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </span>
                </button>
              </div>

              {!anonymous && (
                <div>
                  <label htmlFor="author-input" className="sr-only">
                    Twoje imię (opcjonalnie)
                  </label>
                  <input
                    id="author-input"
                    type="text"
                    value={author}
                    onChange={e => setAuthor(e.target.value)}
                    placeholder="Twoje imię (opcjonalnie)"
                    maxLength={40}
                    className="w-full py-3 px-4 rounded-xl border border-ink-300 text-sm text-ink-900 placeholder:text-ink-500 focus:outline-none focus:border-accent-600 focus:ring-2 focus:ring-accent-100"
                  />
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={reset}
                  className="flex-1 py-3 border border-ink-300 text-ink-900 rounded-full text-sm flex items-center justify-center gap-2"
                >
                  <RotateCcw className="w-4 h-4" aria-hidden="true" />
                  Zmień
                </button>
                <button
                  onClick={handleUpload}
                  className="flex-1 py-3 bg-accent-600 text-white rounded-full text-sm font-medium"
                >
                  Wyślij
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {state === 'uploading' && (
        <div className="flex flex-col items-center gap-4" role="status" aria-live="polite">
          <div className="w-12 h-12 border-2 border-accent-600 border-t-transparent rounded-full animate-spin" aria-hidden="true" />
          <p className="text-ink-700 text-sm">Wysyłam...</p>
        </div>
      )}

      {state === 'error' && errorKind === 'network' && (
        <div className="flex flex-col items-center gap-4 text-center max-w-xs" role="alert" aria-live="polite">
          <p className="text-error-600 text-sm">Brak połączenia z internetem. Sprawdź sieć i spróbuj ponownie.</p>
          <button
            onClick={handleUpload}
            className="py-3 px-8 bg-accent-600 text-white rounded-full text-sm"
          >
            Spróbuj ponownie
          </button>
        </div>
      )}

      {state === 'error' && errorKind === 'storage-full' && (
        <div className="flex flex-col items-center gap-4 text-center max-w-xs" role="alert" aria-live="polite">
          <p className="text-error-600 text-sm">
            Brak miejsca na przechowywanie plików. Poinformuj organizatora — na razie nie da się wysłać nowych zdjęć ani filmów.
          </p>
          <button
            onClick={reset}
            className="py-3 px-8 border border-ink-300 text-ink-900 rounded-full text-sm"
          >
            Wróć
          </button>
        </div>
      )}

      {state === 'error' && errorKind === 'generic' && (
        <div className="flex flex-col items-center gap-4 text-center" role="alert" aria-live="polite">
          <p className="text-error-600 text-sm">Coś poszło nie tak. Spróbuj ponownie.</p>
          <button
            onClick={reset}
            className="py-3 px-8 bg-accent-600 text-white rounded-full text-sm"
          >
            Spróbuj ponownie
          </button>
        </div>
      )}
    </div>
  );
}
