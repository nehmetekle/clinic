import { Loader2, AlertCircle } from "lucide-react";

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-400">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-20 text-center text-sm text-rose-500">
      <AlertCircle className="h-6 w-6" />
      <p>Something went wrong</p>
      <p className="text-xs text-slate-400">{message}</p>
    </div>
  );
}
