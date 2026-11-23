const flights = new Map();

export async function runHistoryRequestOnce(key, task) {
  if (flights.has(key)) return flights.get(key);
  const pending = Promise.resolve().then(task);
  flights.set(key, pending);
  try {
    return await pending;
  } finally {
    if (flights.get(key) === pending) flights.delete(key);
  }
}
