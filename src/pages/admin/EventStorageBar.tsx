import { useEventUsage } from '../../hooks/useEventUsage';
import { DEFAULT_EVENT_QUOTA_BYTES, type Event } from '../../hooks/useEvents';

// Poniżej ~100 MB pokazujemy MB zamiast GB do 1 miejsca po przecinku — ten sam powód co
// w globalnym StorageBar.tsx (małe zużycie zaokrąglałoby się do mylącego "0.0 GB").
function formatUsage(bytes: number) {
  const mb = bytes / (1024 * 1024);
  if (mb < 100) return `${mb.toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// Osobne od globalnego StorageBar (lista wydarzeń): tam liczona jest suma pola `size` ze
// WSZYSTKICH dokumentów `photos` (Firestore, ślepe na osierocone pliki w Storage). Tu liczy
// się usage/{slug}.usedBytes — prawda ze Storage, utrzymywana przez Cloud Functions
// (functions/src/index.ts). Te dwa liczniki świadomie się nie zsumują do tej samej wartości.
export function EventStorageBar({ event }: { event: Event }) {
  const { usedBytes, loading, error } = useEventUsage(event.slug);
  const quotaBytes = event.quotaBytes ?? DEFAULT_EVENT_QUOTA_BYTES;
  const quotaGb = quotaBytes / (1024 * 1024 * 1024);

  if (error) {
    return (
      <p className="text-xs text-error-600 mb-4" role="alert">
        {error}
      </p>
    );
  }

  const ratio = loading ? 0 : Math.min(usedBytes / quotaBytes, 1);
  const percent = Math.round(ratio * 100);
  const barColor = ratio >= 0.9 ? 'bg-error-600' : ratio >= 0.7 ? 'bg-warning-600' : 'bg-success-600';

  return (
    <div className="bg-surface rounded-2xl border border-ink-300 p-4 mb-4">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
        <p className="text-sm font-medium text-ink-900">Miejsce tego wydarzenia</p>
        <p className="text-xs text-ink-500">
          {loading ? 'Ładowanie…' : `${formatUsage(usedBytes)} z ${quotaGb.toFixed(1)} GB wykorzystane`}
        </p>
      </div>
      <div
        role="progressbar"
        aria-label="Wykorzystane miejsce tego wydarzenia"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="w-full h-2 rounded-full bg-ink-300 overflow-hidden"
      >
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
