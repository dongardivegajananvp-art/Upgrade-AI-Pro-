// Deduplicate overlapping setup evaluations for the same selected underlying/contract.
// The first caller owns the work; concurrent callers share its exact result/promise.
export function createSingleFlight() {
  const pending = new Map();
  return {
    run(key, task) {
      const id = String(key || '').trim();
      if (!id) throw new Error('A non-empty single-flight key is required');
      if (pending.has(id)) return pending.get(id);
      const work = Promise.resolve().then(task);
      pending.set(id, work);
      return work.finally(() => {
        if (pending.get(id) === work) pending.delete(id);
      });
    },
    has(key) { return pending.has(String(key || '').trim()); },
    get size() { return pending.size; }
  };
}
