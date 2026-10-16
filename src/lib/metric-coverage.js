import { observe } from "./provider.js";

// Retain only finite requested metrics; a present token ID is not coverage.
export async function observeMetrics(request, ids, fields, arrayRows = false) {
  const result = await observe(request);
  if (result.value === null) return result;
  const missingFields = [];
  let usable = 0;
  const rows = ids.map((id) => {
    const raw = arrayRows
      ? (Array.isArray(result.value) ? result.value.find((r) => r?.id === id) : null)
      : result.value?.[id];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) missingFields.push(id);
    const row = { id };
    for (const field of fields) {
      const value = raw?.[field];
      row[field] = Number.isFinite(value) ? value : null;
      if (row[field] === null) missingFields.push(`${id}.${field}`);
      else usable++;
    }
    return row;
  });
  result.value = usable ? (arrayRows ? rows : Object.fromEntries(rows.map(({ id, ...row }) => [id, row]))) : null;
  Object.assign(result.health, {
    status: !usable ? "unavailable" : missingFields.length ? "partial" : "available",
    code: !usable ? "no_usable_metrics" : missingFields.length ? "incomplete_metrics" : null,
    missingFields,
  });
  return result;
}
