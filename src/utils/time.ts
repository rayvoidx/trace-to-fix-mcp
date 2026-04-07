export function nowISO(): string {
  return new Date().toISOString();
}

export function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

export function parseISO(iso: string): Date {
  return new Date(iso);
}

export function durationMs(start: string, end: string): number {
  return parseISO(end).getTime() - parseISO(start).getTime();
}
