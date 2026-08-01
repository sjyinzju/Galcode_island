export interface ExclusiveLock {
  current: boolean;
}

export async function runExclusive(
  lock: ExclusiveLock,
  operation: () => Promise<void>,
): Promise<void> {
  if (lock.current) return;
  lock.current = true;
  try {
    await operation();
  } finally {
    lock.current = false;
  }
}
